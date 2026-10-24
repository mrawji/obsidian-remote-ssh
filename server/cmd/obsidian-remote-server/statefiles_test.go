//go:build unix

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// TestMain doubles as the daemon: a test that needs a real daemon
// process re-executes this test binary with daemonEnv set, and the
// arguments after "--" go to run().
const daemonEnv = "ORS_TEST_RUN_DAEMON"

func TestMain(m *testing.M) {
	if os.Getenv(daemonEnv) == "1" {
		args := os.Args[1:]
		for i, a := range args {
			if a == "--" {
				args = args[i+1:]
				break
			}
		}
		code, err := run(args)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
		}
		os.Exit(code)
	}
	os.Exit(m.Run())
}

// shortTempDir returns a temp dir short enough for a unix socket path
// (t.TempDir can exceed the 104-byte limit on macOS).
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ors")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func shortLockWait(t *testing.T) {
	t.Helper()
	old := lockWait
	lockWait = 100 * time.Millisecond
	t.Cleanup(func() { lockWait = old })
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func dialable(path string) bool {
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestClaimStateFiles_RemovesAStaleSocket(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	writeFile(t, socket, "left by a crashed run")

	s, err := claimStateFiles(socket, filepath.Join(dir, "token"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.release()
	if exists(socket) {
		t.Fatal("stale socket was not removed")
	}
}

func TestClaimStateFiles_RefusesWhileAnotherDaemonHoldsTheLock(t *testing.T) {
	shortLockWait(t)
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	first, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatal(err)
	}
	defer first.release()
	writeFile(t, socket, "first daemon's socket")
	writeFile(t, token, "first daemon's token")

	if _, err := claimStateFiles(socket, token); !errors.Is(err, errDaemonRunning) {
		t.Fatalf("second claim: got %v, want errDaemonRunning", err)
	}
	if got := readFile(t, socket); got != "first daemon's socket" {
		t.Errorf("socket = %q after a refused claim", got)
	}
	if got := readFile(t, token); got != "first daemon's token" {
		t.Errorf("token = %q after a refused claim", got)
	}
}

func TestClaimStateFiles_WaitsForADaemonThatIsShuttingDown(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	first, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(200*time.Millisecond, first.release)

	second, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatalf("claim after the first daemon released: %v", err)
	}
	second.release()
}

func TestRelease_RemovesTheFilesAndFreesTheLock(t *testing.T) {
	shortLockWait(t)
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	s, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, socket, "x")
	writeFile(t, token, "x")
	s.release()
	s.release() // a second call is a no-op

	if exists(socket) || exists(token) {
		t.Fatal("release left the socket or the token behind")
	}
	again, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatalf("lock still held after release: %v", err)
	}
	again.release()
}

// A second daemon on the same socket must refuse to start, and must not
// touch the first daemon's socket or token on the way out.
func TestRun_RefusesASocketAnotherDaemonOwns(t *testing.T) {
	shortLockWait(t)
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	first, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatal(err)
	}
	defer first.release()
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	writeFile(t, token, "first-daemon-token")
	t.Setenv("HOME", dir)

	code, err := run([]string{
		"--vault-root=" + t.TempDir(),
		"--socket=" + socket,
		"--token-file=" + token,
	})
	if code == 0 || !errors.Is(err, errDaemonRunning) {
		t.Fatalf("run = (%d, %v), want a non-zero code and errDaemonRunning", code, err)
	}
	if got := readFile(t, token); got != "first-daemon-token" {
		t.Fatalf("token = %q, want the first daemon's token untouched", got)
	}
	if !dialable(socket) {
		t.Fatal("the first daemon's socket was removed")
	}
}

// spawnDaemon starts the daemon in a child process without waiting for
// it to come up.
func spawnDaemon(t *testing.T, home, socket, token string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$", "--",
		"--vault-root="+t.TempDir(),
		"--socket="+socket,
		"--token-file="+token,
	)
	cmd.Env = append(os.Environ(), daemonEnv+"=1", "HOME="+home)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

// waitUp waits until a daemon has written its token and answers on its
// socket.
func waitUp(t *testing.T, socket, token string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !(exists(token) && dialable(socket)) {
		if time.Now().After(deadline) {
			t.Fatal("daemon did not come up within 10s")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitExit waits for the daemon to exit and returns its exit code.
func waitExit(t *testing.T, cmd *exec.Cmd) int {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		if err != nil {
			t.Fatalf("wait: %v", err)
		}
		return 0
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not exit within 10s")
		return -1
	}
}

func TestDaemon_ExitRemovesItsOwnFiles(t *testing.T) {
	shortLockWait(t)
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	d := spawnDaemon(t, dir, socket, token)
	waitUp(t, socket, token)
	if err := d.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := waitExit(t, d); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}

	if exists(socket) || exists(token) {
		t.Error("socket or token left behind after a clean exit")
	}
	s, err := claimStateFiles(socket, token)
	if err != nil {
		t.Fatalf("lock still held after the daemon exited: %v", err)
	}
	s.release()
}

// The redeploy race from #614. The deployer SIGTERMs the old daemon,
// removes its files and starts the new one at once, while the old one is
// still draining a connection. The new daemon must come up, and the old
// one's exit must leave the new socket and token alone.
func TestDaemon_RedeployWhileTheOldDaemonDrains(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	old := spawnDaemon(t, dir, socket, token)
	waitUp(t, socket, token)
	// A client that stays connected keeps the old daemon in Serve's drain.
	client, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	// What ServerDeployer.deploy does: pkill, rm -f, start the new daemon.
	if err := old.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(socket)
	_ = os.Remove(token)
	newer := spawnDaemon(t, dir, socket, token)
	waitUp(t, socket, token)
	newToken := readFile(t, token)
	if err := old.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("the old daemon exited before the new one came up (%v): the race was not reproduced", err)
	}

	_ = client.Close() // let the old daemon finish draining
	if code := waitExit(t, old); code != 0 {
		t.Fatalf("old daemon exit code %d, want 0", code)
	}

	if !dialable(socket) {
		t.Error("the old daemon's exit removed the new daemon's socket")
	}
	if !exists(token) || readFile(t, token) != newToken {
		t.Error("the old daemon's exit removed or changed the new daemon's token")
	}
	if newer.ProcessState != nil {
		t.Error("the new daemon exited")
	}
}

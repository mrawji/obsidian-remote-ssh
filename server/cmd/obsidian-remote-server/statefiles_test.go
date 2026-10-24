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

// listenAt binds a socket at path that, like the daemon's, is not
// unlinked when the listener closes.
func listenAt(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ul := l.(*net.UnixListener)
	ul.SetUnlinkOnClose(false)
	t.Cleanup(func() { _ = ul.Close() })
	return ul
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

func TestClaimSocketPath_Missing(t *testing.T) {
	path := filepath.Join(shortTempDir(t), "s.sock")
	if err := claimSocketPath(path); err != nil {
		t.Fatalf("claimSocketPath on a missing path: %v", err)
	}
}

func TestClaimSocketPath_StaleSocketIsRemoved(t *testing.T) {
	path := filepath.Join(shortTempDir(t), "s.sock")
	l := listenAt(t, path)
	_ = l.Close() // nothing answers any more, but the file stays

	if err := claimSocketPath(path); err != nil {
		t.Fatalf("claimSocketPath on a stale socket: %v", err)
	}
	if exists(path) {
		t.Fatal("stale socket was not removed")
	}
}

func TestClaimSocketPath_LiveSocketIsKept(t *testing.T) {
	path := filepath.Join(shortTempDir(t), "s.sock")
	listenAt(t, path)

	err := claimSocketPath(path)
	if !errors.Is(err, errDaemonRunning) {
		t.Fatalf("claimSocketPath on a live socket: got %v, want errDaemonRunning", err)
	}
	if !dialable(path) {
		t.Fatal("live socket was removed")
	}
}

func TestOwnedFile_RemovesItsOwnFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, err := ownFile(path)
	if err != nil {
		t.Fatal(err)
	}
	o.remove()
	if exists(path) {
		t.Fatal("own file was not removed")
	}
}

func TestOwnedFile_KeepsAReplacedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, err := ownFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Another daemon replaces it the way auth.WriteFile does: tmp + rename.
	tmp := filepath.Join(dir, "token.tmp")
	if err := os.WriteFile(tmp, []byte("theirs"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}

	o.remove()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("replaced file was removed: %v", err)
	}
	if string(got) != "theirs" {
		t.Fatalf("replaced file content = %q, want %q", got, "theirs")
	}
}

func TestOwnedFile_MissingIsNoop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, err := ownFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	o.remove() // must not panic or recreate anything
	if exists(path) {
		t.Fatal("remove recreated the file")
	}
	ownedFile{}.remove() // zero value is a no-op too
}

// A second daemon on the same socket must refuse to start, and must not
// overwrite the first daemon's token on the way out.
func TestRun_RefusesALiveSocketAndKeepsItsToken(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")
	listenAt(t, socket)
	if err := os.WriteFile(token, []byte("first-daemon-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)

	code, err := run([]string{
		"--vault-root=" + t.TempDir(),
		"--socket=" + socket,
		"--token-file=" + token,
	})
	if code == 0 || !errors.Is(err, errDaemonRunning) {
		t.Fatalf("run = (%d, %v), want a non-zero code and errDaemonRunning", code, err)
	}
	if got, _ := os.ReadFile(token); string(got) != "first-daemon-token" {
		t.Fatalf("token = %q, want the first daemon's token untouched", got)
	}
	if !dialable(socket) {
		t.Fatal("the first daemon's socket was removed")
	}
}

// startDaemon runs the daemon in a child process and waits until it has
// written its token and answers on its socket.
func startDaemon(t *testing.T, dir, socket, token string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$", "--",
		"--vault-root="+t.TempDir(),
		"--socket="+socket,
		"--token-file="+token,
	)
	cmd.Env = append(os.Environ(), daemonEnv+"=1", "HOME="+dir)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	deadline := time.Now().Add(10 * time.Second)
	for !(exists(token) && dialable(socket)) {
		if time.Now().After(deadline) {
			t.Fatal("daemon did not come up within 10s")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cmd
}

func stopDaemon(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not exit within 10s of SIGTERM")
	}
}

func TestDaemon_ExitRemovesItsOwnSocketAndToken(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	stopDaemon(t, startDaemon(t, dir, socket, token))

	if exists(socket) {
		t.Error("socket left behind after a clean exit")
	}
	if exists(token) {
		t.Error("token left behind after a clean exit")
	}
}

// The redeploy race from #614: while the old daemon is still shutting
// down, the deployer has already removed its files and a new daemon has
// taken the same paths. The old daemon's exit must leave them alone.
func TestDaemon_ExitKeepsFilesANewDaemonOwns(t *testing.T) {
	dir := shortTempDir(t)
	socket := filepath.Join(dir, "s.sock")
	token := filepath.Join(dir, "token")

	old := startDaemon(t, dir, socket, token)

	// What ServerDeployer.deploy does, then the new daemon's startup.
	if err := os.Remove(socket); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(token); err != nil {
		t.Fatal(err)
	}
	listenAt(t, socket)
	if err := os.WriteFile(token, []byte("new-daemon-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	stopDaemon(t, old)

	if !dialable(socket) {
		t.Error("the old daemon's exit removed the new daemon's socket")
	}
	if got, _ := os.ReadFile(token); string(got) != "new-daemon-token" {
		t.Errorf("token = %q, want the new daemon's token untouched", got)
	}
}

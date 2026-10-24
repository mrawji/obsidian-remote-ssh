package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The socket and token paths are not private to one daemon: a redeploy
// starts a new daemon on the same paths while the old one may still be
// draining connections, and two profiles can be configured with the same
// paths. So the daemon must never delete a file at either path that
// another daemon owns (#614).
//
// Ownership is decided by an exclusive lock on "<socket>.lock", held for
// the daemon's whole life. Whoever holds it owns both paths: it can clear
// what a crashed run left there at startup, and remove its own files at
// shutdown, without having to tell whose files they are. Looking at the
// files themselves cannot decide that: filesystems such as ext4 hand a
// deleted file's inode number straight to the next file created, and a
// socket that does not answer a dial may still belong to a live daemon.

// errDaemonRunning is returned when another daemon holds the lock for the
// socket path this one was asked to listen on.
var errDaemonRunning = errors.New("another daemon is already serving this socket")

// errLocked is what tryLock returns when another process holds the lock.
var errLocked = errors.New("lock held by another process")

// lockWait bounds how long startup waits for the lock. A redeploy sends
// SIGTERM and starts the new daemon right after; the old one releases the
// lock as soon as it handles the signal. Kept well below the plugin's 5 s
// wait for the token. A var so tests can shorten it.
var lockWait = 2 * time.Second

const lockRetry = 50 * time.Millisecond

// stateFiles is this daemon's claim on its socket and token paths.
type stateFiles struct {
	socket, token string
	lock          *os.File
	once          sync.Once
}

// claimStateFiles takes the lock for socket, waiting up to lockWait for a
// daemon that is shutting down, then clears a socket left behind by a
// crashed run. On errDaemonRunning nothing at either path was touched.
func claimStateFiles(socket, token string) (*stateFiles, error) {
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		return nil, fmt.Errorf("mkdir socket dir: %w", err)
	}
	lockPath := socket + ".lock"
	lock, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock %q: %w", lockPath, err)
	}
	deadline := time.Now().Add(lockWait)
	for {
		err := tryLock(lock)
		if err == nil {
			break
		}
		if !errors.Is(err, errLocked) {
			_ = lock.Close()
			return nil, fmt.Errorf("lock %q: %w", lockPath, err)
		}
		if time.Now().After(deadline) {
			_ = lock.Close()
			return nil, fmt.Errorf("%w: %s", errDaemonRunning, socket)
		}
		time.Sleep(lockRetry)
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, fs.ErrNotExist) {
		_ = lock.Close()
		return nil, fmt.Errorf("remove stale socket %q: %w", socket, err)
	}
	return &stateFiles{socket: socket, token: token, lock: lock}, nil
}

// release removes the socket and token, then gives up the lock. Call it
// as soon as the daemon stops accepting, before it drains its
// connections, so a new daemon can take over at once. Safe to call more
// than once.
func (s *stateFiles) release() {
	s.once.Do(func() {
		_ = os.Remove(s.socket)
		_ = os.Remove(s.token)
		// Closing the file drops the lock. The lock file itself stays:
		// deleting it would let two daemons lock two different files.
		_ = s.lock.Close()
	})
}

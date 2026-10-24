package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"time"
)

// The socket and token paths are not private to one daemon: a redeploy
// starts a new daemon on the same paths while the old one may still be
// shutting down, and two profiles can be configured with the same
// paths. So the daemon never deletes a file at either path that it did
// not create itself (#614).

// errDaemonRunning is returned when another daemon still answers on the
// socket path this one was asked to listen on.
var errDaemonRunning = errors.New("another daemon is already listening on this socket")

// socketProbeTimeout bounds the dial claimSocketPath uses to tell a live
// socket from a stale one. A live daemon's kernel backlog accepts the
// connection at once, so this only matters for a wedged peer.
const socketProbeTimeout = time.Second

// claimSocketPath frees path for net.Listen. A socket left behind by a
// crashed run is removed. A socket that a live daemon still answers on
// is left alone, and errDaemonRunning is returned instead.
func claimSocketPath(path string) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if conn, err := net.DialTimeout("unix", path, socketProbeTimeout); err == nil {
		_ = conn.Close()
		return fmt.Errorf("%w: %s", errDaemonRunning, path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove stale socket %q: %w", path, err)
	}
	return nil
}

// ownedFile remembers which file this process created at a path, so it
// can delete it on exit only if it is still that file.
type ownedFile struct {
	path string
	info fs.FileInfo
}

// ownFile records the file currently at path as this process's own.
// Call it right after creating the file.
func ownFile(path string) (ownedFile, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ownedFile{}, err
	}
	return ownedFile{path: path, info: info}, nil
}

// remove deletes the file unless it is gone or another process has
// replaced it since ownFile. The check and the delete are not atomic,
// but the window between them is two syscalls long.
func (o ownedFile) remove() {
	if o.info == nil {
		return
	}
	cur, err := os.Lstat(o.path)
	if err != nil || !os.SameFile(o.info, cur) {
		return
	}
	_ = os.Remove(o.path)
}

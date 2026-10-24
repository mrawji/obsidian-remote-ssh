//go:build !unix

package main

import "os"

// tryLock is a no-op where flock is unavailable. The daemon ships for
// Linux and macOS only; this keeps a local Windows build compiling,
// without the #614 protection.
func tryLock(*os.File) error { return nil }

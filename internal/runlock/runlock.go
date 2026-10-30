// Package runlock implements the cross-process lock that separates command
// execution from self-update. The agent takes a shared lock for the whole
// lifetime of a run (journal.Begin through terminal journal append). The root
// updater takes the exclusive lock only while it stops the service, replaces
// the binary, verifies the new process and, if necessary, rolls back.
package runlock

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ErrBusy means the lock is held by another process or by an incompatible
// mode in this process.
var ErrBusy = errors.New("runlock: busy")

// Lock is one held flock. Close releases it.
type Lock struct {
	f *os.File
}

// OpenShared opens path read-only and takes a non-blocking shared lock.
// The file must already exist; the installer creates it 0644 root-owned.
func OpenShared(path string) (*Lock, error) {
	return open(path, syscall.O_RDONLY, syscall.LOCK_SH|syscall.LOCK_NB)
}

// OpenExclusive opens path read-write and takes a non-blocking exclusive
// lock. It is intended for root-owned management paths.
func OpenExclusive(path string) (*Lock, error) {
	return open(path, syscall.O_RDWR, syscall.LOCK_EX|syscall.LOCK_NB)
}

func open(path string, flags int, how int) (*Lock, error) {
	if path == "" {
		return nil, errors.New("runlock: empty path")
	}
	// O_NOFOLLOW keeps a replaced lock path from redirecting the lock.
	fd, err := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("runlock: open %s: %w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	if f == nil {
		syscall.Close(fd)
		return nil, errors.New("runlock: invalid file descriptor")
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("runlock: stat %s: %w", path, err)
	}
	if !st.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("runlock: %s is not a regular file", path)
	}
	if err := syscall.Flock(fd, how); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrBusy
		}
		return nil, fmt.Errorf("runlock: flock %s: %w", path, err)
	}
	return &Lock{f: f}, nil
}

// Close releases the lock. It is safe to call on a nil Lock.
func (l *Lock) Close() error {
	if l == nil || l.f == nil {
		return nil
	}
	f := l.f
	l.f = nil
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}

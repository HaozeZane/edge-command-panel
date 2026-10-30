package client

import (
	"context"
	"edge-command-agent/internal/config"
	"edge-command-agent/internal/journal"
	"edge-command-agent/internal/protocol"
	"edge-command-agent/internal/runlock"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUpdateExecutionLockCoversRealCommandAndJournal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "execution.lock")
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	j, err := journal.Open(filepath.Join(dir, "state"), journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	a, err := New(Options{Config: &config.Config{}, Journal: j, ExecutionLock: path, WorkingDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	lock, err := runlock.OpenExclusive(path)
	if err != nil {
		t.Fatal(err)
	}
	env := protocol.Envelope{V: 1, RunID: "blocked", Command: "touch should-not-run", TimeoutSec: 5}
	a.handleExecute(context.Background(), env)
	if r := j.Get("blocked"); r == nil || r.State() != protocol.StateFailed {
		t.Fatal("command not refused during update")
	}
	if _, err := os.Stat(filepath.Join(dir, "should-not-run")); !os.IsNotExist(err) {
		t.Fatal("blocked command executed")
	}
	lock.Close()
	env.RunID = "running"
	env.Command = "printf started > started; sleep 0.2; printf finished"
	a.handleExecute(context.Background(), env)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command did not start")
		}
		time.Sleep(time.Millisecond)
	}
	if l, err := runlock.OpenExclusive(path); !errors.Is(err, runlock.ErrBusy) {
		l.Close()
		t.Fatal("update admitted while command running", err)
	}
	a.wg.Wait()
	l, err := runlock.OpenExclusive(path)
	if err != nil {
		t.Fatal("execution lock leaked", err)
	}
	defer l.Close()
	if r := j.Get("running"); r == nil || r.State() != protocol.StateSucceeded {
		t.Fatal("execution unlocked before terminal journal event")
	}
	// A duplicate can replay while an updater holds the lock; it cannot respawn.
	a.handleExecute(context.Background(), env)
}
func TestReadyDoesNotWaitForPanelNetwork(t *testing.T) {
	dir := t.TempDir()
	j, err := journal.Open(dir, journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	ready := make(chan struct{})
	a, err := New(Options{Config: &config.Config{URL: "ws://127.0.0.1:1"}, Journal: j, OnReady: func() { close(ready) }})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("readiness waited for network")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("agent did not stop")
	}
}

func TestCrashedUpdaterFenceBlocksCommandAfterKernelUnlock(t *testing.T) {
	d := t.TempDir()
	lockPath := filepath.Join(d, "execution.lock")
	os.WriteFile(lockPath, nil, 0644)
	// The OS releases flock on updater death; the persisted marker still exists.
	os.WriteFile(lockPath+".pending", nil, 0600)
	j, err := journal.Open(filepath.Join(d, "state"), journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	a, err := New(Options{Config: &config.Config{}, Journal: j, ExecutionLock: lockPath, WorkingDir: d})
	if err != nil {
		t.Fatal(err)
	}
	a.handleExecute(context.Background(), protocol.Envelope{V: 1, RunID: "fenced", Command: "touch forbidden", TimeoutSec: 5})
	if r := j.Get("fenced"); r == nil || r.State() != protocol.StateFailed {
		t.Fatal("pending update admitted a command")
	}
	if _, err := os.Stat(filepath.Join(d, "forbidden")); !os.IsNotExist(err) {
		t.Fatal("fenced command executed")
	}
}

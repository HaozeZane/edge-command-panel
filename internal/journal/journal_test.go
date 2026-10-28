package journal

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"edge-command-agent/internal/protocol"
)

func openTest(t *testing.T, dir string) *Journal {
	t.Helper()
	j, err := Open(dir, Options{MaxBytes: 8 << 20, Retention: 30 * 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { j.Close() })
	return j
}

func TestExclusiveLock(t *testing.T) {
	dir := t.TempDir()
	j := openTest(t, dir)
	if _, err := Open(dir, DefaultOptions()); !errors.Is(err, ErrLocked) {
		t.Fatalf("second open err = %v, want ErrLocked", err)
	}
	j.Close()
	j2, err := Open(dir, DefaultOptions())
	if err != nil {
		t.Fatalf("reopen after close: %v", err)
	}
	j2.Close()
}

func TestBeginIsDurableAndDuplicateRejected(t *testing.T) {
	dir := t.TempDir()
	j := openTest(t, dir)
	run, err := j.Begin("run-1", "echo hi", 30, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run.LastSeq() != 1 || run.State() != protocol.StateAccepted {
		t.Fatalf("run = %+v", run)
	}
	if _, err := j.Begin("run-1", "echo hi", 30, 0); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate err = %v", err)
	}
	// Simulate reopening after a crash: accepted must already be on disk.
	j.Close()
	j2 := openTest(t, dir)
	if got := j2.Get("run-1"); got == nil || got.LastSeq() != 1 {
		t.Fatalf("durable run missing: %+v", got)
	}
}

func TestAckReplayGapAndRewind(t *testing.T) {
	dir := t.TempDir()
	j := openTest(t, dir)
	run, err := j.Begin("run-2", "x", 30, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Append(run, Record{Kind: protocol.KindStarted}); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Append(run, Record{Kind: protocol.KindOutput, Stream: protocol.StreamStdout, Data: "aGk="}); err != nil {
		t.Fatal(err)
	}
	if err := j.Ack("run-2", 1); err != nil {
		t.Fatal(err)
	}
	if got := run.AckedSeq(); got != 1 {
		t.Fatalf("acked = %d", got)
	}
	if rec, ok := j.Next("run-2", 2); !ok || rec.Seq != 2 {
		t.Fatalf("next = %+v %v", rec, ok)
	}
	// A lower (gap) ack must not skip events; replay resumes at seq+1.
	if err := j.Ack("run-2", 0); err != nil {
		t.Fatal(err)
	}
	if got := run.AckedSeq(); got != 1 {
		t.Fatalf("gap ack regressed acked = %d", got)
	}
	if err := j.Rewind("run-2"); err != nil {
		t.Fatal(err)
	}
	if got := run.AckedSeq(); got != 0 {
		t.Fatalf("rewind acked = %d", got)
	}
	j.Close()
	j2 := openTest(t, dir)
	if got := j2.Get("run-2").AckedSeq(); got != 0 {
		t.Fatalf("reopened acked = %d", got)
	}
	if _, ok := j2.Next("run-2", 1); !ok {
		t.Fatal("seq 1 missing after reopen")
	}
}

func TestReconcileInterruptedNeverResumes(t *testing.T) {
	dir := t.TempDir()
	j := openTest(t, dir)
	run, err := j.Begin("run-old", "sleep 100", 300, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Append(run, Record{Kind: protocol.KindStarted}); err != nil {
		t.Fatal(err)
	}
	j.Close()

	j2 := openTest(t, dir)
	if err := j2.ReconcileInterrupted(); err != nil {
		t.Fatal(err)
	}
	got := j2.Get("run-old")
	if got.State() != protocol.StateInterrupted {
		t.Fatalf("state = %s", got.State())
	}
	rec, ok := j2.Next("run-old", 3)
	if !ok || rec.Kind != protocol.KindFinished || rec.Status != protocol.StateInterrupted || rec.Reason != "agent_restarted" {
		t.Fatalf("finished = %+v %v", rec, ok)
	}
	if err := j2.ReconcileInterrupted(); err != nil {
		t.Fatal(err)
	}
	if got.LastSeq() != 3 {
		t.Fatalf("reconcile ran twice, lastSeq=%d", got.LastSeq())
	}
}

func TestJournalLimitRefusesNewRuns(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir, Options{MaxBytes: 5000, Retention: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	run, err := j.Begin("run-a", "x", 30, 0)
	if err != nil {
		t.Fatal(err)
	}
	big := make([]byte, 3000)
	for i := range big {
		big[i] = 'a'
	}
	if _, err := j.Append(run, Record{Kind: protocol.KindOutput, Stream: protocol.StreamStdout, Data: string(big)}); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Begin("run-b", "x", 30, 0); !errors.Is(err, ErrFull) {
		t.Fatalf("err = %v, want ErrFull", err)
	}
}

func TestRetentionRemovesOldTerminalRuns(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir, Options{MaxBytes: 8 << 20, Retention: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	run, err := j.Begin("run-old", "x", 30, 0)
	if err != nil {
		t.Fatal(err)
	}
	code := 0
	if _, err := j.Append(run, Record{Kind: protocol.KindFinished, Status: protocol.StateSucceeded, ExitCode: &code}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := j.Begin("run-new", "x", 30, 0); err != nil {
		t.Fatal(err)
	}
	if j.Get("run-old") != nil {
		t.Fatal("old terminal run was not removed")
	}
	if _, err := os.Stat(filepath.Join(dir, "runs", "run-old.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("old journal file still exists: %v", err)
	}
}

func TestClosedJournalRejectsSpawn(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	if _, err := j.Begin("run-x", "x", 30, 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
}

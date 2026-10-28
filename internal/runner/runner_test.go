package runner

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"edge-command-agent/internal/protocol"
)

func collect(t *testing.T, command string, timeout time.Duration) ([]Event, Result) {
	t.Helper()
	dir := t.TempDir()
	opt := DefaultOptions()
	opt.KillGrace = 2 * time.Second
	opt.FlushInterval = 50 * time.Millisecond
	var events []Event
	res := Run(context.Background(), opt, dir, command, timeout, func(ev Event) error {
		events = append(events, ev)
		return nil
	})
	return events, res
}

func outputs(events []Event, stream string) []byte {
	var b bytes.Buffer
	for _, ev := range events {
		if ev.Kind == protocol.KindOutput && ev.Stream == stream {
			b.Write(ev.Data)
		}
	}
	return b.Bytes()
}

func TestExit7StdoutStderr(t *testing.T) {
	ev, res := collect(t, `printf 'out\n'; printf 'err\n' >&2; exit 7`, 10*time.Second)
	if res.Status != protocol.StateFailed || res.ExitCode == nil || *res.ExitCode != 7 {
		t.Fatalf("result = %+v", res)
	}
	var started bool
	for _, e := range ev {
		if e.Kind == protocol.KindStarted {
			started = true
		}
	}
	if !started {
		t.Fatal("missing started event")
	}
	if got := string(outputs(ev, protocol.StreamStdout)); got != "out\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := string(outputs(ev, protocol.StreamStderr)); got != "err\n" {
		t.Fatalf("stderr = %q", got)
	}
}

// TestBurstShortOutput verifies that buffered tail chunks are never lost when
// many tiny writes and a fast exit race with the 64-slot reader channel.
func TestBurstShortOutput(t *testing.T) {
	for iter := 0; iter < 40; iter++ {
		ev, res := collect(t, "i=0; while [ $i -lt 300 ]; do printf 'o%03d' \"$i\"; printf 'e%03d' \"$i\" >&2; i=$((i+1)); done; printf 'TAILOUT'; printf 'TAILERR' >&2", 10*time.Second)
		if res.Status != protocol.StateSucceeded {
			t.Fatalf("iter %d: %+v", iter, res)
		}
		var wantO, wantE strings.Builder
		for i := 0; i < 300; i++ {
			fmt.Fprintf(&wantO, "o%03d", i)
			fmt.Fprintf(&wantE, "e%03d", i)
		}
		wantO.WriteString("TAILOUT")
		wantE.WriteString("TAILERR")
		if got := string(outputs(ev, protocol.StreamStdout)); got != wantO.String() {
			t.Fatalf("iter %d: stdout len=%d want=%d", iter, len(got), wantO.Len())
		}
		if got := string(outputs(ev, protocol.StreamStderr)); got != wantE.String() {
			t.Fatalf("iter %d: stderr len=%d want=%d", iter, len(got), wantE.Len())
		}
	}
}

func TestStdinClosed(t *testing.T) {
	_, res := collect(t, `cat; echo ok`, 5*time.Second)
	if res.Status != protocol.StateSucceeded {
		t.Fatalf("result = %+v", res)
	}
}

func TestOutputLimit(t *testing.T) {
	ev, res := collect(t, `dd if=/dev/zero bs=1024 count=1500 2>/dev/null | tr '\0' a`, 15*time.Second)
	if res.Status != protocol.StateSucceeded {
		t.Fatalf("result = %+v", res)
	}
	if !res.Truncated {
		t.Fatal("expected truncation")
	}
	total := int64(len(outputs(ev, protocol.StreamStdout)) + len(outputs(ev, protocol.StreamStderr)))
	if total > DefaultOptions().OutputLimit {
		t.Fatalf("kept %d bytes, limit %d", total, DefaultOptions().OutputLimit)
	}
	if total < (1<<20)-64<<10 {
		t.Fatalf("only kept %d bytes, expected close to 1MiB", total)
	}
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d still alive", pid)
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil && len(b) > 0 {
			pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
			if err != nil {
				t.Fatalf("pid file: %v", err)
			}
			return pid
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid file %s not written", path)
	return 0
}

func TestTimeoutKillsDescendants(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	opt := DefaultOptions()
	opt.KillGrace = 2 * time.Second
	var events []Event
	start := time.Now()
	res := Run(context.Background(), opt, dir,
		`sh -c 'sleep 30 & echo $! > child.pid; wait'`, time.Second,
		func(ev Event) error { events = append(events, ev); return nil })
	if res.Status != protocol.StateTimedOut {
		t.Fatalf("result = %+v", res)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("timeout took too long: %v", elapsed)
	}
	waitGone(t, readPID(t, pidFile))
}

func TestMainShellExitKillsDescendants(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	opt := DefaultOptions()
	opt.KillGrace = 2 * time.Second
	res := Run(context.Background(), opt, dir,
		`sh -c 'sleep 30 & echo $! > child.pid'`, 10*time.Second,
		func(Event) error { return nil })
	if res.Status != protocol.StateSucceeded {
		t.Fatalf("result = %+v", res)
	}
	waitGone(t, readPID(t, pidFile))
}

// Package runner executes one shell command at a time with a process group,
// timeout enforcement, output coalescing and a hard output cap.
package runner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"edge-command-agent/internal/protocol"
)

// Event is an output/started callback. Accepted and finished are owned by the
// caller so it can persist them in order.
type Event struct {
	Kind   string
	Stream string
	Data   []byte
}

// Result describes how the process ended.
type Result struct {
	Status    string
	ExitCode  *int
	Reason    string
	Truncated bool
}

// Options controls testability of the runner.
type Options struct {
	Shell         string
	KillGrace     time.Duration
	FlushInterval time.Duration
	FlushBytes    int
	OutputLimit   int64
	ReadChunk     int
	DrainTimeout  time.Duration
}

// DefaultOptions returns the frozen production values.
func DefaultOptions() Options {
	return Options{
		Shell:         "/bin/sh",
		KillGrace:     5 * time.Second,
		FlushInterval: 2 * time.Second,
		FlushBytes:    16 << 10,
		OutputLimit:   1 << 20,
		ReadChunk:     32 << 10,
		DrainTimeout:  2 * time.Second,
	}
}

// Run executes command and reports started and output events synchronously.
// It blocks until the process group is gone or the context is cancelled.
func Run(ctx context.Context, opt Options, dir, command string, timeout time.Duration, emit func(Event) error) Result {
	if opt.Shell == "" {
		opt = DefaultOptions()
	}
	if timeout < 0 {
		timeout = 0
	}
	cmd := exec.Command(opt.Shell, "-c", command)
	cmd.Dir = dir
	cmd.Stdin = nil // child sees /dev/null: stdin is closed
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	outR, outW, err := os.Pipe()
	if err != nil {
		return spawnFailure(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return spawnFailure(err)
	}
	cmd.Stdout = outW
	cmd.Stderr = errW
	if err := cmd.Start(); err != nil {
		outR.Close()
		errR.Close()
		outW.Close()
		errW.Close()
		return spawnFailure(err)
	}
	// Only the child keeps the write ends.
	outW.Close()
	errW.Close()
	pgid := cmd.Process.Pid

	emitFailed := false
	emitEvent := func(ev Event) {
		if emitFailed || emit == nil {
			return
		}
		if err := emit(ev); err != nil {
			emitFailed = true
		}
	}
	emitEvent(Event{Kind: protocol.KindStarted})

	chunks := make(chan chunk, 64)
	var readers sync.WaitGroup
	readers.Add(2)
	go readPipe(outR, protocol.StreamStdout, chunks, &readers, opt.ReadChunk)
	go readPipe(errR, protocol.StreamStderr, chunks, &readers, opt.ReadChunk)
	go func() {
		readers.Wait()
		close(chunks)
	}()

	timer := time.NewTimer(time.Hour)
	timer.Stop()
	if timeout > 0 {
		timer = time.NewTimer(timeout)
		defer timer.Stop()
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	agg := &aggregator{opt: opt, emit: emitEvent, bufs: map[string]*bytes.Buffer{}}
	ticker := time.NewTicker(opt.FlushInterval)
	defer ticker.Stop()

	var waitErr error
	timedOut := false
	interrupted := false
	ch := chunks

loop:
	for {
		select {
		case c, ok := <-ch:
			if !ok {
				ch = nil
				continue
			}
			agg.add(c.stream, c.data)
		case <-ticker.C:
			agg.flushAll()
		case <-timer.C:
			timedOut = true
			waitErr = stopAndWait(pgid, waitCh, opt.KillGrace)
			break loop
		case <-ctx.Done():
			interrupted = true
			waitErr = stopAndWait(pgid, waitCh, opt.KillGrace)
			break loop
		case waitErr = <-waitCh:
			break loop
		}
	}

	// The main shell can exit while descendants keep the pipes (or the
	// process group) alive. Always clean up the whole group, not just the
	// leader.
	if !timedOut && !interrupted {
		terminateGroup(pgid, opt.KillGrace)
	} else if groupAlive(pgid) {
		terminateGroup(pgid, opt.KillGrace)
	}

	drainDeadline := time.NewTimer(opt.DrainTimeout)
	defer drainDeadline.Stop()
	closedPipes := false
drain:
	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				break drain
			}
			agg.add(c.stream, c.data)
		case <-drainDeadline.C:
			// A descendant escaped the process group and still holds a
			// write end. Close our ends so readers and the channel close.
			outR.Close()
			errR.Close()
			closedPipes = true
			break drain
		}
	}
	if closedPipes {
		// Readers will return and close chunks; consume what is buffered so
		// no tail bytes are lost even on the timeout path.
		for c := range chunks {
			agg.add(c.stream, c.data)
		}
	}
	outR.Close()
	errR.Close()
	agg.flushAll()

	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	res := Result{ExitCode: &code, Truncated: agg.truncated}
	switch {
	case interrupted:
		res.Status = protocol.StateInterrupted
		res.Reason = "agent_shutdown"
	case timedOut:
		res.Status = protocol.StateTimedOut
		res.Reason = "timeout"
	case waitErr == nil || isExit(waitErr, 0):
		res.Status = protocol.StateSucceeded
	default:
		res.Status = protocol.StateFailed
	}
	if emitFailed {
		res.Reason = joinReason(res.Reason, "journal_write_failed")
	}
	return res
}

func joinReason(a, b string) string {
	if a == "" {
		return b
	}
	return a + ";" + b
}

func isExit(err error, code int) bool {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode() == code
	}
	return false
}

func spawnFailure(err error) Result {
	code := -1
	return Result{Status: protocol.StateFailed, ExitCode: &code, Reason: "spawn_failed"}
}

type chunk struct {
	stream string
	data   []byte
}

func readPipe(r *os.File, stream string, out chan<- chunk, wg *sync.WaitGroup, size int) {
	defer wg.Done()
	buf := make([]byte, size)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p := make([]byte, n)
			copy(p, buf[:n])
			out <- chunk{stream: stream, data: p}
		}
		if err != nil {
			return
		}
	}
}

type aggregator struct {
	opt       Options
	emit      func(Event)
	bufs      map[string]*bytes.Buffer
	total     int64
	truncated bool
}

func (a *aggregator) add(stream string, p []byte) {
	if a.truncated {
		return
	}
	remaining := a.opt.OutputLimit - a.total
	if remaining <= 0 {
		a.truncated = true
		return
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
		a.truncated = true
	}
	a.total += int64(len(p))
	b := a.bufs[stream]
	if b == nil {
		b = &bytes.Buffer{}
		a.bufs[stream] = b
	}
	b.Write(p)
	for b.Len() >= a.opt.FlushBytes {
		data := append([]byte(nil), b.Next(a.opt.FlushBytes)...)
		a.emit(Event{Kind: protocol.KindOutput, Stream: stream, Data: data})
	}
	if a.truncated {
		a.flushAll()
	}
}

func (a *aggregator) flushAll() {
	for _, stream := range []string{protocol.StreamStdout, protocol.StreamStderr} {
		b := a.bufs[stream]
		if b == nil || b.Len() == 0 {
			continue
		}
		data := append([]byte(nil), b.Bytes()...)
		b.Reset()
		a.emit(Event{Kind: protocol.KindOutput, Stream: stream, Data: data})
	}
}

func signalGroup(pgid int, sig syscall.Signal) {
	_ = syscall.Kill(-pgid, sig)
}

func groupAlive(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// terminateGroup sends TERM, waits up to grace, then KILLs the whole process
// group. Descendants are always included, even if the shell already exited.
func terminateGroup(pgid int, grace time.Duration) {
	if !groupAlive(pgid) {
		return
	}
	signalGroup(pgid, syscall.SIGTERM)
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if groupAlive(pgid) {
		signalGroup(pgid, syscall.SIGKILL)
	}
}

// stopAndWait TERMs the group, reaps the shell (so the leader does not look
// alive as a zombie), and then makes sure descendants are gone.
func stopAndWait(pgid int, waitCh <-chan error, grace time.Duration) error {
	start := time.Now()
	signalGroup(pgid, syscall.SIGTERM)
	var waitErr error
	select {
	case waitErr = <-waitCh:
	case <-time.After(grace):
		signalGroup(pgid, syscall.SIGKILL)
		waitErr = <-waitCh
	}
	remaining := grace - time.Since(start)
	if remaining < 0 {
		remaining = 0
	}
	terminateGroup(pgid, remaining)
	return waitErr
}

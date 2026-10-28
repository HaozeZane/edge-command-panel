package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"edge-command-agent/internal/config"
	"edge-command-agent/internal/journal"
	"edge-command-agent/internal/protocol"
	"edge-command-agent/internal/runner"
)

const testSecret = "s3cr3t-one-time"

type wsServer struct {
	srv     *httptest.Server
	conns   chan *websocket.Conn
	msgs    chan protocol.Envelope
	badAuth atomic.Bool
}

func newWSServer(t *testing.T) *wsServer {
	t.Helper()
	s := &wsServer{conns: make(chan *websocket.Conn, 8), msgs: make(chan protocol.Envelope, 4096)}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Id") != "cid" || r.Header.Get("CF-Access-Client-Secret") != testSecret {
			s.badAuth.Store(true)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		c.SetReadLimit(64 << 10)
		_ = c.WriteJSON(protocol.Envelope{V: 1, Type: protocol.TypeWelcome, ConnectionID: "conn"})
		select {
		case s.conns <- c:
		default:
		}
		for {
			var env protocol.Envelope
			if err := c.ReadJSON(&env); err != nil {
				return
			}
			s.msgs <- env
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *wsServer) url() string {
	return "ws" + strings.TrimPrefix(s.srv.URL, "http") + "/agent/ws"
}

func startAgent(t *testing.T, ws *wsServer, dir string, logs *bytes.Buffer) (context.CancelFunc, *journal.Journal) {
	t.Helper()
	j, err := journal.Open(filepath.Join(t.TempDir(), "state"), journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{URL: ws.url(), AgentID: "agent-1", ClientID: "cid", ClientSecret: testSecret, StateDir: "unused"}
	opt := Options{
		Config: cfg, Journal: j, WorkingDir: dir, Hostname: "test-host", BootID: "boot-1",
		Version: "test", PingInterval: 200 * time.Millisecond, PongTimeout: 2 * time.Second,
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond,
		StableAfter: 50 * time.Millisecond, Inflight: 8,
		Runner: func() runner.Options {
			o := runner.DefaultOptions()
			o.KillGrace = time.Second
			o.FlushInterval = 100 * time.Millisecond
			return o
		}(),
	}
	if logs != nil {
		opt.Logger = newTestLogger(logs)
	}
	a, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = a.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("agent did not stop")
		}
		j.Close()
	})
	return cancel, j
}

func readEnv(t *testing.T, ws *wsServer, timeout time.Duration) protocol.Envelope {
	t.Helper()
	select {
	case env := <-ws.msgs:
		return env
	case <-time.After(timeout):
		t.Fatal("timed out waiting for message")
		return protocol.Envelope{}
	}
}

func readHello(t *testing.T, ws *wsServer) protocol.Envelope {
	t.Helper()
	env := readEnv(t, ws, 5*time.Second)
	if env.Type != protocol.TypeHello {
		t.Fatalf("expected hello, got %+v", env)
	}
	return env
}

func send(t *testing.T, c *websocket.Conn, env protocol.Envelope) {
	t.Helper()
	env.V = 1
	if err := c.WriteJSON(env); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func execute(runID, command string, timeout int) protocol.Envelope {
	return protocol.Envelope{Type: protocol.TypeExecute, RunID: runID, Command: command,
		TimeoutSec: timeout, AcceptBefore: time.Now().Add(time.Minute).UnixMilli()}
}

func collectRun(t *testing.T, ws *wsServer, runID string, until time.Duration) []protocol.Envelope {
	t.Helper()
	var out []protocol.Envelope
	deadline := time.After(until)
	for {
		select {
		case env := <-ws.msgs:
			if env.Type == protocol.TypeEvent && env.RunID == runID {
				out = append(out, env)
				if env.Kind == protocol.KindFinished {
					return out
				}
			}
		case <-deadline:
			t.Fatalf("timed out waiting for finished on %s (got %d events)", runID, len(out))
		}
	}
}

func decoded(events []protocol.Envelope, stream string) string {
	var b strings.Builder
	for _, e := range events {
		if e.Kind == protocol.KindOutput && e.Stream == stream {
			data, _ := base64.StdEncoding.DecodeString(e.DataBase64)
			b.Write(data)
		}
	}
	return b.String()
}

func assertSeq(t *testing.T, events []protocol.Envelope) {
	t.Helper()
	for i, e := range events {
		if e.Seq != int64(i+1) {
			t.Fatalf("event %d has seq %d: %+v", i, e.Seq, e)
		}
	}
}

func TestCommandLifecycle(t *testing.T) {
	ws := newWSServer(t)
	var logs bytes.Buffer
	dir := t.TempDir()
	startAgent(t, ws, dir, &logs)
	c := <-ws.conns
	hello := readHello(t, ws)
	if hello.BootID != "boot-1" || hello.AgentVersion != "test" || hello.Hostname != "test-host" {
		t.Fatalf("hello = %+v", hello)
	}
	send(t, c, execute("run-1", `printf 'out\n'; printf 'err\n' >&2; exit 7`, 10))
	events := collectRun(t, ws, "run-1", 10*time.Second)
	assertSeq(t, events)
	if events[0].Kind != protocol.KindAccepted || events[1].Kind != protocol.KindStarted {
		t.Fatalf("first events = %+v", events[:2])
	}
	last := events[len(events)-1]
	if last.Status != protocol.StateFailed || last.ExitCode == nil || *last.ExitCode != 7 {
		t.Fatalf("finished = %+v", last)
	}
	if got := decoded(events, protocol.StreamStdout); got != "out\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := decoded(events, protocol.StreamStderr); got != "err\n" {
		t.Fatalf("stderr = %q", got)
	}
	if ws.badAuth.Load() {
		t.Fatal("agent did not send CF-Access headers")
	}
	if strings.Contains(logs.String(), testSecret) {
		t.Fatalf("log leaks secret: %s", logs.String())
	}
}

func TestBurstOutputNotLostThroughAgent(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	startAgent(t, ws, dir, nil)
	c := <-ws.conns
	readHello(t, ws)
	send(t, c, execute("run-burst", `i=0; while [ $i -lt 2000 ]; do printf 'x%04d' "$i"; printf 'y%04d' "$i" >&2; i=$((i+1)); done; printf TAIL`, 15))
	events := collectRun(t, ws, "run-burst", 15*time.Second)
	var wo, we strings.Builder
	for i := 0; i < 2000; i++ {
		wo.WriteString("x" + pad4(i))
		we.WriteString("y" + pad4(i))
	}
	wo.WriteString("TAIL")
	if got := decoded(events, protocol.StreamStdout); got != wo.String() {
		t.Fatalf("stdout len=%d want %d", len(got), wo.Len())
	}
	if got := decoded(events, protocol.StreamStderr); got != we.String() {
		t.Fatalf("stderr len=%d want %d", len(got), we.Len())
	}
}

func newTestLogger(w *bytes.Buffer) *log.Logger {
	return log.New(w, "test: ", log.LstdFlags)
}

func pad4(i int) string {
	s := "0000"
	d := ""
	for i > 0 {
		d = string(rune('0'+i%10)) + d
		i /= 10
	}
	if len(d) >= 4 {
		return d
	}
	return s[:4-len(d)] + d
}

func TestDuplicateExecuteNeverSpawns(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	startAgent(t, ws, dir, nil)
	c := <-ws.conns
	readHello(t, ws)
	send(t, c, execute("run-dup", `echo x >> once.txt; printf done`, 10))
	events := collectRun(t, ws, "run-dup", 10*time.Second)
	if len(events) < 3 || events[len(events)-1].Status != protocol.StateSucceeded {
		t.Fatalf("events = %+v", events)
	}
	// Acknowledge everything, then re-send the execute. It must replay from
	// seq 1 and must not run the command again.
	for _, e := range events {
		send(t, c, protocol.Envelope{Type: protocol.TypeAck, RunID: "run-dup", ThroughSeq: e.Seq})
	}
	time.Sleep(100 * time.Millisecond)
	send(t, c, execute("run-dup", `echo x >> once.txt; printf done`, 10))
	replay := collectRun(t, ws, "run-dup", 10*time.Second)
	if replay[0].Seq != 1 || replay[0].Kind != protocol.KindAccepted {
		t.Fatalf("replay did not start at seq 1: %+v", replay[0])
	}
	b, err := os.ReadFile(filepath.Join(dir, "once.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(b), "x") != 1 {
		t.Fatalf("command ran more than once: %q", b)
	}
}

func TestBusyRunRecordedFailed(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	startAgent(t, ws, dir, nil)
	c := <-ws.conns
	readHello(t, ws)
	send(t, c, execute("run-slow", `sleep 2; echo slow`, 10))
	send(t, c, execute("run-busy", `echo should-not-run > busy.txt`, 10))
	finals := map[string]protocol.Envelope{}
	deadline := time.After(10 * time.Second)
	for len(finals) < 2 {
		select {
		case env := <-ws.msgs:
			if env.Type == protocol.TypeEvent && env.Kind == protocol.KindFinished {
				finals[env.RunID] = env
			}
		case <-deadline:
			t.Fatalf("timed out waiting for both runs: %+v", finals)
		}
	}
	if finals["run-slow"].Status != protocol.StateSucceeded {
		t.Fatalf("slow = %+v", finals["run-slow"])
	}
	last := finals["run-busy"]
	if last.Status != protocol.StateFailed || last.Reason != "busy" {
		t.Fatalf("busy = %+v", last)
	}
	if _, err := os.Stat(filepath.Join(dir, "busy.txt")); !os.IsNotExist(err) {
		t.Fatal("busy command was executed")
	}
}

func TestProbeRepliesWhileCommandRuns(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	startAgent(t, ws, dir, nil)
	c := <-ws.conns
	readHello(t, ws)
	send(t, c, execute("run-sleep", `sleep 2`, 10))
	// Wait for started, then probe.
	for {
		env := readEnv(t, ws, 5*time.Second)
		if env.Type == protocol.TypeEvent && env.Kind == protocol.KindStarted {
			break
		}
	}
	start := time.Now()
	send(t, c, protocol.Envelope{Type: protocol.TypeProbe, ProbeID: "p1"})
	for {
		env := readEnv(t, ws, 2*time.Second)
		if env.Type == protocol.TypeProbeReply {
			if env.ProbeID != "p1" {
				t.Fatalf("probe id = %s", env.ProbeID)
			}
			if time.Since(start) > time.Second {
				t.Fatalf("probe reply too slow: %v", time.Since(start))
			}
			break
		}
	}
}

func TestReconnectReplaysUnackedAndCommandContinues(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	startAgent(t, ws, dir, nil)
	c1 := <-ws.conns
	readHello(t, ws)
	send(t, c1, execute("run-net", `sleep 1; printf part; sleep 1; printf done; echo x >> once.txt`, 15))
	// Wait for accepted and started, ack only accepted, then drop the link.
	var gotAccepted, gotStarted bool
	for !(gotAccepted && gotStarted) {
		env := readEnv(t, ws, 5*time.Second)
		if env.Type != protocol.TypeEvent || env.RunID != "run-net" {
			continue
		}
		if env.Kind == protocol.KindAccepted {
			gotAccepted = true
			send(t, c1, protocol.Envelope{Type: protocol.TypeAck, RunID: "run-net", ThroughSeq: env.Seq})
		}
		if env.Kind == protocol.KindStarted {
			gotStarted = true
		}
	}
	c1.Close()
	c2 := <-ws.conns
	hello := readHello(t, ws)
	found := false
	for _, r := range hello.Runs {
		if r.RunID == "run-net" {
			found = true
			if r.State != protocol.StateRunning {
				t.Fatalf("hello run state = %s", r.State)
			}
			if r.LastSeq < 2 {
				t.Fatalf("hello lastSeq = %d", r.LastSeq)
			}
		}
	}
	if !found {
		t.Fatalf("active run not announced in hello: %+v", hello.Runs)
	}
	var replay []protocol.Envelope
	deadline := time.After(15 * time.Second)
	for {
		select {
		case env := <-ws.msgs:
			if env.Type == protocol.TypeEvent && env.RunID == "run-net" {
				replay = append(replay, env)
				if env.Kind == protocol.KindFinished {
					goto finished
				}
			}
		case <-deadline:
			t.Fatalf("timed out; replay=%+v", replay)
		}
	}
finished:
	if replay[0].Seq != 2 || replay[0].Kind != protocol.KindStarted {
		t.Fatalf("replay started at %+v, want seq 2 started", replay[0])
	}
	if last := replay[len(replay)-1]; last.Status != protocol.StateSucceeded {
		t.Fatalf("finished = %+v", last)
	}
	if got := decoded(replay, protocol.StreamStdout); got != "partdone" {
		t.Fatalf("output = %q", got)
	}
	b, err := os.ReadFile(filepath.Join(dir, "once.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(b), "x") != 1 {
		t.Fatalf("command ran %d times", strings.Count(string(b), "x"))
	}
	_ = c2
}

func TestRestartMarksNonTerminalInterrupted(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	j, err := journal.Open(stateDir, journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	run, err := j.Begin("run-old", "sleep 100", 300, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Append(run, journal.Record{Kind: protocol.KindStarted}); err != nil {
		t.Fatal(err)
	}
	j.Close()

	// Simulate the next agent process starting after a crash.
	j2, err := journal.Open(stateDir, journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := j2.ReconcileInterrupted(); err != nil {
		t.Fatal(err)
	}
	ws := newWSServer(t)
	dir := t.TempDir()
	cfg := &config.Config{URL: ws.url(), AgentID: "a", ClientID: "cid", ClientSecret: testSecret}
	a, err := New(Options{Config: cfg, Journal: j2, WorkingDir: dir, Hostname: "h", BootID: "b",
		PingInterval: 200 * time.Millisecond, PongTimeout: 2 * time.Second,
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond,
		StableAfter: 50 * time.Millisecond, Runner: runner.DefaultOptions()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = a.Run(ctx); close(done) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("agent did not stop")
		}
		j2.Close()
	}()
	<-ws.conns
	hello := readHello(t, ws)
	found := false
	for _, r := range hello.Runs {
		if r.RunID == "run-old" {
			found = true
			if r.State != protocol.StateInterrupted || r.LastSeq != 3 {
				t.Fatalf("run summary = %+v", r)
			}
		}
	}
	if !found {
		t.Fatalf("interrupted run missing from hello: %+v", hello.Runs)
	}
	events := collectRun(t, ws, "run-old", 5*time.Second)
	if events[0].Seq != 1 || events[2].Seq != 3 {
		t.Fatalf("replay = %+v", events)
	}
	last := events[len(events)-1]
	if last.Status != protocol.StateInterrupted || last.Reason != "agent_restarted" {
		t.Fatalf("finished = %+v", last)
	}
}

func TestClosedJournalRejectsSpawn(t *testing.T) {
	ws := newWSServer(t)
	dir := t.TempDir()
	j, err := journal.Open(filepath.Join(t.TempDir(), "state"), journal.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	cfg := &config.Config{URL: ws.url(), AgentID: "a", ClientID: "cid", ClientSecret: testSecret}
	opt := Options{Config: cfg, Journal: j, WorkingDir: dir, Hostname: "h", BootID: "b",
		PingInterval: 200 * time.Millisecond, PongTimeout: 2 * time.Second,
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond,
		StableAfter: 50 * time.Millisecond}
	a, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = a.Run(ctx); close(done) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("agent did not stop")
		}
	}()
	c := <-ws.conns
	readHello(t, ws)
	send(t, c, execute("run-disk", `echo nope > should-not-exist`, 10))
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("command spawned despite journal failure")
	}
}

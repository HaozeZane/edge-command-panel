// Package client implements the outbound WebSocket agent. It owns reconnects,
// durable replay, one-at-a-time command execution and the protocol state
// machine. Commands are never tied to a connection: a drop only pauses event
// delivery.
package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/user"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"edge-command-agent/internal/config"
	"edge-command-agent/internal/journal"
	"edge-command-agent/internal/protocol"
	"edge-command-agent/internal/runner"
)

const (
	maxFrame      = 64 << 10
	maxTimeoutSec = 30 * 24 * 3600
)

// Options configures an Agent. Defaults are the frozen production values;
// tests shorten the timers.
type Options struct {
	Config       *config.Config
	Journal      *journal.Journal
	WorkingDir   string
	Hostname     string
	BootID       string
	Version      string
	PingInterval time.Duration
	PongTimeout  time.Duration
	ReconnectMin time.Duration
	ReconnectMax time.Duration
	StableAfter  time.Duration
	Inflight     int
	Runner       runner.Options
	Logger       *log.Logger
}

// Agent is a single long-lived agent instance.
type Agent struct {
	opt      Options
	j        *journal.Journal
	ctx      context.Context
	cancel   context.CancelFunc
	cmds     chan protocol.Envelope
	notify   chan struct{}
	active   atomic.Value // string
	sess     atomic.Pointer[session]
	wg       sync.WaitGroup
	workerWG sync.WaitGroup
}

// New validates options and prepares an agent. Journal ownership stays with
// the caller (and with main for the state-directory lock).
func New(opt Options) (*Agent, error) {
	if opt.Config == nil || opt.Journal == nil {
		return nil, errors.New("client: config and journal are required")
	}
	if opt.PingInterval <= 0 {
		opt.PingInterval = 30 * time.Second
	}
	if opt.PongTimeout <= 0 {
		opt.PongTimeout = 90 * time.Second
	}
	if opt.ReconnectMin <= 0 {
		opt.ReconnectMin = time.Second
	}
	if opt.ReconnectMax <= 0 {
		opt.ReconnectMax = 60 * time.Second
	}
	if opt.StableAfter <= 0 {
		opt.StableAfter = 30 * time.Second
	}
	if opt.Inflight <= 0 {
		opt.Inflight = 8
	}
	if opt.WorkingDir == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			// system services may not get HOME from the environment.
			if u, uerr := user.Current(); uerr == nil {
				home = u.HomeDir
			}
		}
		if home == "" {
			home = "/"
		}
		opt.WorkingDir = home
	}
	if opt.Hostname == "" {
		opt.Hostname, _ = os.Hostname()
	}
	if opt.BootID == "" {
		opt.BootID, _ = config.RandomID(16)
	}
	if opt.Version == "" {
		opt.Version = "dev"
	}
	if opt.Runner.Shell == "" {
		opt.Runner = runner.DefaultOptions()
	}
	if opt.Logger == nil {
		opt.Logger = log.New(os.Stderr, "edge-command-agent: ", log.LstdFlags|log.LUTC)
	}
	a := &Agent{
		opt:    opt,
		j:      opt.Journal,
		cmds:   make(chan protocol.Envelope, 64),
		notify: make(chan struct{}, 1),
	}
	a.active.Store("")
	return a, nil
}

// Run runs until ctx is cancelled. On shutdown the active command is
// interrupted and its terminal event is journaled.
func (a *Agent) Run(ctx context.Context) error {
	a.ctx, a.cancel = context.WithCancel(ctx)
	defer a.cancel()
	a.workerWG.Add(1)
	go a.commandLoop(a.ctx)

	backoff := a.opt.ReconnectMin
	for {
		if a.ctx.Err() != nil {
			break
		}
		start := time.Now()
		err := a.connectOnce(a.ctx)
		if a.ctx.Err() != nil {
			break
		}
		if time.Since(start) >= a.opt.StableAfter {
			backoff = a.opt.ReconnectMin
		}
		if err != nil {
			a.opt.Logger.Printf("connection: %v", err)
		}
		delay := jitter(backoff, 0.2)
		if delay < a.opt.ReconnectMin {
			delay = a.opt.ReconnectMin
		}
		if delay > a.opt.ReconnectMax {
			delay = a.opt.ReconnectMax
		}
		if err := sleepCtx(a.ctx, delay); err != nil {
			break
		}
		if time.Since(start) < a.opt.StableAfter {
			backoff *= 2
			if backoff > a.opt.ReconnectMax {
				backoff = a.opt.ReconnectMax
			}
		}
	}
	a.cancel()
	a.workerWG.Wait()
	a.wg.Wait()
	return nil
}

func jitter(d time.Duration, frac float64) time.Duration {
	if d <= 0 {
		return 0
	}
	f := 1 - frac + rand.Float64()*2*frac
	return time.Duration(float64(d) * f)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (a *Agent) signal() {
	select {
	case a.notify <- struct{}{}:
	default:
	}
}

func (a *Agent) currentSession() *session { return a.sess.Load() }

func (a *Agent) commandLoop(ctx context.Context) {
	defer a.workerWG.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case env := <-a.cmds:
			a.handleExecute(ctx, env)
		}
	}
}

func (a *Agent) handleExecute(ctx context.Context, env protocol.Envelope) {
	if env.V != protocol.Version {
		a.opt.Logger.Printf("execute %s: unsupported protocol version %d", env.RunID, env.V)
		return
	}
	if env.RunID == "" || env.TimeoutSec <= 0 || env.TimeoutSec > maxTimeoutSec {
		a.opt.Logger.Printf("execute: invalid message")
		return
	}
	// Duplicate execute: never spawn. Replay from the journal. If the
	// server already acknowledged everything, rewind so it can rebuild its
	// view from seq 1.
	if run := a.j.Get(env.RunID); run != nil {
		if protocol.IsTerminal(run.State()) && run.AckedSeq() >= run.LastSeq() {
			if err := a.j.Rewind(env.RunID); err != nil {
				a.opt.Logger.Printf("replay %s: %v", env.RunID, err)
			}
			if s := a.currentSession(); s != nil {
				s.resetSent(env.RunID)
			}
		}
		a.signal()
		return
	}
	if active := a.active.Load().(string); active != "" {
		// One run at a time: durably record the refusal, do not execute it.
		a.reject(env, "busy")
		return
	}
	if env.AcceptBefore > 0 && time.Now().UnixMilli() > env.AcceptBefore {
		a.reject(env, "accept_expired")
		return
	}
	run, err := a.j.Begin(env.RunID, env.Command, env.TimeoutSec, env.AcceptBefore)
	if err != nil {
		a.opt.Logger.Printf("execute %s: journal: %v", env.RunID, err)
		return
	}
	a.active.Store(env.RunID)
	a.signal()
	a.wg.Add(1)
	go a.execute(ctx, run)
}

func (a *Agent) reject(env protocol.Envelope, reason string) {
	run, err := a.j.Begin(env.RunID, env.Command, env.TimeoutSec, env.AcceptBefore)
	if err != nil {
		a.opt.Logger.Printf("execute %s: journal: %v", env.RunID, err)
		return
	}
	a.signal()
	code := -1
	if _, err := a.j.Append(run, journal.Record{
		Kind: protocol.KindFinished, Status: protocol.StateFailed, Reason: reason, ExitCode: &code,
	}); err != nil {
		a.opt.Logger.Printf("execute %s: journal: %v", env.RunID, err)
	}
	a.signal()
}

func (a *Agent) execute(ctx context.Context, run *journal.Run) {
	defer a.wg.Done()
	defer a.active.Store("")

	res := runner.Run(ctx, a.opt.Runner, a.opt.WorkingDir, run.Command,
		time.Duration(run.TimeoutSec)*time.Second, func(ev runner.Event) error {
			rec := journal.Record{Kind: ev.Kind, Stream: ev.Stream}
			if len(ev.Data) > 0 {
				rec.Data = base64.StdEncoding.EncodeToString(ev.Data)
			}
			_, err := a.j.Append(run, rec)
			if err == nil {
				a.signal()
			}
			return err
		})

	rec := journal.Record{Kind: protocol.KindFinished, Status: res.Status,
		Reason: res.Reason, ExitCode: res.ExitCode, Trunc: res.Truncated}
	if _, err := a.j.Append(run, rec); err != nil {
		a.opt.Logger.Printf("finished %s: journal: %v", run.ID, err)
	}
	a.signal()
}

func (a *Agent) connectOnce(ctx context.Context) error {
	hdr := http.Header{}
	hdr.Set("CF-Access-Client-Id", a.opt.Config.ClientID)
	hdr.Set("CF-Access-Client-Secret", a.opt.Config.ClientSecret)
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second, EnableCompression: false}
	conn, resp, err := d.DialContext(ctx, a.opt.Config.URL, hdr)
	if resp != nil {
		if resp.Body != nil {
			resp.Body.Close()
		}
	}
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	s := &session{a: a, conn: conn, sent: map[string]int64{}}
	a.sess.Store(s)
	defer func() {
		a.sess.CompareAndSwap(s, nil)
		conn.Close()
	}()
	err = s.serve(ctx)
	return err
}

type session struct {
	a       *Agent
	conn    *websocket.Conn
	sent    map[string]int64
	sentMu  sync.Mutex
	writeMu sync.Mutex
	pause   atomic.Int64 // unix nanoseconds
}

func (s *session) resetSent(id string) {
	s.sentMu.Lock()
	s.sent[id] = 0
	s.sentMu.Unlock()
}
func (s *session) getSent(id string) int64 {
	s.sentMu.Lock()
	defer s.sentMu.Unlock()
	return s.sent[id]
}

func (s *session) setSent(id string, seq int64) {
	s.sentMu.Lock()
	s.sent[id] = seq
	s.sentMu.Unlock()
}

func (s *session) serve(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	conn := s.conn
	conn.SetReadLimit(maxFrame)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))

	var welcome protocol.Envelope
	if err := conn.ReadJSON(&welcome); err != nil {
		return fmt.Errorf("welcome: %w", err)
	}
	if welcome.V != protocol.Version || welcome.Type != protocol.TypeWelcome {
		return fmt.Errorf("welcome: unexpected message type %q", welcome.Type)
	}
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(s.a.opt.PongTimeout))
	})
	_ = conn.SetReadDeadline(time.Now().Add(s.a.opt.PongTimeout))

	runs := s.a.j.Summaries(true)
	hello := protocol.Envelope{
		V: protocol.Version, Type: protocol.TypeHello, BootID: s.a.opt.BootID,
		AgentVersion: s.a.opt.Version, Hostname: s.a.opt.Hostname,
	}
	for _, r := range runs {
		hello.Runs = append(hello.Runs, protocol.RunSummary{RunID: r.ID, State: r.State, LastSeq: r.LastSeq})
	}
	if err := s.write(hello); err != nil {
		return fmt.Errorf("hello: %w", err)
	}

	stopClose := make(chan struct{})
	defer close(stopClose)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-stopClose:
		}
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		s.keepalive(ctx)
	}()
	go func() {
		defer wg.Done()
		s.sender(ctx)
	}()
	err := s.readLoop(ctx)
	cancel()
	conn.Close()
	wg.Wait()
	return err
}

func (s *session) write(env protocol.Envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	if len(b) > maxFrame {
		return fmt.Errorf("frame too large: %d", len(b))
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return s.conn.WriteMessage(websocket.TextMessage, b)
}

func (s *session) keepalive(ctx context.Context) {
	t := time.NewTicker(s.a.opt.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				s.conn.Close()
				return
			}
		}
	}
}

func (s *session) readLoop(ctx context.Context) error {
	for {
		var env protocol.Envelope
		if err := s.conn.ReadJSON(&env); err != nil {
			return err
		}
		switch env.Type {
		case protocol.TypeAck:
			if env.RunID != "" {
				// Normal ACKs are monotonic. Never rewind the send
				// watermark on an ordinary ACK: doing so would re-send
				// events that are already in flight. Gaps are handled by
				// the durable ACK watermark and by reconnect replay.
				if err := s.a.j.Ack(env.RunID, env.ThroughSeq); err != nil {
					s.a.opt.Logger.Printf("ack %s: %v", env.RunID, err)
				}
				s.a.signal()
			}
		case protocol.TypeExecute:
			select {
			case s.a.cmds <- env:
			case <-ctx.Done():
				return ctx.Err()
			}
		case protocol.TypeProbe:
			_ = s.write(protocol.Envelope{V: protocol.Version, Type: protocol.TypeProbeReply, ProbeID: env.ProbeID})
		case protocol.TypePause:
			ms := env.RetryAfter
			if ms < 0 {
				ms = 0
			}
			s.pause.Store(time.Now().Add(time.Duration(ms) * time.Millisecond).UnixNano())
			s.a.signal()
		case protocol.TypeWelcome:
			// Ignore duplicate welcome.
		}
	}
}

func (s *session) sender(ctx context.Context) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		until := s.pause.Load()
		if until > time.Now().UnixNano() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}
		progressed := false
		sums := s.a.j.Summaries(true)
		// Bound the replay window globally, not per run. The journal itself
		// remains the bounded on-disk buffer.
		inflight := int64(0)
		for _, sum := range sums {
			if last := s.getSent(sum.ID); last > sum.AckedSeq {
				inflight += last - sum.AckedSeq
			}
		}
		for _, sum := range sums {
			if ctx.Err() != nil {
				return
			}
			if s.pause.Load() > time.Now().UnixNano() {
				break
			}
			if inflight >= int64(s.a.opt.Inflight) {
				break
			}
			last := s.getSent(sum.ID)
			if sum.AckedSeq > last {
				last = sum.AckedSeq
			}
			if last >= sum.LastSeq {
				continue
			}
			rec, ok := s.a.j.Next(sum.ID, last+1)
			if !ok {
				continue
			}
			if err := s.write(rec.Envelope()); err != nil {
				s.conn.Close()
				return
			}
			s.setSent(sum.ID, rec.Seq)
			inflight++
			progressed = true
		}
		if !progressed {
			select {
			case <-ctx.Done():
				return
			case <-s.a.notify:
			case <-t.C:
			}
		}
	}
}

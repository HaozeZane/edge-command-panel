// Package journal implements the durable, fsync'd run journal. The journal is
// the source of truth for events: an event is persisted before it is sent and
// replay always resumes at ackedSeq+1.
package journal

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"edge-command-agent/internal/protocol"
)

var (
	ErrLocked    = errors.New("journal: state directory is locked by another process")
	ErrClosed    = errors.New("journal: closed")
	ErrDuplicate = errors.New("journal: duplicate run")
	ErrFull      = errors.New("journal: journal size limit reached")
	ErrInvalidID = errors.New("journal: invalid run id")

	runIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
)

// Options bounds disk use and duplicate suppression retention.
type Options struct {
	MaxBytes  int64
	Retention time.Duration
}

// DefaultOptions returns the production limits (256 MiB / 30 days).
func DefaultOptions() Options {
	return Options{MaxBytes: 256 << 20, Retention: 30 * 24 * time.Hour}
}

// Record is a line in a run journal file.
type Record struct {
	Type     string `json:"type"` // meta, event, ack
	RunID    string `json:"runId,omitempty"`
	Command  string `json:"command,omitempty"`
	TimeSec  int    `json:"timeoutSec,omitempty"`
	Accept   int64  `json:"acceptBefore,omitempty"`
	Created  int64  `json:"createdAt,omitempty"`
	Seq      int64  `json:"seq,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Stream   string `json:"stream,omitempty"`
	Data     string `json:"dataBase64,omitempty"`
	Status   string `json:"status,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Trunc    bool   `json:"outputTruncated,omitempty"`
	Ack      int64  `json:"throughSeq,omitempty"`
	At       int64  `json:"at,omitempty"`
}

// Envelope converts an event record to the wire format.
func (r Record) Envelope() protocol.Envelope {
	return protocol.Envelope{
		V: protocol.Version, Type: protocol.TypeEvent, RunID: r.RunID, Seq: r.Seq,
		Kind: r.Kind, Stream: r.Stream, DataBase64: r.Data, Status: r.Status,
		ExitCode: r.ExitCode, Reason: r.Reason, OutputTruncated: r.Trunc,
	}
}

// Run is an in-memory view of one journal file.
type Run struct {
	ID         string
	Command    string
	TimeoutSec int
	Accept     int64
	CreatedAt  int64

	mu         sync.Mutex
	events     []Record
	state      string
	acked      int64
	finishedAt int64
	path       string
	size       int64
}

// State returns the last persisted run state.
func (r *Run) State() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

// LastSeq returns the highest persisted event sequence.
func (r *Run) LastSeq() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return int64(len(r.events))
}

// AckedSeq returns the highest acknowledged sequence.
func (r *Run) AckedSeq() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.acked
}

// Summary is a cheap snapshot used for hello and replay scheduling.
type Summary struct {
	ID         string
	State      string
	LastSeq    int64
	AckedSeq   int64
	CreatedAt  int64
	FinishedAt int64
}

// Journal owns the state lock and all run files.
type Journal struct {
	dir   string
	runs  string
	opt   Options
	lock  *os.File
	mu    sync.Mutex
	byID  map[string]*Run
	order []*Run
	bytes atomic.Int64
	done  bool
}

// Open locks the state directory and loads existing run journals. Only one
// process may own a state directory at a time.
func Open(stateDir string, opt Options) (*Journal, error) {
	if opt.MaxBytes <= 0 {
		opt.MaxBytes = DefaultOptions().MaxBytes
	}
	if opt.Retention <= 0 {
		opt.Retention = DefaultOptions().Retention
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("journal: create state dir: %w", err)
	}
	lockPath := filepath.Join(stateDir, "agent.lock")
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("journal: open lock: %w", err)
	}
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lf.Close()
		return nil, ErrLocked
	}
	runsDir := filepath.Join(stateDir, "runs")
	if err := os.MkdirAll(runsDir, 0o700); err != nil {
		lf.Close()
		return nil, fmt.Errorf("journal: create runs dir: %w", err)
	}
	j := &Journal{dir: stateDir, runs: runsDir, opt: opt, lock: lf, byID: map[string]*Run{}}
	if err := j.load(); err != nil {
		j.Close()
		return nil, err
	}
	j.cleanup()
	return j, nil
}

func (j *Journal) load() error {
	ents, err := os.ReadDir(j.runs)
	if err != nil {
		return fmt.Errorf("journal: read runs dir: %w", err)
	}
	for _, ent := range ents {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(ent.Name(), ".jsonl")
		if !runIDPattern.MatchString(id) {
			continue
		}
		path := filepath.Join(j.runs, ent.Name())
		f, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("journal: open %s: %w", ent.Name(), err)
		}
		run, err := parseRun(id, f)
		if err != nil {
			f.Close()
			log.Printf("journal: ignoring unreadable run file %s: %v", ent.Name(), err)
			continue
		}
		st, _ := f.Stat()
		f.Close()
		run.path = path
		if st != nil {
			run.size = st.Size()
			j.bytes.Add(run.size)
		}
		j.byID[id] = run
		j.order = append(j.order, run)
	}
	sort.Slice(j.order, func(a, b int) bool {
		if j.order[a].CreatedAt == j.order[b].CreatedAt {
			return j.order[a].ID < j.order[b].ID
		}
		return j.order[a].CreatedAt < j.order[b].CreatedAt
	})
	return nil
}

func parseRun(id string, f *os.File) (*Run, error) {
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	run := &Run{ID: id, state: protocol.StateAccepted}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	haveMeta := false
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			// A torn final line is possible after a hard crash. Ignore it.
			continue
		}
		switch rec.Type {
		case "meta":
			haveMeta = true
			run.Command = rec.Command
			run.TimeoutSec = rec.TimeSec
			run.Accept = rec.Accept
			run.CreatedAt = rec.Created
			run.ID = rec.RunID
		case "event":
			if rec.Seq != int64(len(run.events))+1 {
				continue
			}
			rec.RunID = id
			run.events = append(run.events, rec)
			applyState(run, rec)
		case "ack":
			if rec.Ack >= 0 {
				run.acked = rec.Ack
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !haveMeta || len(run.events) == 0 {
		return nil, errors.New("missing metadata or events")
	}
	return run, nil
}

func applyState(r *Run, rec Record) {
	switch rec.Kind {
	case protocol.KindAccepted:
		r.state = protocol.StateAccepted
	case protocol.KindStarted:
		r.state = protocol.StateRunning
	case protocol.KindFinished:
		r.state = rec.Status
		r.finishedAt = rec.At
	}
}

// Close releases the lock. It is safe to call more than once.
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return nil
	}
	j.done = true
	if j.lock != nil {
		_ = syscall.Flock(int(j.lock.Fd()), syscall.LOCK_UN)
		_ = j.lock.Close()
	}
	return nil
}

// Get returns a run by id, or nil.
func (j *Journal) Get(id string) *Run {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.byID[id]
}

// Begin durably creates a run and its accepted event (seq 1). The caller must
// only spawn the process after Begin returns successfully.
func (j *Journal) Begin(id, command string, timeoutSec int, acceptBefore int64) (*Run, error) {
	if !runIDPattern.MatchString(id) {
		return nil, ErrInvalidID
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return nil, ErrClosed
	}
	if _, ok := j.byID[id]; ok {
		return nil, ErrDuplicate
	}
	j.cleanupLocked()
	if j.bytes.Load()+4096 > j.opt.MaxBytes {
		return nil, ErrFull
	}
	path := filepath.Join(j.runs, id+".jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("journal: create run: %w", err)
	}
	now := time.Now().UnixMilli()
	meta := Record{Type: "meta", RunID: id, Command: command, TimeSec: timeoutSec, Accept: acceptBefore, Created: now, At: now}
	accepted := Record{Type: "event", RunID: id, Seq: 1, Kind: protocol.KindAccepted, At: now}
	buf, err := marshalLines(meta, accepted)
	if err == nil {
		_, err = f.Write(buf)
	}
	if err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = f.Close()
	}
	if err != nil {
		f.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("journal: persist accepted: %w", err)
	}
	run := &Run{ID: id, Command: command, TimeoutSec: timeoutSec, Accept: acceptBefore, CreatedAt: now,
		events: []Record{accepted}, state: protocol.StateAccepted, path: path, size: int64(len(buf))}
	j.byID[id] = run
	j.order = append(j.order, run)
	j.bytes.Add(int64(len(buf)))
	return run, nil
}

func appendRunRecord(run *Run, rec Record) (int64, error) {
	line, err := marshalLines(rec)
	if err != nil {
		return 0, err
	}
	f, err := os.OpenFile(run.path, os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	before := run.size
	n, err := f.Write(line)
	if err == nil && n != len(line) {
		err = errors.New("short write")
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		_ = f.Truncate(before)
		_ = f.Close()
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	run.size += int64(len(line))
	return int64(len(line)), nil
}

func marshalLines(recs ...Record) ([]byte, error) {
	var b []byte
	for _, rec := range recs {
		line, err := json.Marshal(rec)
		if err != nil {
			return nil, err
		}
		b = append(b, line...)
		b = append(b, '\n')
	}
	return b, nil
}

// Append persists an event and assigns the next sequence number. The process
// is never signalled to spawn before the accepted record is durable.
func (j *Journal) Append(run *Run, rec Record) (Record, error) {
	j.mu.Lock()
	closed := j.done
	j.mu.Unlock()
	if closed {
		return Record{}, ErrClosed
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	rec.Type = "event"
	rec.RunID = run.ID
	rec.Seq = int64(len(run.events)) + 1
	rec.At = time.Now().UnixMilli()
	written, err := appendRunRecord(run, rec)
	if err != nil {
		return Record{}, fmt.Errorf("journal: persist event: %w", err)
	}
	run.events = append(run.events, rec)
	applyState(run, rec)
	j.bytes.Add(written)
	return rec, nil
}

// Ack durably records that the server has every event through throughSeq.
// A lower (gap) acknowledgement is accepted and replay continues at
// throughSeq+1.
func (j *Journal) Ack(id string, through int64) error {
	j.mu.Lock()
	run := j.byID[id]
	closed := j.done
	j.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if run == nil {
		return nil
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if through > int64(len(run.events)) {
		through = int64(len(run.events))
	}
	if through < 0 {
		through = 0
	}
	if through <= run.acked {
		return nil
	}
	rec := Record{Type: "ack", RunID: id, Ack: through, At: time.Now().UnixMilli()}
	written, err := appendRunRecord(run, rec)
	if err != nil {
		return fmt.Errorf("journal: persist ack: %w", err)
	}
	run.acked = through
	j.bytes.Add(written)
	return nil
}

// Rewind makes all events eligible for replay again. It is used when the
// server re-sends an execute for a terminal run (the run is never spawned
// again, only replayed).
func (j *Journal) Rewind(id string) error {
	j.mu.Lock()
	run := j.byID[id]
	closed := j.done
	j.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if run == nil {
		return nil
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.acked == 0 {
		return nil
	}
	rec := Record{Type: "ack", RunID: id, Ack: 0, At: time.Now().UnixMilli()}
	written, err := appendRunRecord(run, rec)
	if err != nil {
		return fmt.Errorf("journal: rewind: %w", err)
	}
	run.acked = 0
	j.bytes.Add(written)
	return nil
}

// Next returns the event with sequence seq (1-based).
func (j *Journal) Next(id string, seq int64) (Record, bool) {
	j.mu.Lock()
	run := j.byID[id]
	j.mu.Unlock()
	if run == nil {
		return Record{}, false
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if seq < 1 || seq > int64(len(run.events)) {
		return Record{}, false
	}
	return run.events[seq-1], true
}

// Summaries returns run snapshots in creation order. With unackedOnly set,
// only runs that still have events the server has not acknowledged are
// returned (these are the ones advertised in hello).
func (j *Journal) Summaries(unackedOnly bool) []Summary {
	j.mu.Lock()
	runs := append([]*Run(nil), j.order...)
	j.mu.Unlock()
	out := make([]Summary, 0, len(runs))
	for _, r := range runs {
		r.mu.Lock()
		if !unackedOnly || int64(len(r.events)) > r.acked {
			out = append(out, Summary{ID: r.ID, State: r.state, LastSeq: int64(len(r.events)),
				AckedSeq: r.acked, CreatedAt: r.CreatedAt, FinishedAt: r.finishedAt})
		}
		r.mu.Unlock()
	}
	return out
}

// ReconcileInterrupted closes runs left non-terminal by a previous process.
// They are never resumed.
func (j *Journal) ReconcileInterrupted() error {
	for _, s := range j.Summaries(false) {
		if protocol.IsTerminal(s.State) {
			continue
		}
		run := j.Get(s.ID)
		if run == nil {
			continue
		}
		code := -1
		if _, err := j.Append(run, Record{Kind: protocol.KindFinished, Status: protocol.StateInterrupted,
			Reason: "agent_restarted", ExitCode: &code}); err != nil {
			return err
		}
	}
	return nil
}

// Bytes returns the tracked journal size.
func (j *Journal) Bytes() int64 { return j.bytes.Load() }

func (j *Journal) cleanup() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cleanupLocked()
}

func (j *Journal) cleanupLocked() {
	now := time.Now()
	snapshot := append([]*Run(nil), j.order...)
	for _, r := range snapshot {
		r.mu.Lock()
		term := protocol.IsTerminal(r.state) && r.finishedAt > 0
		fin := r.finishedAt
		r.mu.Unlock()
		if term && now.Sub(time.UnixMilli(fin)) > j.opt.Retention {
			j.removeLocked(r)
		}
	}
	if j.bytes.Load() <= j.opt.MaxBytes {
		return
	}
	// Hard size limit: evict the oldest terminal runs even inside the
	// retention window. Active runs are never evicted.
	type termRun struct {
		run *Run
		fin int64
	}
	var terminal []termRun
	for _, r := range append([]*Run(nil), j.order...) {
		r.mu.Lock()
		// Only fully acknowledged terminal runs may be evicted for size.
		// Dropping unacknowledged events would create a replay gap; instead
		// Begin reports ErrFull and refuses to spawn new commands.
		if protocol.IsTerminal(r.state) && r.acked >= int64(len(r.events)) {
			terminal = append(terminal, termRun{run: r, fin: r.finishedAt})
		}
		r.mu.Unlock()
	}
	sort.Slice(terminal, func(a, b int) bool { return terminal[a].fin < terminal[b].fin })
	for _, tr := range terminal {
		if j.bytes.Load() <= (j.opt.MaxBytes*9)/10 {
			break
		}
		if j.byID[tr.run.ID] != tr.run {
			continue
		}
		j.removeLocked(tr.run)
	}
}

func (j *Journal) removeLocked(r *Run) {
	r.mu.Lock()
	size := r.size
	path := r.path
	r.mu.Unlock()
	if err := os.Remove(path); err != nil {
		log.Printf("journal: remove %s: %v", path, err)
		return
	}
	delete(j.byID, r.ID)
	for i, x := range j.order {
		if x == r {
			j.order = append(j.order[:i], j.order[i+1:]...)
			break
		}
	}
	j.bytes.Add(-size)
	if j.bytes.Load() < 0 {
		j.bytes.Store(0)
	}
}

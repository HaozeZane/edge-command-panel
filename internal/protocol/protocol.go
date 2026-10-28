// Package protocol defines the version 1 WebSocket wire format shared with the
// control panel. It intentionally mirrors shared/protocol.ts.
package protocol

const (
	Version = 1

	TypeWelcome    = "welcome"
	TypeHello      = "hello"
	TypeExecute    = "execute"
	TypeEvent      = "event"
	TypeAck        = "ack"
	TypeProbe      = "probe"
	TypeProbeReply = "probe_reply"
	TypePause      = "pause"

	KindAccepted = "accepted"
	KindStarted  = "started"
	KindOutput   = "output"
	KindFinished = "finished"

	StreamStdout = "stdout"
	StreamStderr = "stderr"

	StateAccepted    = "accepted"
	StateRunning     = "running"
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateTimedOut    = "timed_out"
	StateInterrupted = "interrupted"
)

// IsTerminal reports whether state is a terminal run state.
func IsTerminal(state string) bool {
	switch state {
	case StateSucceeded, StateFailed, StateTimedOut, StateInterrupted:
		return true
	}
	return false
}

// Envelope is the common wire object. Fields are omitted when empty so the
// messages remain small and match the frozen contract.
type Envelope struct {
	V    int    `json:"v"`
	Type string `json:"type"`

	// welcome
	ConnectionID string `json:"connectionId,omitempty"`

	// hello
	BootID       string       `json:"bootId,omitempty"`
	AgentVersion string       `json:"version,omitempty"`
	Hostname     string       `json:"hostname,omitempty"`
	Runs         []RunSummary `json:"runs,omitempty"`

	// execute
	RunID        string `json:"runId,omitempty"`
	Command      string `json:"command,omitempty"`
	TimeoutSec   int    `json:"timeoutSec,omitempty"`
	AcceptBefore int64  `json:"acceptBefore,omitempty"`

	// event
	Seq             int64  `json:"seq,omitempty"`
	Kind            string `json:"kind,omitempty"`
	Stream          string `json:"stream,omitempty"`
	DataBase64      string `json:"dataBase64,omitempty"`
	Status          string `json:"status,omitempty"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	Reason          string `json:"reason,omitempty"`
	OutputTruncated bool   `json:"outputTruncated,omitempty"`

	// ack
	ThroughSeq int64 `json:"throughSeq,omitempty"`

	// probe / probe_reply
	ProbeID string `json:"probeId,omitempty"`

	// pause
	RetryAfter int64 `json:"retryAfter,omitempty"`
}

// RunSummary is the hello run list entry.
type RunSummary struct {
	RunID   string `json:"runId"`
	State   string `json:"state"`
	LastSeq int64  `json:"lastSeq"`
}

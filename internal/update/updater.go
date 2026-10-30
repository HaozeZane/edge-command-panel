package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"edge-command-agent/internal/runlock"
)

const (
	DefaultStateDir      = "/var/lib/edge-command-agent-update"
	DefaultExecutionLock = "/var/lib/edge-command-agent-lock/execution.lock"
	DefaultTargetBinary  = "/usr/local/bin/edge-command-agent"
	DefaultServiceName   = "edge-command-agent.service"
	DefaultCheckInterval = time.Hour
	DefaultJitterMax     = 5 * time.Minute
	DefaultBusyRetry     = 10 * time.Minute
	DefaultQuarantine    = 24 * time.Hour
)

// Status values returned by Run.
const (
	StatusNoUpdate   = "no_update"
	StatusUpdated    = "updated"
	StatusBusy       = "busy"
	StatusBackoff    = "backoff"
	StatusSkipped    = "skipped"
	StatusRecovered  = "recovered"
	StatusRolledBack = "rolled_back"
	StatusBlocked    = "blocked"
)

// ErrRejected marks a downloaded artifact that failed integrity or version
// verification. Network and rate-limit errors are not wrapped with it.
var ErrRejected = errors.New("update: rejected candidate")

// Result describes one updater invocation.
type Result struct {
	Status    string
	Version   string
	Reason    string
	NextCheck time.Time
}

// Options are the production policy with test-only injection points. The
// bootstrap CLI does not expose any of them as flags.
type Options struct {
	StateDir          string
	TargetBinary      string
	ExecutionLockPath string
	UpdaterLockPath   string
	Service           Service
	HTTP              HTTPConfig
	Arch              string
	CurrentVersion    string
	Now               func() time.Time
	Jitter            func(time.Duration) time.Duration
	JitterMax         time.Duration
	CheckInterval     time.Duration
	BusyRetry         time.Duration
	StableFor         time.Duration
	RollbackStable    time.Duration
	HealthPoll        time.Duration
	VersionTimeout    time.Duration
	QuarantineFor     time.Duration
	Logger            *log.Logger
	// Checkpoint and SyncTargetDir are fault-injection seams, never CLI options.
	Checkpoint    func(TransactionStage) error
	SyncTargetDir func(string) error
}

// Updater is one serialized updater instance.
type Updater struct {
	opt    Options
	client *Client
	svc    Service
}

func (o Options) withDefaults() Options {
	if o.StateDir == "" {
		o.StateDir = DefaultStateDir
	}
	if o.TargetBinary == "" {
		o.TargetBinary = DefaultTargetBinary
	}
	if o.ExecutionLockPath == "" {
		o.ExecutionLockPath = DefaultExecutionLock
	}
	if o.UpdaterLockPath == "" {
		o.UpdaterLockPath = filepath.Join(o.StateDir, "updater.lock")
	}
	if o.Service == nil {
		o.Service = SystemdService{Name: DefaultServiceName}
	}
	if o.Arch == "" {
		o.Arch = runtime.GOARCH
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Jitter == nil {
		o.Jitter = func(max time.Duration) time.Duration {
			if max <= 0 {
				return 0
			}
			return time.Duration(rand.Int63n(int64(max) + 1))
		}
	}
	if o.JitterMax <= 0 {
		o.JitterMax = DefaultJitterMax
	}
	if o.CheckInterval <= 0 {
		o.CheckInterval = DefaultCheckInterval
	}
	if o.BusyRetry <= 0 {
		o.BusyRetry = DefaultBusyRetry
	}
	if o.StableFor <= 0 {
		o.StableFor = 30 * time.Second
	}
	if o.RollbackStable <= 0 {
		o.RollbackStable = 2 * time.Second
	}
	if o.HealthPoll <= 0 {
		o.HealthPoll = time.Second
	}
	if o.VersionTimeout <= 0 {
		o.VersionTimeout = 10 * time.Second
	}
	if o.QuarantineFor <= 0 {
		o.QuarantineFor = DefaultQuarantine
	}
	if o.Logger == nil {
		o.Logger = log.New(os.Stderr, "edge-command-agent-update: ", log.LstdFlags|log.LUTC)
	}
	return o
}

// New validates the injected policy and builds an updater.
func New(opt Options) (*Updater, error) {
	opt = opt.withDefaults()
	switch opt.Arch {
	case "amd64", "arm64":
	default:
		return nil, fmt.Errorf("update: unsupported architecture %q", opt.Arch)
	}
	return &Updater{opt: opt, client: NewClient(opt.HTTP), svc: opt.Service}, nil
}

func (u *Updater) now() time.Time { return u.opt.Now() }

// Run performs at most one update attempt. Expected failures are recorded in
// the persistent state and returned as Result statuses; only unsafe paths,
// corrupt state and similar fatal conditions return an error.
func (u *Updater) Run(ctx context.Context) (Result, error) {
	if err := EnsureRootDir(u.opt.StateDir, 0o700); err != nil {
		return Result{}, err
	}
	if err := EnsureRootDir(filepath.Dir(u.opt.ExecutionLockPath), 0o755); err != nil {
		return Result{}, err
	}
	if err := ValidateRootFile(u.opt.ExecutionLockPath); err != nil {
		return Result{}, err
	}
	if err := u.ensureLockFile(u.opt.UpdaterLockPath); err != nil {
		return Result{}, err
	}
	single, err := runlock.OpenExclusive(u.opt.UpdaterLockPath)
	if errors.Is(err, runlock.ErrBusy) {
		return Result{Status: StatusBusy, Reason: "another updater is running"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer single.Close()

	st, err := LoadState(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	if st.Blocked {
		return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
	}

	txn, err := LoadTransaction(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	if txn == nil {
		if err := u.clearOrphanFence(); err != nil {
			if errors.Is(err, runlock.ErrBusy) {
				return Result{Status: StatusBusy}, nil
			}
			return Result{}, err
		}
	}
	if txn != nil {
		res, err := u.recover(ctx, txn)
		if err != nil || res.Status != StatusRecovered {
			return res, err
		}
		st, err = LoadState(u.opt.StateDir)
		if err != nil {
			return Result{}, err
		}
		if st.Blocked {
			return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
		}
	}

	current, err := u.currentVersion(ctx)
	if err != nil {
		return Result{}, err
	}
	if st.CurrentVersion != current.String() {
		st.CurrentVersion = current.String()
		if err := SaveState(u.opt.StateDir, st); err != nil {
			return Result{}, err
		}
	}

	now := u.now()
	if st.NextCheck > now.UnixMilli() {
		return Result{Status: StatusSkipped, Version: current.String(),
			NextCheck: time.UnixMilli(st.NextCheck)}, nil
	}

	// Reserve the next slot before any network I/O, including a killed attempt.
	st.NextCheck = now.Add(u.opt.CheckInterval + u.opt.Jitter(u.opt.JitterMax)).UnixMilli()
	if err := SaveState(u.opt.StateDir, st); err != nil {
		return Result{}, err
	}
	active, err := u.svc.IsActive(ctx)
	if err != nil {
		return Result{}, err
	}
	if !active {
		return Result{Status: StatusSkipped, Reason: "agent service was manually stopped", NextCheck: time.UnixMilli(st.NextCheck)}, nil
	}
	releases, err := u.client.ListReleases(ctx)
	if err != nil {
		return u.fail(st, now, "list releases", err)
	}
	cand, ok := SelectRelease(releases, current)
	if !ok {
		return u.noUpdate(st, now, current)
	}
	if u.quarantined(st, cand, now) {
		u.opt.Logger.Printf("candidate %s is quarantined until %s", cand.Version, time.UnixMilli(st.QuarantineUntil).UTC())
		return u.noUpdate(st, now, current)
	}

	digest, err := u.fetchAndVerify(ctx, cand)
	if err != nil {
		var rl *RateLimitError
		if errors.As(err, &rl) {
			return u.fail(st, now, "download", err)
		}
		if errors.Is(err, ErrRejected) {
			u.quarantine(&st, cand, digest, now)
			return u.fail(st, now, "rejected "+cand.Version.String(), err)
		}
		return u.fail(st, now, "download", err)
	}

	lock, err := runlock.OpenExclusive(u.opt.ExecutionLockPath)
	if errors.Is(err, runlock.ErrBusy) {
		st.NextCheck = now.Add(u.opt.BusyRetry).UnixMilli()
		st.LastFailure = "agent is running a command"
		if serr := SaveState(u.opt.StateDir, st); serr != nil {
			return Result{}, serr
		}
		return Result{Status: StatusBusy, Version: cand.Version.String(),
			Reason: "agent is running a command", NextCheck: now.Add(u.opt.BusyRetry)}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer lock.Close()

	// The target may have changed while the artifact was downloading.
	latest, err := u.currentVersion(ctx)
	if err != nil {
		return Result{}, err
	}
	if cand.Version.Compare(latest) <= 0 {
		return u.noUpdate(st, now, latest)
	}

	return u.apply(ctx, cand, digest, st)
}

func (u *Updater) ensureLockFile(path string) error {
	if err := ValidateRootFile(path); err == nil {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return ValidateRootFile(path)
		}
		return fmt.Errorf("update: create updater lock: %w", err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	return ValidateRootFile(path)
}

func (u *Updater) currentVersion(ctx context.Context) (Version, error) {
	if u.opt.CurrentVersion != "" {
		return ParseVersion(u.opt.CurrentVersion)
	}
	if err := ValidateExecutable(u.opt.TargetBinary); err != nil {
		return Version{}, err
	}
	out, err := VersionOutput(ctx, u.opt.TargetBinary, u.opt.VersionTimeout)
	if err != nil {
		return Version{}, err
	}
	fields := strings.Fields(out)
	if len(fields) != 2 || fields[0] != "edge-command-agent" {
		return Version{}, fmt.Errorf("update: installed binary reports %q", out)
	}
	return ParseVersion(fields[1])
}

func (u *Updater) assetName() string {
	if u.opt.Arch == "arm64" {
		return assetArm64
	}
	return assetAmd64
}

type candidateCache struct {
	Version string `json:"version"`
	Tag     string `json:"tag"`
	Digest  string `json:"digest"`
	Path    string `json:"path"`
}

func (u *Updater) cachedCandidate(cand Release) (string, bool) {
	path := filepath.Join(u.opt.StateDir, "candidate.json")
	data, err := readFileNoFollow(path)
	if err != nil {
		return "", false
	}
	var c candidateCache
	if err := json.Unmarshal(data, &c); err != nil {
		return "", false
	}
	if c.Version != cand.Version.String() || c.Tag != cand.Tag || c.Digest == "" {
		return "", false
	}
	if c.Path != filepath.Join(u.opt.StateDir, "candidate") {
		return "", false
	}
	got, err := HashFile(c.Path)
	if err != nil || got != c.Digest {
		return "", false
	}
	if err := VerifyELFArch(c.Path, u.opt.Arch); err != nil {
		return "", false
	}
	out, err := VersionOutput(context.Background(), c.Path, u.opt.VersionTimeout)
	if err != nil || VerifyCandidateVersion(out, cand.Version) != nil {
		return "", false
	}
	return c.Digest, true
}

func (u *Updater) fetchAndVerify(ctx context.Context, cand Release) (string, error) {
	if digest, ok := u.cachedCandidate(cand); ok {
		return digest, nil
	}
	st, err := LoadState(u.opt.StateDir)
	if err != nil {
		return "", err
	}
	if u.quarantined(st, cand, u.now()) {
		return "", fmt.Errorf("%w: version is quarantined", ErrRejected)
	}

	sumsTmp := filepath.Join(u.opt.StateDir, fmt.Sprintf(".SHA256SUMS-%d", os.Getpid()))
	_ = os.Remove(sumsTmp)
	if _, _, err := u.client.DownloadAsset(ctx, cand.Tag, assetSums, sumsTmp); err != nil {
		_ = os.Remove(sumsTmp)
		return "", err
	}
	sumsData, err := readFileNoFollow(sumsTmp)
	_ = os.Remove(sumsTmp)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRejected, err)
	}
	sums, err := ParseSHA256SUMS(sumsData)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRejected, err)
	}
	if len(sums) != 3 || sums[assetAmd64] == "" || sums[assetArm64] == "" || sums[assetInstaller] == "" {
		return "", fmt.Errorf("%w: incomplete or unexpected SHA256SUMS entries", ErrRejected)
	}
	want, ok := sums[u.assetName()]
	if !ok {
		return "", fmt.Errorf("%w: SHA256SUMS has no entry for %s", ErrRejected, u.assetName())
	}

	if st.QuarantineVersion == cand.Version.String() && st.QuarantineUntil > u.now().UnixMilli() && st.QuarantineDigest == want {
		return want, fmt.Errorf("%w: version and digest are quarantined", ErrRejected)
	}
	binTmp := filepath.Join(u.opt.StateDir, fmt.Sprintf(".candidate-%d", os.Getpid()))
	_ = os.Remove(binTmp)
	digest, _, err := u.client.DownloadAsset(ctx, cand.Tag, u.assetName(), binTmp)
	if err != nil {
		_ = os.Remove(binTmp)
		return "", err
	}
	reject := func(format string, args ...any) (string, error) {
		_ = os.Remove(binTmp)
		return digest, fmt.Errorf("%w: %s", ErrRejected, fmt.Sprintf(format, args...))
	}
	if digest != want {
		return reject("SHA-256 mismatch: got %s want %s", digest, want)
	}
	if err := VerifyELFArch(binTmp, u.opt.Arch); err != nil {
		return reject("%v", err)
	}
	out, err := VersionOutput(ctx, binTmp, u.opt.VersionTimeout)
	if err != nil {
		return reject("%v", err)
	}
	if err := VerifyCandidateVersion(out, cand.Version); err != nil {
		return reject("%v", err)
	}
	if st.QuarantineVersion == cand.Version.String() && st.QuarantineUntil > u.now().UnixMilli() &&
		(st.QuarantineDigest == "" || st.QuarantineDigest == digest) {
		return reject("version and digest are quarantined")
	}

	dst := filepath.Join(u.opt.StateDir, "candidate")
	_ = os.Remove(dst)
	if err := os.Rename(binTmp, dst); err != nil {
		_ = os.Remove(binTmp)
		return "", fmt.Errorf("update: cache candidate: %w", err)
	}
	if err := fsyncDir(u.opt.StateDir); err != nil {
		return "", err
	}
	cacheData, err := json.Marshal(candidateCache{
		Version: cand.Version.String(), Tag: cand.Tag, Digest: digest, Path: dst,
	})
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(filepath.Join(u.opt.StateDir, "candidate.json"), append(cacheData, '\n'), 0o600); err != nil {
		return "", err
	}
	return digest, nil
}

func (u *Updater) quarantined(st State, cand Release, now time.Time) bool {
	if st.QuarantineVersion != cand.Version.String() || st.QuarantineUntil <= now.UnixMilli() {
		return false
	}
	if st.QuarantineDigest == "" {
		return true
	}
	if digest, ok := u.cachedCandidate(cand); ok && digest == st.QuarantineDigest {
		return true
	}
	return false
}

func (u *Updater) quarantine(st *State, cand Release, digest string, now time.Time) {
	if st.QuarantineVersion == cand.Version.String() && st.QuarantineDigest == digest && st.QuarantineUntil > now.UnixMilli() {
		return
	}
	st.QuarantineVersion = cand.Version.String()
	st.QuarantineDigest = digest
	st.QuarantineUntil = now.Add(u.opt.QuarantineFor).UnixMilli()
}

func (u *Updater) noUpdate(st State, now time.Time, current Version) (Result, error) {
	st.FailureCount = 0
	st.LastFailure = ""
	st.NextCheck = now.Add(u.opt.CheckInterval + u.opt.Jitter(u.opt.JitterMax)).UnixMilli()
	if err := SaveState(u.opt.StateDir, st); err != nil {
		return Result{}, err
	}
	return Result{Status: StatusNoUpdate, Version: current.String(),
		NextCheck: time.UnixMilli(st.NextCheck)}, nil
}

func (u *Updater) fail(st State, now time.Time, reason string, cause error) (Result, error) {
	st.FailureCount++
	st.LastFailure = reason + ": " + cause.Error()
	backoff := failureBackoff(st.FailureCount)
	next := now.Add(backoff)
	var rl *RateLimitError
	if errors.As(cause, &rl) {
		if rl.RetryAfter > 0 {
			if t := now.Add(rl.RetryAfter); t.After(next) {
				next = t
			}
		}
		if !rl.Reset.IsZero() && rl.Reset.After(next) {
			next = rl.Reset
		}
	}
	st.NextCheck = next.UnixMilli()
	if err := SaveState(u.opt.StateDir, st); err != nil {
		return Result{}, err
	}
	u.opt.Logger.Printf("update attempt failed: %v (next check %s)", cause, next.UTC())
	return Result{Status: StatusBackoff, Reason: st.LastFailure, NextCheck: next}, nil
}

func failureBackoff(n int) time.Duration {
	if n < 1 {
		n = 1
	}
	d := time.Hour
	for i := 1; i < n; i++ {
		d *= 2
		if d >= 24*time.Hour {
			return 24 * time.Hour
		}
	}
	return d
}

func (u *Updater) checkpoint(txn *Transaction) error {
	if err := SaveTransaction(u.opt.StateDir, txn); err != nil {
		return err
	}
	if u.opt.Checkpoint != nil {
		return u.opt.Checkpoint(txn.Stage)
	}
	return nil
}

func (u *Updater) apply(ctx context.Context, cand Release, digest string, st State) (Result, error) {
	targetDir := filepath.Dir(u.opt.TargetBinary)
	if err := ValidateRootDir(targetDir); err != nil {
		return Result{}, err
	}
	if err := ValidateExecutable(u.opt.TargetBinary); err != nil {
		return Result{}, err
	}
	oldDigest, err := HashFile(u.opt.TargetBinary)
	if err != nil {
		return Result{}, err
	}
	stage, err := StageExecutable(filepath.Join(u.opt.StateDir, "candidate"), targetDir)
	if err != nil {
		return Result{}, err
	}
	// Finish the durable backup before taking the idle service down.
	oldPath := filepath.Join(u.opt.StateDir, "old-binary")
	if err := CopyFileAtomic(u.opt.TargetBinary, oldPath, 0755); err != nil {
		os.Remove(stage)
		return Result{}, err
	}
	if got, err := HashFile(oldPath); err != nil || got != oldDigest {
		os.Remove(stage)
		return Result{}, errors.New("update: backup verification failed")
	}
	now := u.now()
	txn := &Transaction{Version: cand.Version.String(), Tag: cand.Tag, Digest: digest,
		OldDigest: oldDigest, Stage: StagePreparing, CandidatePath: stage,
		OldBinaryPath: oldPath, TargetPath: u.opt.TargetBinary, CreatedAt: now.UnixMilli()}
	if err := u.createFence(); err != nil {
		os.Remove(stage)
		return Result{}, err
	}
	if err := u.checkpoint(txn); err != nil {
		return Result{}, err
	}
	if err := stopConfirmed(ctx, u.svc); err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "stop service", err)
	}
	for _, phase := range []TransactionStage{StageBackup, StageReplacing} {
		txn.Stage = phase
		if err := SaveTransaction(u.opt.StateDir, txn); err != nil {
			return u.rollback(ctx, txn, cand, digest, st, now, "record replacement", err)
		}
		if u.opt.Checkpoint != nil {
			if err := u.opt.Checkpoint(phase); err != nil {
				return Result{}, err
			}
		}
	}
	if err := os.Rename(stage, u.opt.TargetBinary); err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "replace binary", err)
	}
	syncDir := u.opt.SyncTargetDir
	if syncDir == nil {
		syncDir = fsyncDir
	}
	if err := syncDir(targetDir); err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "sync target directory", err)
	}
	for _, phase := range []TransactionStage{StageReplaced, StageStarting} {
		txn.Stage = phase
		if err := SaveTransaction(u.opt.StateDir, txn); err != nil {
			return u.rollback(ctx, txn, cand, digest, st, now, "record startup", err)
		}
		if u.opt.Checkpoint != nil {
			if err := u.opt.Checkpoint(phase); err != nil {
				return Result{}, err
			}
		}
	}
	if err := u.svc.Start(ctx); err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "start new service", err)
	}
	pid, err := waitHealthy(ctx, u.svc, u.opt.StableFor, u.opt.HealthPoll)
	if err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "new service health", err)
	}
	txn.PID, txn.Stage = pid, StageCommitted
	if err := SaveTransaction(u.opt.StateDir, txn); err != nil {
		return u.rollback(ctx, txn, cand, digest, st, now, "record commit", err)
	}
	if u.opt.Checkpoint != nil {
		if err := u.opt.Checkpoint(StageCommitted); err != nil {
			return Result{}, err
		}
	}
	if err := u.finalizeCommitted(txn, st); err != nil {
		return Result{}, err
	}
	u.cleanupFiles(txn)
	saved, err := LoadState(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	return Result{Status: StatusUpdated, Version: cand.Version.String(), NextCheck: time.UnixMilli(saved.NextCheck)}, nil
}

func (u *Updater) rollback(ctx context.Context, txn *Transaction, cand Release, digest string, st State, now time.Time, reason string, cause error) (Result, error) {
	u.opt.Logger.Printf("rolling back %s: %v", cand.Version, cause)
	// A cancelled update must still have a bounded opportunity to restore service.
	recoveryCtx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	ctx = recoveryCtx
	if err := u.restoreOld(ctx, txn); err != nil {
		return u.markRollbackFailed(txn, st, fmt.Errorf("%s: %v; rollback: %v", reason, cause, err))
	}
	if err := RemoveTransaction(u.opt.StateDir); err != nil {
		return Result{}, err
	}
	u.cleanupFiles(txn)
	u.quarantine(&st, cand, digest, now)
	res, err := u.fail(st, now, reason, cause)
	if err != nil {
		return Result{}, err
	}
	if err := u.clearFence(); err != nil {
		return Result{}, err
	}
	res.Status = StatusRolledBack
	return res, nil
}

func (u *Updater) restoreOld(ctx context.Context, txn *Transaction) error {
	if err := stopConfirmed(ctx, u.svc); err != nil {
		return err
	}
	if err := u.restoreBinary(txn); err != nil {
		return err
	}
	if err := u.svc.Start(ctx); err != nil {
		return err
	}
	if _, err := waitHealthy(ctx, u.svc, u.opt.RollbackStable, u.opt.HealthPoll); err != nil {
		return err
	}
	return nil
}

// restoreBinary is safe during boot: it only touches fixed, verified files.
func (u *Updater) restoreBinary(txn *Transaction) error {
	if err := ValidateRootDir(filepath.Dir(txn.TargetPath)); err != nil {
		return err
	}
	targetDigest, err := HashFile(txn.TargetPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if targetDigest == txn.Digest || errors.Is(err, os.ErrNotExist) {
		if err := ValidateRootFile(txn.OldBinaryPath); err != nil {
			return err
		}
		if got, err := HashFile(txn.OldBinaryPath); err != nil || got != txn.OldDigest {
			if err == nil {
				err = fmt.Errorf("old binary digest mismatch")
			}
			return err
		}
		stage, err := StageExecutable(txn.OldBinaryPath, filepath.Dir(txn.TargetPath))
		if err != nil {
			return err
		}
		if err := os.Rename(stage, txn.TargetPath); err != nil {
			_ = os.Remove(stage)
			return err
		}
		if err := fsyncDir(filepath.Dir(txn.TargetPath)); err != nil {
			return err
		}
	} else if targetDigest != txn.OldDigest {
		return fmt.Errorf("target digest matches neither old nor candidate")
	}
	return nil
}

func (u *Updater) markRollbackFailed(txn *Transaction, st State, cause error) (Result, error) {
	txn.RollbackFailed = true
	_ = SaveTransaction(u.opt.StateDir, txn)
	st.Blocked = true
	st.LastFailure = "rollback failed: " + cause.Error()
	_ = SaveState(u.opt.StateDir, st)
	u.opt.Logger.Printf("rollback failed; updates blocked until manual repair: %v", cause)
	return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
}

// RecoverBoot performs boot-time transaction recovery only. It never calls
// Start or Stop on the agent service: the recovery unit runs Before/Requires
// the agent, so starting it here would deadlock the systemd transaction. The
// agent is started by systemd after this process exits.
func (u *Updater) RecoverBoot(ctx context.Context) (Result, error) {
	if err := EnsureRootDir(u.opt.StateDir, 0o700); err != nil {
		return Result{}, err
	}
	if err := EnsureRootDir(filepath.Dir(u.opt.ExecutionLockPath), 0o755); err != nil {
		return Result{}, err
	}
	if err := ValidateRootFile(u.opt.ExecutionLockPath); err != nil {
		return Result{}, err
	}
	if err := u.ensureLockFile(u.opt.UpdaterLockPath); err != nil {
		return Result{}, err
	}
	single, err := runlock.OpenExclusive(u.opt.UpdaterLockPath)
	if errors.Is(err, runlock.ErrBusy) {
		return Result{Status: StatusBusy, Reason: "another updater is running"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer single.Close()
	txn, err := LoadTransaction(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	if txn == nil {
		st, err := LoadState(u.opt.StateDir)
		if err != nil {
			return Result{}, err
		}
		if st.Blocked {
			return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
		}
		if err := u.clearOrphanFence(); err != nil {
			if errors.Is(err, runlock.ErrBusy) {
				return Result{Status: StatusBusy}, nil
			}
			return Result{}, err
		}
		return Result{Status: StatusSkipped, Reason: "no transaction"}, nil
	}
	lock, err := runlock.OpenExclusive(u.opt.ExecutionLockPath)
	if errors.Is(err, runlock.ErrBusy) {
		return Result{Status: StatusBusy, Reason: "agent is running a command"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer lock.Close()
	st, err := LoadState(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	active, err := u.svc.IsActive(ctx)
	if err != nil {
		return Result{}, err
	}
	if active {
		return Result{Status: StatusBusy, Reason: "agent service is already active"}, nil
	}
	return u.recoverFilesOnly(txn, st)
}

// recoverFilesOnly restores the old binary and transaction metadata without
// touching the service. Used only by RecoverBoot.
func (u *Updater) recoverFilesOnly(txn *Transaction, st State) (Result, error) {
	if err := u.validateTransaction(txn); err != nil {
		return Result{}, err
	}
	if txn.TargetPath != u.opt.TargetBinary {
		return Result{}, fmt.Errorf("update: transaction target %q does not match %q", txn.TargetPath, u.opt.TargetBinary)
	}
	if txn.Stage == StageCommitted {
		if err := u.finalizeCommitted(txn, st); err != nil {
			return Result{}, err
		}
		u.cleanupFiles(txn)
		return Result{Status: StatusRecovered, Version: txn.Version, Reason: "completed committed update"}, nil
	}
	if txn.RollbackFailed {
		st.Blocked = true
		if st.LastFailure == "" {
			st.LastFailure = "rollback previously failed"
		}
		if err := SaveState(u.opt.StateDir, st); err != nil {
			return Result{}, err
		}
		return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
	}
	if txn.OldDigest == "" || txn.OldBinaryPath == "" {
		return u.markRollbackFailed(txn, st, errors.New("transaction is missing the old binary record"))
	}
	if err := u.restoreBinary(txn); err != nil {
		return u.markRollbackFailed(txn, st, err)
	}
	if err := RemoveTransaction(u.opt.StateDir); err != nil {
		return Result{}, err
	}
	u.cleanupFiles(txn)
	now := u.now()
	if txn.Stage == StageReplacing || txn.Stage == StageReplaced || txn.Stage == StageStarting {
		v, _ := ParseVersion(txn.Version)
		u.quarantine(&st, Release{Version: v, Tag: txn.Tag}, txn.Digest, now)
	}
	res, err := u.fail(st, now, "boot recovery", errors.New("interrupted at stage "+string(txn.Stage)))
	if err != nil {
		return Result{}, err
	}
	if err := u.clearFence(); err != nil {
		return Result{}, err
	}
	res.Status = StatusRecovered
	return res, nil
}

func (u *Updater) recover(ctx context.Context, txn *Transaction) (Result, error) {
	if err := u.validateTransaction(txn); err != nil {
		return Result{}, err
	}
	if txn.TargetPath != u.opt.TargetBinary {
		return Result{}, fmt.Errorf("update: transaction target %q does not match %q", txn.TargetPath, u.opt.TargetBinary)
	}
	lock, err := runlock.OpenExclusive(u.opt.ExecutionLockPath)
	if errors.Is(err, runlock.ErrBusy) {
		return Result{Status: StatusBusy, Reason: "agent is running a command"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer lock.Close()

	st, err := LoadState(u.opt.StateDir)
	if err != nil {
		return Result{}, err
	}
	if txn.Stage == StageCommitted {
		if err := u.finalizeCommitted(txn, st); err != nil {
			return Result{}, err
		}
		u.cleanupFiles(txn)
		return Result{Status: StatusRecovered, Version: txn.Version, Reason: "completed committed update"}, nil
	}
	if txn.RollbackFailed {
		st.Blocked = true
		if st.LastFailure == "" {
			st.LastFailure = "rollback previously failed"
		}
		if err := SaveState(u.opt.StateDir, st); err != nil {
			return Result{}, err
		}
		return Result{Status: StatusBlocked, Reason: st.LastFailure}, nil
	}
	if txn.OldDigest == "" || txn.OldBinaryPath == "" {
		return u.markRollbackFailed(txn, st, errors.New("transaction is missing the old binary record"))
	}
	if err := u.restoreOld(ctx, txn); err != nil {
		return u.markRollbackFailed(txn, st, err)
	}
	if err := RemoveTransaction(u.opt.StateDir); err != nil {
		return Result{}, err
	}
	u.cleanupFiles(txn)
	now := u.now()
	if txn.Stage == StageReplacing || txn.Stage == StageReplaced || txn.Stage == StageStarting {
		v, _ := ParseVersion(txn.Version)
		u.quarantine(&st, Release{Version: v, Tag: txn.Tag}, txn.Digest, now)
	}
	res, err := u.fail(st, now, "recovered interrupted update", errors.New("interrupted at stage "+string(txn.Stage)))
	if err != nil {
		return Result{}, err
	}
	if err := u.clearFence(); err != nil {
		return Result{}, err
	}
	res.Status = StatusRecovered
	return res, nil
}

func (u *Updater) validateTransaction(t *Transaction) error {
	if t.TargetPath != u.opt.TargetBinary || t.OldBinaryPath != filepath.Join(u.opt.StateDir, "old-binary") ||
		filepath.Dir(t.CandidatePath) != filepath.Dir(u.opt.TargetBinary) || !strings.HasPrefix(filepath.Base(t.CandidatePath), ".edge-command-agent.new.") {
		return errors.New("update: invalid transaction paths")
	}
	if !sha256Pattern.MatchString(t.Digest) || !sha256Pattern.MatchString(t.OldDigest) {
		return errors.New("update: invalid transaction hashes")
	}
	v, ok := ParseReleaseTag(t.Tag)
	if !ok || v.String() != t.Version {
		return errors.New("update: invalid transaction version")
	}
	switch t.Stage {
	case StagePreparing, StageBackup, StageReplacing, StageReplaced, StageStarting, StageCommitted, StageRolledBack:
	default:
		return errors.New("update: invalid transaction stage")
	}
	return nil
}

func (u *Updater) finalizeCommitted(txn *Transaction, st State) error {
	got, err := HashFile(u.opt.TargetBinary)
	if err != nil || got != txn.Digest {
		return errors.New("update: committed target digest mismatch")
	}
	v, err := ParseVersion(txn.Version)
	if err != nil {
		return err
	}
	st.CurrentVersion = v.String()
	st.FailureCount = 0
	st.LastFailure = ""
	st.QuarantineVersion = ""
	st.QuarantineDigest = ""
	st.QuarantineUntil = 0
	st.Blocked = false
	st.NextCheck = u.now().Add(u.opt.CheckInterval + u.opt.Jitter(u.opt.JitterMax)).UnixMilli()
	if err := SaveState(u.opt.StateDir, st); err != nil {
		return err
	}
	if err := RemoveTransaction(u.opt.StateDir); err != nil {
		return err
	}
	return u.clearFence()
}

func (u *Updater) cleanupFiles(txn *Transaction) {
	if txn == nil {
		return
	}
	// Keep the last known good binary until the next verified update.
	if txn.CandidatePath != "" && strings.HasPrefix(filepath.Base(txn.CandidatePath), ".edge-command-agent.new.") &&
		filepath.Dir(txn.CandidatePath) == filepath.Dir(u.opt.TargetBinary) {
		_ = os.Remove(txn.CandidatePath)
	}
	_ = os.Remove(filepath.Join(u.opt.StateDir, "candidate"))
	_ = os.Remove(filepath.Join(u.opt.StateDir, "candidate.json"))
}

// The marker outlives the updater process. The ordinary Agent only stats it;
// it can never remove it from the root-owned control directory.
func (u *Updater) createFence() error {
	p := u.opt.ExecutionLockPath + ".pending"
	if _, err := os.Lstat(p); err == nil {
		return errors.New("update: pending fence already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return fsyncDir(filepath.Dir(p))
}
func (u *Updater) clearFence() error {
	p := u.opt.ExecutionLockPath + ".pending"
	if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := ValidateRootFile(p); err != nil {
		return err
	}
	if err := os.Remove(p); err != nil {
		return err
	}
	return fsyncDir(filepath.Dir(p))
}
func (u *Updater) clearOrphanFence() error {
	p := u.opt.ExecutionLockPath + ".pending"
	if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	lock, err := runlock.OpenExclusive(u.opt.ExecutionLockPath)
	if err != nil {
		return err
	}
	defer lock.Close()
	return u.clearFence()
}

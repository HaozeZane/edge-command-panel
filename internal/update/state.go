package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// State is the persistent updater schedule and quarantine state. It lives in
// the root-owned transaction directory, never in the agent-writable state
// directory or configuration.
type State struct {
	CurrentVersion    string `json:"currentVersion,omitempty"`
	NextCheck         int64  `json:"nextCheck,omitempty"`
	FailureCount      int    `json:"failureCount,omitempty"`
	LastFailure       string `json:"lastFailure,omitempty"`
	QuarantineVersion string `json:"quarantineVersion,omitempty"`
	QuarantineDigest  string `json:"quarantineDigest,omitempty"`
	QuarantineUntil   int64  `json:"quarantineUntil,omitempty"`
	Blocked           bool   `json:"blocked,omitempty"`
}

// TransactionStage is a durable point in the replace/start/commit sequence.
type TransactionStage string

const (
	StagePreparing  TransactionStage = "preparing"
	StageBackup     TransactionStage = "backup"
	StageReplacing  TransactionStage = "replacing"
	StageReplaced   TransactionStage = "replaced"
	StageStarting   TransactionStage = "starting"
	StageCommitted  TransactionStage = "committed"
	StageRolledBack TransactionStage = "rolled_back"
)

// Transaction describes an in-flight update. It is written atomically before
// every state-changing step so a crash can be recovered at any stage.
type Transaction struct {
	Version        string           `json:"version"`
	Tag            string           `json:"tag"`
	Digest         string           `json:"digest"`
	OldDigest      string           `json:"oldDigest"`
	Stage          TransactionStage `json:"stage"`
	CandidatePath  string           `json:"candidatePath"`
	OldBinaryPath  string           `json:"oldBinaryPath"`
	TargetPath     string           `json:"targetPath"`
	PID            int              `json:"pid,omitempty"`
	RollbackFailed bool             `json:"rollbackFailed,omitempty"`
	CreatedAt      int64            `json:"createdAt"`
}

// EnsureRootDir validates or creates a root-owned directory that is not
// writable by group or other. The final path must not be a symlink.
func EnsureRootDir(path string, mode os.FileMode) error {
	st, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(path, mode); err != nil {
			return fmt.Errorf("update: create directory %s: %w", path, err)
		}
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("update: chmod directory %s: %w", path, err)
		}
		st, err = os.Lstat(path)
	}
	if err != nil {
		return fmt.Errorf("update: stat directory %s: %w", path, err)
	}
	return validateDirStat(path, st, mode)
}

func validateDirStat(path string, st os.FileInfo, mode os.FileMode) error {
	if st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("update: %s is a symlink", path)
	}
	if !st.IsDir() {
		return fmt.Errorf("update: %s is not a directory", path)
	}
	if st.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("update: %s is writable by group or other (%04o)", path, st.Mode().Perm())
	}
	if uid, ok := ownerUID(st); ok && uid != 0 {
		return fmt.Errorf("update: %s is not owned by root (uid %d)", path, uid)
	}
	if st.Mode().Perm()&mode.Perm() != mode.Perm() && mode.Perm()&0o700 != 0 {
		// Do not silently loosen an existing directory; require at least the
		// owner bits we asked for.
		return fmt.Errorf("update: %s permissions %04o are narrower than %04o", path, st.Mode().Perm(), mode.Perm())
	}
	return nil
}

// ValidateRootFile checks an existing key file: regular, root-owned, not
// group/other writable and not a symlink.
func ValidateRootFile(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("update: stat %s: %w", path, err)
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("update: %s is a symlink", path)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("update: %s is not a regular file", path)
	}
	if st.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("update: %s is writable by group or other (%04o)", path, st.Mode().Perm())
	}
	if uid, ok := ownerUID(st); ok && uid != 0 {
		return fmt.Errorf("update: %s is not owned by root (uid %d)", path, uid)
	}
	return nil
}

func ownerUID(st os.FileInfo) (uint32, bool) {
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return sys.Uid, true
}

// ValidateRootDir checks an existing directory that must not be writable by
// group or other and must be owned by root.
func ValidateRootDir(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("update: stat %s: %w", path, err)
	}
	return validateDirStat(path, st, 0o700)
}

// ValidateExecutable checks the installed agent binary before it is replaced.
func ValidateExecutable(path string) error {
	if err := ValidateRootFile(path); err != nil {
		return err
	}
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if st.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("update: %s is not executable", path)
	}
	return nil
}

// LoadState reads state.json, returning a zero state when it does not exist.
func LoadState(dir string) (State, error) {
	path := filepath.Join(dir, "state.json")
	var s State
	data, err := readFileNoFollow(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("update: invalid state: %w", err)
	}
	return s, nil
}

// SaveState atomically replaces state.json.
func SaveState(dir string, s State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("update: encode state: %w", err)
	}
	data = append(data, '\n')
	return writeFileAtomic(filepath.Join(dir, "state.json"), data, 0o600)
}

// LoadTransaction reads transaction.json. A missing file returns nil.
func LoadTransaction(dir string) (*Transaction, error) {
	path := filepath.Join(dir, "transaction.json")
	data, err := readFileNoFollow(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var t Transaction
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("update: invalid transaction: %w", err)
	}
	return &t, nil
}

// SaveTransaction atomically replaces transaction.json.
func SaveTransaction(dir string, t *Transaction) error {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return fmt.Errorf("update: encode transaction: %w", err)
	}
	data = append(data, '\n')
	return writeFileAtomic(filepath.Join(dir, "transaction.json"), data, 0o600)
}

// RemoveTransaction removes the transaction record. The old binary and stage
// are cleaned by the caller only after this succeeds.
func RemoveTransaction(dir string) error {
	if err := os.Remove(filepath.Join(dir, "transaction.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("update: remove transaction: %w", err)
	}
	return fsyncDir(dir)
}

func readFileNoFollow(path string) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, os.ErrNotExist
		}
		return nil, fmt.Errorf("update: open %s: %w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("update: %s is not a regular file", path)
	}
	if uid, ok := ownerUID(st); ok && uid != 0 {
		return nil, fmt.Errorf("update: %s is not owned by root (uid %d)", path, uid)
	}
	if st.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("update: %s is writable by group or other", path)
	}
	return io.ReadAll(f)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := EnsureRootDir(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".update-*.tmp")
	if err != nil {
		return fmt.Errorf("update: create temporary file: %w", err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return fmt.Errorf("update: chmod temporary file: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("update: write temporary file: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("update: sync temporary file: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("update: close temporary file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("update: rename state: %w", err)
	}
	return fsyncDir(dir)
}

func fsyncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("update: open directory: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("update: sync directory: %w", err)
	}
	return nil
}

// CopyFileAtomic copies src to dst (same directory) with fsync and rename.
func CopyFileAtomic(src, dst string, mode os.FileMode) error {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("update: open %s: %w", src, err)
	}
	defer in.Close()
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, ".stage-*.tmp")
	if err != nil {
		return fmt.Errorf("update: create stage: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return fmt.Errorf("update: copy: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("update: sync stage: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("update: rename stage: %w", err)
	}
	return fsyncDir(dir)
}

// WriteExecutableAtomic writes data to dst via a same-directory fsync+rename.
func WriteExecutableAtomic(dst string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(dst)
	f, err := os.CreateTemp(dir, ".stage-*.tmp")
	if err != nil {
		return fmt.Errorf("update: create stage: %w", err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("update: write stage: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("update: sync stage: %w", err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return fmt.Errorf("update: rename stage: %w", err)
	}
	return fsyncDir(dir)
}

// NowMillis is a small helper for state timestamps.
func NowMillis(t time.Time) int64 { return t.UnixMilli() }

// StageExecutable copies src to a unique temporary file in dir (the target
// binary's directory), fsyncs it and returns the staged path. The caller
// renames it over the target and fsyncs dir.
func StageExecutable(src, dir string) (string, error) {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("update: open candidate: %w", err)
	}
	defer in.Close()
	f, err := os.CreateTemp(dir, ".edge-command-agent.new.")
	if err != nil {
		return "", fmt.Errorf("update: create target stage: %w", err)
	}
	name := f.Name()
	if err := f.Chmod(0o755); err != nil {
		f.Close()
		os.Remove(name)
		return "", err
	}
	if _, err := io.Copy(f, in); err != nil {
		f.Close()
		os.Remove(name)
		return "", fmt.Errorf("update: copy target stage: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(name)
		return "", fmt.Errorf("update: sync target stage: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

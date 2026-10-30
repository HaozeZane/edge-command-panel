package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// ParseSHA256SUMS parses the release checksum file strictly. Duplicate,
// malformed or path-like entries are rejected; the caller decides which
// entries are required.
func ParseSHA256SUMS(data []byte) (map[string]string, error) {
	sums := map[string]string{}
	lines := bytes.Split(data, []byte("\n"))
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, errors.New("update: empty SHA256SUMS")
	}
	for i, raw := range lines {
		line := strings.TrimSuffix(string(raw), "\r")
		if line == "" {
			continue
		}
		if len(line) < 67 {
			return nil, fmt.Errorf("update: malformed SHA256SUMS line %d", i+1)
		}
		hash := line[:64]
		if !sha256Pattern.MatchString(hash) {
			return nil, fmt.Errorf("update: malformed SHA256SUMS hash on line %d", i+1)
		}
		rest := line[64:]
		var name string
		switch {
		case strings.HasPrefix(rest, "  "):
			name = rest[2:]
		case strings.HasPrefix(rest, " *"):
			name = rest[2:]
		default:
			return nil, fmt.Errorf("update: malformed SHA256SUMS separator on line %d", i+1)
		}
		if name == "" || name == "." || name == ".." ||
			strings.ContainsAny(name, "/\\\x00\r\n") {
			return nil, fmt.Errorf("update: unsafe SHA256SUMS filename on line %d", i+1)
		}
		if _, exists := sums[name]; exists {
			return nil, fmt.Errorf("update: duplicate SHA256SUMS entry %q", name)
		}
		sums[name] = strings.ToLower(hash)
	}
	if len(sums) == 0 {
		return nil, errors.New("update: SHA256SUMS has no entries")
	}
	return sums, nil
}

// HashFile returns the SHA-256 of path without following a symlink.
func HashFile(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("update: open %s: %w", path, err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("update: hash %s: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyELFArch checks the ELF class, byte order, type and machine. The
// updater only accepts a 64-bit little-endian executable for the requested
// architecture.
func VerifyELFArch(path, arch string) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("update: open candidate: %w", err)
	}
	defer f.Close()
	var hdr [20]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		return fmt.Errorf("update: candidate is not a complete ELF file: %w", err)
	}
	if !bytes.Equal(hdr[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return errors.New("update: candidate is not an ELF file")
	}
	if hdr[4] != 2 {
		return errors.New("update: candidate is not a 64-bit ELF file")
	}
	if hdr[5] != 1 {
		return errors.New("update: candidate is not little-endian")
	}
	etype := binary.LittleEndian.Uint16(hdr[16:18])
	if etype != 2 && etype != 3 { // ET_EXEC or ET_DYN
		return fmt.Errorf("update: candidate ELF type %d is not executable", etype)
	}
	machine := binary.LittleEndian.Uint16(hdr[18:20])
	want := uint16(0)
	switch arch {
	case "amd64":
		want = 62
	case "arm64":
		want = 183
	default:
		return fmt.Errorf("update: unsupported architecture %q", arch)
	}
	if machine != want {
		return fmt.Errorf("update: candidate ELF machine %d, want %d", machine, want)
	}
	return nil
}

// VersionOutput runs the verified candidate with the single fixed argument
// "version". No panel/agent credentials are placed in its environment.
func VersionOutput(ctx context.Context, path string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, path, "version")
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = time.Second
	out := &limitedOutput{limit: 4096}
	cmd.Stdout = out
	cmd.Stderr = out
	err := cmd.Run()
	// Even a leader that exits early may leave descendants holding its pipes.
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err != nil {
		return "", fmt.Errorf("update: candidate version failed: %w", err)
	}
	if out.truncated {
		return "", errors.New("update: candidate version output is too large")
	}
	return strings.TrimSpace(out.buf.String()), nil
}

type limitedOutput struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	original := len(p)
	remaining := w.limit - w.buf.Len()
	if remaining <= 0 {
		w.truncated = true
		return original, nil
	}
	if len(p) > remaining {
		w.truncated = true
		p = p[:remaining]
	}
	_, _ = w.buf.Write(p)
	return original, nil
}

// VerifyCandidateVersion requires the exact version line emitted by this
// project's builds.
func VerifyCandidateVersion(got string, want Version) error {
	fields := strings.Fields(got)
	if len(fields) != 2 || fields[0] != "edge-command-agent" {
		return fmt.Errorf("update: unexpected candidate version output %q", got)
	}
	v, err := ParseVersion(fields[1])
	if err != nil || v.Compare(want) != 0 {
		return fmt.Errorf("update: candidate reports %q, want %s", fields[1], want)
	}
	return nil
}

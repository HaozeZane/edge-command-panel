// Package config loads and writes the agent configuration.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

const (
	// DefaultPath is the production configuration path.
	DefaultPath = "/etc/edge-command-agent/config.json"
	// DefaultStateDir is used when stateDir is omitted; install.sh always
	// writes an explicit /var/lib/edge-command-agent path.
	DefaultStateDirName = ".edge-command-agent"
)

// Config is the on-disk JSON configuration. The secret is only ever read from
// a 0600 file or from the environment during enrollment; it is never accepted
// on the command line.
type Config struct {
	URL          string `json:"url"`
	AgentID      string `json:"agentId"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	StateDir     string `json:"stateDir,omitempty"`
}

// Load reads and validates a configuration file. The file must not be
// readable or writable by group/other.
func Load(path string) (*Config, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("config: not a regular file")
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("config: permissions %04o are too open (want 0600)", st.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("config: invalid JSON: %w", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// Validate checks required fields and constrains insecure WebSocket schemes to
// loopback development addresses.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.URL) == "" {
		return errors.New("config: url is required")
	}
	if strings.TrimSpace(c.AgentID) == "" {
		return errors.New("config: agentId is required")
	}
	if strings.TrimSpace(c.ClientID) == "" {
		return errors.New("config: clientId is required")
	}
	if c.ClientSecret == "" {
		return errors.New("config: clientSecret is required")
	}
	if strings.ContainsAny(c.AgentID, "\r\n\x00") || strings.ContainsAny(c.ClientID, "\r\n\x00") || strings.ContainsAny(c.ClientSecret, "\r\n\x00") {
		return errors.New("config: credentials must not contain control characters")
	}
	u, err := NormalizeURL(c.URL)
	if err != nil {
		return err
	}
	c.URL = u
	if c.StateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			if u, uerr := user.Current(); uerr == nil {
				home = u.HomeDir
			}
		}
		if home == "" {
			return errors.New("config: stateDir is required when home directory is unavailable")
		}
		c.StateDir = filepath.Join(home, DefaultStateDirName)
	}
	if !filepath.IsAbs(c.StateDir) {
		return errors.New("config: stateDir must be an absolute path")
	}
	return nil
}

// NormalizeURL converts https/http to wss/ws and rejects plaintext transports
// for non-loopback hosts.
func NormalizeURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("config: invalid url: %w", err)
	}
	if u.Host == "" {
		return "", errors.New("config: url must include a host")
	}
	if u.User != nil {
		return "", errors.New("config: url must not contain userinfo")
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss":
	case "ws":
	default:
		return "", fmt.Errorf("config: unsupported url scheme %q", u.Scheme)
	}
	if u.Scheme == "ws" && !IsLoopbackHost(u.Hostname()) {
		return "", errors.New("config: plaintext ws is only allowed for loopback hosts; use wss")
	}
	return u.String(), nil
}

// IsLoopbackHost reports whether host is a loopback name or address.
func IsLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// WriteAtomic writes c as 0600 JSON, fsyncs the file and renames it into place.
func WriteAtomic(path string, c *Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("config: create directory: %w", err)
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("config: create temporary file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("config: chmod: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("config: write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("config: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("config: rename: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("config: chmod: %w", err)
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Redacted returns a log-safe description. The secret is never included.
func (c *Config) Redacted() string {
	return fmt.Sprintf("url=%s agentId=%s clientId=%s stateDir=%s", c.URL, c.AgentID, c.ClientID, c.StateDir)
}

// AgentWSURL turns the shared panel base URL into the full agent WebSocket
// URL. ECP_URL is intentionally a base URL (install.sh appends
// /agent/download/...), so direct mode must derive /agent/ws here. A value
// that is already a full /agent/ws URL is accepted unchanged.
func AgentWSURL(base string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Host == "" {
		return "", errors.New("config: invalid ECP_URL")
	}
	p := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(p, "/agent/ws") {
		p += "/agent/ws"
	}
	u.Path = p
	u.RawPath = ""
	return NormalizeURL(u.String())
}

// FromEnv builds a direct-mode config from ECP_* environment variables.
func FromEnv() (*Config, error) {
	base := strings.TrimSpace(os.Getenv("ECP_URL"))
	if base == "" {
		return nil, errors.New("ECP_URL is required")
	}
	agentID := strings.TrimSpace(os.Getenv("ECP_AGENT_ID"))
	if agentID == "" {
		return nil, errors.New("ECP_AGENT_ID is required for direct mode")
	}
	wsURL, err := AgentWSURL(base)
	if err != nil {
		return nil, err
	}
	c := &Config{
		URL:          wsURL,
		AgentID:      agentID,
		ClientID:     os.Getenv("ECP_CLIENT_ID"),
		ClientSecret: os.Getenv("ECP_CLIENT_SECRET"),
	}
	if c.ClientID == "" || c.ClientSecret == "" {
		return nil, errors.New("ECP_CLIENT_ID and ECP_CLIENT_SECRET are required")
	}
	return c, nil
}

// RandomID returns a hex identifier suitable for bootId.
func RandomID(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// UUID returns a random RFC 4122 version 4 UUID.
func UUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

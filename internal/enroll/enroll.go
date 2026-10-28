// Package enroll implements the one-time installation enrollment flow.
package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"edge-command-agent/internal/config"
)

// Options contains the enrollment inputs. Secrets come from the environment
// (never argv) and are only used as CF-Access headers.
type Options struct {
	ConfigPath   string
	StateDir     string
	BaseURL      string
	ClientID     string
	ClientSecret string
	HTTPClient   *http.Client
	Attempts     int
	RetryDelay   time.Duration
}

type installation struct {
	InstallationID string `json:"installationId"`
	PublicKey      string `json:"publicKey"`
	PrivateKey     string `json:"privateKey"`
}

type challengeResponse struct {
	Challenge string `json:"challenge"`
	ExpiresAt int64  `json:"expiresAt"`
}

type registerResponse struct {
	AgentID      string `json:"agentId"`
	URL          string `json:"url"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// Run registers this machine once and writes the final 0600 config. A valid
// existing config is reused without contacting the panel.
func Run(ctx context.Context, opt Options) (*config.Config, error) {
	if opt.ConfigPath == "" || opt.StateDir == "" {
		return nil, errors.New("enroll: config and state-dir are required")
	}
	if existing, err := config.Load(opt.ConfigPath); err == nil {
		return existing, nil
	}
	base, err := validateBaseURL(opt.BaseURL)
	if err != nil {
		return nil, err
	}
	if opt.ClientID == "" || opt.ClientSecret == "" {
		return nil, errors.New("enroll: ECP_CLIENT_ID and ECP_CLIENT_SECRET are required")
	}
	client := opt.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	if opt.Attempts <= 0 {
		opt.Attempts = 3
	}
	if opt.RetryDelay <= 0 {
		opt.RetryDelay = time.Second
	}
	inst, err := loadOrCreateInstallation(opt.StateDir)
	if err != nil {
		return nil, err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return nil, fmt.Errorf("enroll: hostname: %w", err)
	}
	priv, err := decodePrivate(inst.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("enroll: installation key: %w", err)
	}
	var lastErr error
	for attempt := 0; attempt < opt.Attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(opt.RetryDelay):
			}
		}
		ch, err := requestChallenge(ctx, client, base, opt, inst)
		if err != nil {
			lastErr = err
			continue
		}
		if ch.ExpiresAt > 0 && time.Now().UnixMilli() > ch.ExpiresAt {
			lastErr = errors.New("enroll: challenge already expired")
			continue
		}
		msg := strings.Join([]string{"ECP-ENROLL-V1", ch.Challenge, inst.InstallationID, hostname, inst.PublicKey}, "\n")
		sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(msg)))
		resp, err := register(ctx, client, base, opt, inst, hostname, ch.Challenge, sig)
		if err != nil {
			lastErr = err
			continue
		}
		cfg := &config.Config{
			URL: resp.URL, AgentID: resp.AgentID, ClientID: resp.ClientID,
			ClientSecret: resp.ClientSecret, StateDir: opt.StateDir,
		}
		if err := config.WriteAtomic(opt.ConfigPath, cfg); err != nil {
			return nil, err
		}
		return cfg, nil
	}
	if lastErr == nil {
		lastErr = errors.New("enroll: failed")
	}
	return nil, lastErr
}

func validateBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", errors.New("enroll: ECP_URL is invalid")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && config.IsLoopbackHost(u.Hostname())) {
		return "", errors.New("enroll: ECP_URL must use https (http only for loopback development)")
	}
	return strings.TrimRight(raw, "/"), nil
}

func loadOrCreateInstallation(dir string) (*installation, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("enroll: create state dir: %w", err)
	}
	path := filepath.Join(dir, "installation.json")
	if st, err := os.Stat(path); err == nil {
		if st.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("enroll: %s permissions are too open (want 0600)", path)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var inst installation
		if err := json.Unmarshal(b, &inst); err != nil {
			return nil, fmt.Errorf("enroll: corrupt installation identity: %w", err)
		}
		if inst.InstallationID == "" || inst.PublicKey == "" || inst.PrivateKey == "" {
			return nil, errors.New("enroll: incomplete installation identity")
		}
		return &inst, nil
	}
	id, err := config.UUID()
	if err != nil {
		return nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	inst := &installation{
		InstallationID: id,
		PublicKey:      base64.StdEncoding.EncodeToString(pub),
		PrivateKey:     base64.StdEncoding.EncodeToString(priv.Seed()),
	}
	if err := writeJSON0600(path, inst); err != nil {
		return nil, err
	}
	return inst, nil
}

func decodePrivate(s string) (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, errors.New("invalid seed length")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func writeJSON0600(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".installation-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func requestChallenge(ctx context.Context, client *http.Client, base string, opt Options, inst *installation) (*challengeResponse, error) {
	payload := map[string]string{
		"installationId": inst.InstallationID,
		"publicKey":      inst.PublicKey,
	}
	var out challengeResponse
	if err := postJSON(ctx, client, base+"/enroll/challenge", opt, payload, &out); err != nil {
		return nil, err
	}
	if out.Challenge == "" {
		return nil, errors.New("enroll: panel returned an empty challenge")
	}
	return &out, nil
}

func register(ctx context.Context, client *http.Client, base string, opt Options, inst *installation, hostname, challenge, sig string) (*registerResponse, error) {
	payload := map[string]string{
		"installationId": inst.InstallationID,
		"hostname":       hostname,
		"publicKey":      inst.PublicKey,
		"challenge":      challenge,
		"signature":      sig,
	}
	var out registerResponse
	if err := postJSON(ctx, client, base+"/enroll/register", opt, payload, &out); err != nil {
		return nil, err
	}
	if out.AgentID == "" || out.URL == "" || out.ClientID == "" || out.ClientSecret == "" {
		return nil, errors.New("enroll: incomplete registration response")
	}
	return &out, nil
}

func postJSON(ctx context.Context, client *http.Client, url string, opt Options, payload any, out any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("CF-Access-Client-Id", opt.ClientID)
	req.Header.Set("CF-Access-Client-Secret", opt.ClientSecret)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("enroll: request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("enroll: panel returned HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(out); err != nil {
		return fmt.Errorf("enroll: invalid panel response: %w", err)
	}
	return nil
}

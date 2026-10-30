package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type panelState struct {
	mu            sync.Mutex
	installation  string
	publicKey     string
	challenges    []string
	signatures    []string
	challengeHits int
	registerHits  int
	failFirst     bool
}

func (p *panelState) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/enroll/challenge", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Id") != "one-id" || r.Header.Get("CF-Access-Client-Secret") != "one-secret" {
			http.Error(w, "bad auth", http.StatusUnauthorized)
			return
		}
		var body struct {
			InstallationID string `json:"installationId"`
			PublicKey      string `json:"publicKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		p.mu.Lock()
		if p.installation == "" {
			p.installation = body.InstallationID
			p.publicKey = body.PublicKey
		} else if p.installation != body.InstallationID || p.publicKey != body.PublicKey {
			p.mu.Unlock()
			http.Error(w, "identity changed", http.StatusConflict)
			return
		}
		ch := "challenge-" + string(rune('a'+p.challengeHits))
		p.challengeHits++
		p.challenges = append(p.challenges, ch)
		p.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"challenge": ch, "expiresAt": time.Now().Add(time.Minute).UnixMilli()})
	})
	mux.HandleFunc("/enroll/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Id") != "one-id" || r.Header.Get("CF-Access-Client-Secret") != "one-secret" {
			http.Error(w, "bad auth", http.StatusUnauthorized)
			return
		}
		var body struct {
			InstallationID string `json:"installationId"`
			Hostname       string `json:"hostname"`
			PublicKey      string `json:"publicKey"`
			Challenge      string `json:"challenge"`
			Signature      string `json:"signature"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		p.mu.Lock()
		p.registerHits++
		fail := p.failFirst && p.registerHits == 1
		installation := p.installation
		p.signatures = append(p.signatures, body.Signature)
		p.mu.Unlock()
		if fail {
			http.Error(w, "try again", http.StatusInternalServerError)
			return
		}
		if body.InstallationID != installation {
			http.Error(w, "unknown installation", http.StatusBadRequest)
			return
		}
		pub, err := base64.StdEncoding.DecodeString(body.PublicKey)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			http.Error(w, "bad key", http.StatusBadRequest)
			return
		}
		sig, err := base64.StdEncoding.DecodeString(body.Signature)
		if err != nil {
			http.Error(w, "bad sig", http.StatusBadRequest)
			return
		}
		host, _ := os.Hostname()
		if body.Hostname != host {
			http.Error(w, "bad hostname", http.StatusBadRequest)
			return
		}
		msg := strings.Join([]string{"ECP-ENROLL-V1", body.Challenge, body.InstallationID, body.Hostname, body.PublicKey}, "\n")
		if !ed25519.Verify(ed25519.PublicKey(pub), []byte(msg), sig) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agentId": "agent-42", "url": "https://127.0.0.1/agent/ws",
			"clientId": "ws-id", "clientSecret": "ws-secret",
		})
	})
	return mux
}

func opts(srvURL, cfg, state string) Options {
	return Options{
		ConfigPath: cfg, StateDir: state, BaseURL: srvURL,
		ClientID: "one-id", ClientSecret: "one-secret",
		Attempts: 3, RetryDelay: 5 * time.Millisecond,
	}
}

func TestEnrollSignatureAndReuse(t *testing.T) {
	ps := &panelState{}
	srv := httptest.NewServer(ps.handler(t))
	defer srv.Close()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "etc", "config.json")
	stateDir := filepath.Join(dir, "state")
	cfg, err := Run(context.Background(), opts(srv.URL, cfgPath, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentID != "agent-42" || cfg.URL != "wss://127.0.0.1/agent/ws" || cfg.ClientID != "ws-id" || cfg.ClientSecret != "ws-secret" {
		t.Fatalf("config = %+v", cfg)
	}
	if st, err := os.Stat(cfgPath); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("config mode: %v %v", st, err)
	}
	if st, err := os.Stat(filepath.Join(stateDir, "installation.json")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("installation mode: %v %v", st, err)
	}
	ps.mu.Lock()
	hits := ps.challengeHits
	ps.mu.Unlock()

	// A second enroll must reuse the valid config without registering again.
	cfg2, err := Run(context.Background(), opts(srv.URL, cfgPath, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.AgentID != cfg.AgentID {
		t.Fatalf("reuse agentId = %s", cfg2.AgentID)
	}
	ps.mu.Lock()
	if ps.challengeHits != hits {
		t.Fatalf("expected no new challenge, got %d -> %d", hits, ps.challengeHits)
	}
	ps.mu.Unlock()
}

func TestEnrollRetriesWithNewChallengeSameKey(t *testing.T) {
	ps := &panelState{failFirst: true}
	srv := httptest.NewServer(ps.handler(t))
	defer srv.Close()
	dir := t.TempDir()
	cfg, err := Run(context.Background(), opts(srv.URL, filepath.Join(dir, "config.json"), filepath.Join(dir, "state")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentID != "agent-42" {
		t.Fatalf("config = %+v", cfg)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.challengeHits != 2 || ps.registerHits != 2 {
		t.Fatalf("hits challenge=%d register=%d", ps.challengeHits, ps.registerHits)
	}
	if ps.challenges[0] == ps.challenges[1] {
		t.Fatal("retry reused the old challenge")
	}
}

func TestEnrollRequiresHTTPSExceptLoopback(t *testing.T) {
	dir := t.TempDir()
	_, err := Run(context.Background(), Options{
		ConfigPath: filepath.Join(dir, "c.json"), StateDir: filepath.Join(dir, "s"),
		BaseURL: "http://panel.example", ClientID: "i", ClientSecret: "s",
	})
	if err == nil {
		t.Fatal("expected https enforcement error")
	}
}

func TestEnrollReusePreservesConfigIdentityAndJournal(t *testing.T) {
	ps := &panelState{}
	srv := httptest.NewServer(ps.handler(t))
	defer srv.Close()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "etc", "config.json")
	stateDir := filepath.Join(dir, "state")

	cfg, err := Run(context.Background(), opts(srv.URL, cfgPath, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	configBefore, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	identityPath := filepath.Join(stateDir, "installation.json")
	identityBefore, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(stateDir, "runs", "run-keep.jsonl")
	if err := os.MkdirAll(filepath.Dir(journalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	journalBefore := []byte("{\"event\":\"keep\"}\n")
	if err := os.WriteFile(journalPath, journalBefore, 0o600); err != nil {
		t.Fatal(err)
	}

	ps.mu.Lock()
	hits := ps.challengeHits
	registers := ps.registerHits
	ps.mu.Unlock()

	cfg2, err := Run(context.Background(), opts(srv.URL, cfgPath, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.AgentID != cfg.AgentID || cfg2.ClientSecret != cfg.ClientSecret {
		t.Fatalf("reused config changed: %+v -> %+v", cfg, cfg2)
	}
	if got, err := os.ReadFile(cfgPath); err != nil || !bytes.Equal(got, configBefore) {
		t.Fatalf("config was rewritten on reuse: %v", err)
	}
	if got, err := os.ReadFile(identityPath); err != nil || !bytes.Equal(got, identityBefore) {
		t.Fatalf("installation identity changed on reuse: %v", err)
	}
	if got, err := os.ReadFile(journalPath); err != nil || !bytes.Equal(got, journalBefore) {
		t.Fatalf("journal changed on reuse: %v", err)
	}
	ps.mu.Lock()
	if ps.challengeHits != hits || ps.registerHits != registers {
		t.Fatalf("valid config reuse consumed enrollment quota: challenge %d -> %d, register %d -> %d",
			hits, ps.challengeHits, registers, ps.registerHits)
	}
	ps.mu.Unlock()
}

func TestEnrollRefusesUnsafeExistingConfigWithoutNetwork(t *testing.T) {
	valid := []byte(`{"url":"https://panel.example/agent/ws","agentId":"a","clientId":"i","clientSecret":"s","stateDir":"/var/lib/edge-command-agent"}` + "\n")

	cases := []struct {
		name  string
		setup func(t *testing.T, dir, cfgPath string)
	}{
		{"corrupt_json", func(t *testing.T, dir, cfgPath string) {
			t.Helper()
			if err := os.WriteFile(cfgPath, []byte("{not-json"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"too_permissive", func(t *testing.T, dir, cfgPath string) {
			t.Helper()
			if err := os.WriteFile(cfgPath, valid, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(cfgPath, 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"directory", func(t *testing.T, dir, cfgPath string) {
			t.Helper()
			if err := os.Mkdir(cfgPath, 0o700); err != nil {
				t.Fatal(err)
			}
		}},
		{"dangling_symlink", func(t *testing.T, dir, cfgPath string) {
			t.Helper()
			if err := os.Symlink(filepath.Join(dir, "missing.json"), cfgPath); err != nil {
				t.Fatal(err)
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := &panelState{}
			srv := httptest.NewServer(ps.handler(t))
			defer srv.Close()
			dir := t.TempDir()
			cfgPath := filepath.Join(dir, "config.json")
			stateDir := filepath.Join(dir, "state")
			tc.setup(t, dir, cfgPath)

			before, err := os.Lstat(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			var beforeBytes []byte
			if before.Mode().IsRegular() {
				beforeBytes, err = os.ReadFile(cfgPath)
				if err != nil {
					t.Fatal(err)
				}
			}

			if _, err := Run(context.Background(), opts(srv.URL, cfgPath, stateDir)); err == nil {
				t.Fatal("expected existing config to be rejected")
			}
			ps.mu.Lock()
			challenges, registers := ps.challengeHits, ps.registerHits
			ps.mu.Unlock()
			if challenges != 0 || registers != 0 {
				t.Fatalf("unsafe config triggered network registration: challenge=%d register=%d", challenges, registers)
			}

			after, err := os.Lstat(cfgPath)
			if err != nil {
				t.Fatalf("config path was removed: %v", err)
			}
			if before.Mode() != after.Mode() {
				t.Fatalf("config path mode changed: %v -> %v", before.Mode(), after.Mode())
			}
			if beforeBytes != nil {
				got, err := os.ReadFile(cfgPath)
				if err != nil || !bytes.Equal(got, beforeBytes) {
					t.Fatalf("unsafe config was overwritten: %v", err)
				}
			}
			if before.Mode()&os.ModeSymlink != 0 {
				if target, err := os.Readlink(cfgPath); err != nil || target != filepath.Join(dir, "missing.json") {
					t.Fatalf("config symlink was replaced: %q, %v", target, err)
				}
			}
			if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
				t.Fatalf("state directory was created despite config rejection: %v", err)
			}
		})
	}
}

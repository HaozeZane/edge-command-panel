package enroll

import (
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

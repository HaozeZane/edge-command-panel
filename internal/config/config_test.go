package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeURL(t *testing.T) {
	cases := []struct {
		in      string
		out     string
		wantErr bool
	}{
		{"https://panel.example/agent/ws", "wss://panel.example/agent/ws", false},
		{"wss://panel.example/agent/ws", "wss://panel.example/agent/ws", false},
		{"http://127.0.0.1:8787/agent/ws", "ws://127.0.0.1:8787/agent/ws", false},
		{"ws://localhost/agent/ws", "ws://localhost/agent/ws", false},
		{"ws://[::1]/agent/ws", "ws://[::1]/agent/ws", false},
		{"http://panel.example/agent/ws", "", true},
		{"ws://10.0.0.1/agent/ws", "", true},
		{"ftp://panel.example/agent/ws", "", true},
		{"https://user:pass@panel.example/agent/ws", "", true},
	}
	for _, c := range cases {
		got, err := NormalizeURL(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: expected error, got %s", c.in, got)
			}
			continue
		}
		if err != nil || got != c.out {
			t.Errorf("%s: got %q, %v; want %q", c.in, got, err, c.out)
		}
	}
}

func TestAgentWSURL(t *testing.T) {
	cases := map[string]string{
		"https://panel.domain":          "wss://panel.domain/agent/ws",
		"https://panel.domain/":         "wss://panel.domain/agent/ws",
		"https://panel.domain/base":     "wss://panel.domain/base/agent/ws",
		"https://panel.domain/agent/ws": "wss://panel.domain/agent/ws",
		"wss://panel.domain/agent/ws/":  "wss://panel.domain/agent/ws",
		"http://127.0.0.1:8788":         "ws://127.0.0.1:8788/agent/ws",
	}
	for in, want := range cases {
		got, err := AgentWSURL(in)
		if err != nil || got != want {
			t.Errorf("AgentWSURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := AgentWSURL("not a url"); err == nil {
		t.Error("expected invalid base URL error")
	}
}

func TestInvalidConfigs(t *testing.T) {
	valid := Config{URL: "wss://panel.example/agent/ws", AgentID: "a", ClientID: "c", ClientSecret: "s", StateDir: "/tmp/state"}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := []Config{
		{},
		{URL: "ws://panel.example/agent/ws", AgentID: "a", ClientID: "c", ClientSecret: "s"},
		{URL: "wss://panel.example/agent/ws", AgentID: "", ClientID: "c", ClientSecret: "s"},
		{URL: "wss://panel.example/agent/ws", AgentID: "a", ClientID: "c"},
		{URL: "wss://panel.example/agent/ws", AgentID: "a", ClientID: "c", ClientSecret: "s", StateDir: "relative"},
		{URL: "wss://panel.example/agent/ws", AgentID: "a", ClientID: "c", ClientSecret: "s\nx"},
	}
	for i, c := range bad {
		if err := c.Validate(); err == nil {
			t.Errorf("case %d: expected invalid", i)
		}
	}
}

func TestLoadRejectsOpenPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	c := &Config{URL: "https://panel.example/agent/ws", AgentID: "a", ClientID: "c", ClientSecret: "s", StateDir: "/tmp/x"}
	b, _ := json.Marshal(c)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected permission error")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "wss://panel.example/agent/ws" {
		t.Fatalf("url = %s", got.URL)
	}
}

func TestWriteAtomicSpecialCharacters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	c := &Config{
		URL:          "https://panel.example/agent/ws",
		AgentID:      "agent-1",
		ClientID:     "id-\"quoted\"",
		ClientSecret: `s3cr3t$"with\backslash'and spaces & <tags>`,
		StateDir:     filepath.Join(dir, "state"),
	}
	if err := WriteAtomic(path, c); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %04o", st.Mode().Perm())
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.ClientSecret != c.ClientSecret || got.ClientID != c.ClientID {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("ECP_URL", "https://panel.example")
	t.Setenv("ECP_AGENT_ID", "agent-9")
	t.Setenv("ECP_CLIENT_ID", "cid")
	t.Setenv("ECP_CLIENT_SECRET", "sec")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.AgentID != "agent-9" || c.ClientSecret != "sec" {
		t.Fatalf("config = %+v", c)
	}
	if c.URL != "wss://panel.example/agent/ws" {
		t.Fatalf("direct URL = %q, want full agent endpoint", c.URL)
	}
	t.Setenv("ECP_URL", "https://panel.example/agent/ws")
	c2, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c2.URL != "wss://panel.example/agent/ws" {
		t.Fatalf("full URL doubled: %q", c2.URL)
	}
	red := c.Redacted()
	if strings.Contains(red, "sec") {
		t.Fatalf("redacted string leaks secret: %s", red)
	}
}

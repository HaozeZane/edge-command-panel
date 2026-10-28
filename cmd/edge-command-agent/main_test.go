package main

import (
	"os"
	"path/filepath"
	"testing"

	"edge-command-agent/internal/config"
)

func TestConfigureSpecialCharacters(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "etc", "config.json")
	stateDir := filepath.Join(dir, "state")
	secret := `p@ss"word$with\backslash 'quote' & <tag>`
	t.Setenv("ECP_URL", "https://panel.example")
	t.Setenv("ECP_AGENT_ID", "agent-special")
	t.Setenv("ECP_CLIENT_ID", `id"with$dollar`)
	t.Setenv("ECP_CLIENT_SECRET", secret)
	if err := runConfigure([]string{"-config", cfgPath, "-state-dir", stateDir}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %04o", st.Mode().Perm())
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClientSecret != secret || cfg.ClientID != `id"with$dollar` {
		t.Fatalf("round trip = %+v", cfg)
	}
	if cfg.URL != "wss://panel.example/agent/ws" || cfg.StateDir != stateDir {
		t.Fatalf("config = %+v", cfg)
	}
}

func TestConfigureRejectsMissingAgentID(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ECP_URL", "https://panel.example")
	t.Setenv("ECP_AGENT_ID", "")
	t.Setenv("ECP_CLIENT_ID", "id")
	t.Setenv("ECP_CLIENT_SECRET", "secret")
	if err := runConfigure([]string{"-config", filepath.Join(dir, "c.json"), "-state-dir", dir}); err == nil {
		t.Fatal("expected missing agent id error")
	}
}

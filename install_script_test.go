package agent_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallScriptSyntaxAndGuards(t *testing.T) {
	path := "install.sh"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	if strings.HasPrefix(script, "#!/bin/sh") == false {
		t.Fatal("install.sh must use /bin/sh")
	}
	for _, shell := range []string{"sh", "bash"} {
		if _, err := exec.LookPath(shell); err != nil {
			continue
		}
		cmd := exec.Command(shell, "-n", path)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s -n: %v\n%s", shell, err, out)
		}
	}
	required := []string{
		"set -eu", "umask 077", "NoNewPrivileges=yes", "ProtectSystem=strict",
		"PrivateTmp=yes", "KillMode=control-group", "Restart=always",
		"User=$TARGET_USER", "Group=$TARGET_GROUP",
		"WorkingDirectory=~", "Environment=\"HOME=$HOME_ESCAPED\"",
		"ReadWritePaths=$STATE_DIR", "CF-Access-Client-Id",
		"CF-Access-Client-Secret", `-H "@$HEADER_FILE"`, "chmod 600",
		"edge-command-agent.service", "--no-start", "systemctl is-active",
		"systemctl stop", "systemctl show", "ActiveState", "chown -h",
		"ECP_MODE", "ECP_AGENT_ID", "SUDO_USER", "SUDO_UID",
		"getent passwd", "id -u", "id -g", "TARGET_HOME", "unit_escape",
		`configure -config "$CONFIG_PATH" -state-dir "$STATE_DIR"`,
		`enroll -config "$CONFIG_PATH" -state-dir "$STATE_DIR"`,
		"did not become active",
	}
	for _, want := range required {
		if !strings.Contains(script, want) {
			t.Errorf("install.sh missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"set -x", "envsubst", "jq ", "python", "sudoers",
		"useradd", "groupadd", "groupdel", "userdel", "SERVICE_USER=",
		"chown -R", "chown --recursive",
	} {
		if strings.Contains(script, forbidden) {
			t.Errorf("install.sh must not contain %q", forbidden)
		}
	}
	// Secrets must not be supplied via a process argument.
	if strings.Contains(script, `-H "CF-Access-Client-Secret:`) {
		t.Error("secret passed on the curl command line")
	}
	if strings.Contains(script, "ECP_CLIENT_SECRET=") && !strings.Contains(script, "ECP_CLIENT_SECRET:-") {
		t.Error("install.sh must only read ECP_CLIENT_SECRET from the environment")
	}
	if filepath.Base(path) != "install.sh" {
		t.Fatal("unexpected path")
	}
}

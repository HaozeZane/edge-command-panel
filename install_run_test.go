package agent_test

import (
	"bytes"
	"edge-command-agent/internal/runlock"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const (
	prodConfigDir = "/etc/edge-command-agent"
	prodStateDir  = "/var/lib/edge-command-agent"
	prodBinPath   = "/usr/local/bin/edge-command-agent"
	prodUnitPath  = "/etc/systemd/system/edge-command-agent.service"
)

// installSandbox runs a copy of install.sh with every production path moved
// under .paseo-scratch. Only the copy is executed, and a mocked PATH provides
// id, getent, systemctl, curl, install and chown, so the host's accounts,
// systemd, network and /etc or /var/lib are never touched.
type installSandbox struct {
	t *testing.T

	root       string
	scriptPath string
	mockBin    string
	eventLog   string
	serviceDir string
	tmpDir     string
	rootHome   string
	aliceHome  string

	configDir  string
	configPath string
	stateDir   string
	binPath    string
	unitPath   string

	env map[string]string
}

func newInstallSandbox(t *testing.T) *installSandbox {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(wd, ".paseo-scratch", "tmp")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "install-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	s := &installSandbox{
		t:          t,
		root:       root,
		mockBin:    filepath.Join(root, "mockbin"),
		eventLog:   filepath.Join(root, "events.log"),
		serviceDir: filepath.Join(root, "systemd"),
		tmpDir:     filepath.Join(root, "tmp"),
		rootHome:   filepath.Join(root, "home", "root"),
		aliceHome:  filepath.Join(root, "home", "alice"),
		configDir:  filepath.Join(root, "etc", "edge-command-agent"),
		stateDir:   filepath.Join(root, "var", "lib", "edge-command-agent"),
		binPath:    filepath.Join(root, "usr", "local", "bin", "edge-command-agent"),
		unitPath:   filepath.Join(root, "etc", "systemd", "system", "edge-command-agent.service"),
		env:        map[string]string{},
	}
	s.configPath = filepath.Join(s.configDir, "config.json")

	for _, dir := range []string{
		s.mockBin, s.serviceDir, s.tmpDir, s.rootHome, s.aliceHome,
		filepath.Dir(s.binPath), filepath.Dir(s.unitPath), filepath.Dir(s.stateDir), filepath.Join(root, "usr", "local", "lib"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Model production's root-owned 0755 /usr, /var and /etc ancestors;
	// this workspace intentionally inherits a shared group-write umask.
	if err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && path != root {
			return os.Chmod(path, 0755)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"id":        idMock,
		"stat":      statMock,
		"getent":    getentMock,
		"systemctl": systemctlMock,
		"curl":      curlMock,
		"install":   installMock,
		"chown":     chownMock,
		"useradd":   unexpectedMock("useradd"),
		"groupadd":  unexpectedMock("groupadd"),
		"userdel":   unexpectedMock("userdel"),
		"groupdel":  unexpectedMock("groupdel"),
	} {
		if err := os.WriteFile(filepath.Join(s.mockBin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	script, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatal(err)
	}
	replacer := strings.NewReplacer(
		prodUnitPath, s.unitPath,
		"/usr/local/lib/edge-command-agent", filepath.Join(root, "usr", "local", "lib", "edge-command-agent"),
		prodConfigDir, s.configDir,
		prodStateDir, s.stateDir,
		prodBinPath, s.binPath,
	)
	copied := replacer.Replace(string(script))
	for _, forbidden := range []string{"CONFIG_DIR=/etc/", "STATE_DIR=/var/lib/", "BIN_PATH=/usr/local/", "UNIT_PATH=/etc/systemd/"} {
		if strings.Contains(copied, forbidden) {
			t.Fatalf("test copy still contains production assignment %q", forbidden)
		}
	}
	s.scriptPath = filepath.Join(root, "install.sh")
	if err := os.WriteFile(s.scriptPath, []byte(copied), 0o755); err != nil {
		t.Fatal(err)
	}

	s.env = map[string]string{
		"MOCK_ROOT":          s.root,
		"PATH":               s.mockBin + ":/usr/bin:/bin",
		"TMPDIR":             s.tmpDir,
		"HOME":               filepath.Join(root, "inherited-home"),
		"ECP_URL":            "https://panel.example",
		"ECP_CLIENT_ID":      "test-id",
		"ECP_CLIENT_SECRET":  "test-secret",
		"ECP_MODE":           "enroll",
		"MOCK_EVENT_LOG":     s.eventLog,
		"MOCK_SERVICE_STATE": s.serviceDir,
		"MOCK_ROOT_HOME":     s.rootHome,
		"MOCK_ALICE_HOME":    s.aliceHome,
		"MOCK_ALICE_UID":     "4242",
		"MOCK_ALICE_GID":     "4242",
		"MOCK_EUID":          "0",
	}
	return s
}

func unexpectedMock(name string) string {
	return "#!/bin/sh\nprintf 'UNEXPECTED " + name + " %s\\n' \"$*\" >> \"$MOCK_EVENT_LOG\"\nexit 99\n"
}

func (s *installSandbox) run(args []string, overrides map[string]string) (stdout, stderr string, err error) {
	s.t.Helper()
	env := make(map[string]string, len(s.env)+len(overrides))
	for k, v := range s.env {
		env[k] = v
	}
	for k, v := range overrides {
		env[k] = v
	}
	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, k+"="+v)
	}

	cmd := exec.Command("/bin/sh", append([]string{s.scriptPath}, args...)...)
	cmd.Dir = s.root
	cmd.Env = envList
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err = cmd.Run()
	return out.String(), errOut.String(), err
}

func (s *installSandbox) events() []string {
	s.t.Helper()
	data, err := os.ReadFile(s.eventLog)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		s.t.Fatal(err)
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func (s *installSandbox) readUnit() string {
	s.t.Helper()
	data, err := os.ReadFile(s.unitPath)
	if err != nil {
		s.t.Fatal(err)
	}
	return string(data)
}

func (s *installSandbox) write(path string, data []byte, mode os.FileMode) {
	s.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		s.t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		s.t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		s.t.Fatal(err)
	}
}

func (s *installSandbox) seed(Active bool) {
	s.t.Helper()
	s.write(s.configPath, []byte("{\"url\":\"wss://old.example/agent/ws\",\"agentId\":\"old-agent\",\"clientId\":\"old-id\",\"clientSecret\":\"old-secret\"}\n"), 0o600)
	s.write(s.binPath, []byte("old binary\n"), 0o755)
	s.write(s.unitPath, []byte("[Service]\nUser=edge-command\nExecStart=agent -execution-lock "+s.stateDir+"-lock/execution.lock\n"), 0o644)
	s.write(filepath.Join(s.stateDir, "installation.json"), []byte("{\"installationId\":\"keep-me\",\"publicKey\":\"pub\",\"privateKey\":\"priv\"}\n"), 0o600)
	s.write(filepath.Join(s.stateDir, "runs", "run-1.jsonl"), []byte("{\"event\":\"kept\"}\n"), 0o600)
	if Active {
		s.write(filepath.Join(s.serviceDir, "active"), []byte("1"), 0o644)
		s.write(filepath.Join(s.serviceDir, "enabled"), []byte("1"), 0o644)
	}
}

func requireNoError(t *testing.T, stdout, stderr string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("install failed: %v\nstdout:\n%s\nstderr:\n%s\nevents:\n%s", err, stdout, stderr, "see test")
	}
}

func requireContains(t *testing.T, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Fatalf("missing %q in:\n%s", want, got)
	}
}

func requireEvent(t *testing.T, events []string, want string) {
	t.Helper()
	for _, event := range events {
		if strings.Contains(event, want) {
			return
		}
	}
	t.Fatalf("missing event %q in:\n%s", want, strings.Join(events, "\n"))
}

func requireNoEvent(t *testing.T, events []string, want string) {
	t.Helper()
	for _, event := range events {
		if strings.Contains(event, want) {
			t.Fatalf("unexpected event %q in:\n%s", want, strings.Join(events, "\n"))
		}
	}
}

func requireOrder(t *testing.T, events []string, ordered ...string) {
	t.Helper()
	next := 0
	for _, want := range ordered {
		found := -1
		for i := next; i < len(events); i++ {
			if strings.Contains(events[i], want) {
				found = i
				break
			}
		}
		if found < 0 {
			t.Fatalf("event %q not found after position %d in:\n%s", want, next, strings.Join(events, "\n"))
		}
		next = found + 1
	}
}

func TestInstallAsRootUsesRootAndKeepsSandbox(t *testing.T) {
	s := newInstallSandbox(t)
	stdout, stderr, err := s.run(nil, nil)
	requireNoError(t, stdout, stderr, err)

	unit := s.readUnit()
	for _, want := range []string{
		"User=root", "Group=root",
		"WorkingDirectory=~",
		"Environment=\"HOME=" + s.rootHome + "\"",
		"NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes",
		"KillMode=control-group", "Restart=always",
		"ReadWritePaths=" + s.stateDir,
	} {
		requireContains(t, unit, want)
	}
	for _, forbidden := range []string{"User=edge-command", "Group=edge-command", "useradd", "groupadd"} {
		if strings.Contains(unit, forbidden) {
			t.Fatalf("unit must not contain %q:\n%s", forbidden, unit)
		}
	}

	assertMode(t, s.configPath, 0o600)
	assertMode(t, s.stateDir, 0o700)
	assertMode(t, s.configDir, 0o750)
	assertMode(t, s.unitPath, 0o644)
	if st, err := os.Stat(s.binPath); err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("binary mode = %v, %v", st, err)
	}
	if out, err := exec.Command(s.binPath, "version").CombinedOutput(); err != nil || !strings.Contains(string(out), "0.1.1") {
		t.Fatalf("installed fake binary: %q, %v", out, err)
	}

	events := s.events()
	requireEvent(t, events, "install-dir owner=root group=0 mode=0750 path="+s.configDir)
	requireEvent(t, events, "install-dir owner=0 group=0 mode=0700 path="+s.stateDir)
	requireEvent(t, events, "install-file owner=root group=root mode=0755")
	requireEvent(t, events, "chown 0:0 "+s.configPath)
	requireEvent(t, events, "chown -h 0:0 "+s.stateDir)
	requireEvent(t, events, "systemctl daemon-reload")
	requireEvent(t, events, "systemctl enable edge-command-agent.service")
	requireEvent(t, events, "systemctl restart edge-command-agent.service")
	if st, err := os.Stat(filepath.Join(s.serviceDir, "active")); err != nil || st.IsDir() {
		t.Fatalf("service is not active: %v", err)
	}
	for _, output := range []string{stdout, stderr, unit} {
		if strings.Contains(output, "test-secret") {
			t.Fatal("installer output or unit leaked ECP_CLIENT_SECRET")
		}
	}
}

func TestInstallViaSudoUsesNSSAccountNotInheritedHome(t *testing.T) {
	s := newInstallSandbox(t)
	stdout, stderr, err := s.run(nil, map[string]string{
		"SUDO_USER": "alice",
		"SUDO_UID":  "4242",
		"SUDO_GID":  "9999",
		"HOME":      "/inherited/home/must-not-be-used",
	})
	requireNoError(t, stdout, stderr, err)

	unit := s.readUnit()
	for _, want := range []string{
		"User=alice", "Group=alice",
		"WorkingDirectory=~",
		"Environment=\"HOME=" + s.aliceHome + "\"",
		"NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes",
		"ReadWritePaths=" + s.stateDir,
	} {
		requireContains(t, unit, want)
	}
	if strings.Contains(unit, "inherited") {
		t.Fatalf("unit trusted inherited HOME:\n%s", unit)
	}
	assertMode(t, s.configPath, 0o600)
	assertMode(t, s.stateDir, 0o700)
	assertMode(t, s.configDir, 0o750)

	events := s.events()
	requireEvent(t, events, "getent passwd alice")
	requireEvent(t, events, "id -u alice")
	requireEvent(t, events, "id -g alice")
	requireEvent(t, events, "install-dir owner=root group=4242 mode=0750 path="+s.configDir)
	requireEvent(t, events, "install-dir owner=4242 group=4242 mode=0700 path="+s.stateDir)
	requireEvent(t, events, "chown 4242:4242 "+s.configPath)
	requireEvent(t, events, "chown -h 4242:4242 "+s.stateDir)
}

func TestInstallEscapesHomeForSystemdUnit(t *testing.T) {
	s := newInstallSandbox(t)
	home := filepath.Join(s.root, "home", "alice space%quote")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := s.run(nil, map[string]string{
		"SUDO_USER":       "alice",
		"SUDO_UID":        "4242",
		"MOCK_ALICE_HOME": home,
	})
	requireNoError(t, stdout, stderr, err)

	escaped := strings.ReplaceAll(home, "%", "%%")
	unit := s.readUnit()
	requireContains(t, unit, "WorkingDirectory=~")
	requireContains(t, unit, "Environment=\"HOME="+escaped+"\"")
}

func TestInstallUpgradeStopsBeforeMigrationAndRestarts(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(true)
	oldBinary := readFile(t, s.binPath)
	oldUnit := readFile(t, s.unitPath)
	oldConfig := readFile(t, s.configPath)
	oldIdentity := readFile(t, filepath.Join(s.stateDir, "installation.json"))
	oldJournal := readFile(t, filepath.Join(s.stateDir, "runs", "run-1.jsonl"))

	stdout, stderr, err := s.run(nil, nil)
	requireNoError(t, stdout, stderr, err)

	events := s.events()
	requireOrder(t, events,
		"systemctl stop edge-command-agent.service",
		"install-file owner=root group=root mode=0755",
		"chown 0:0 "+s.configPath,
		"systemctl daemon-reload",
		"systemctl restart edge-command-agent.service",
	)
	requireEvent(t, events, "systemctl is-active --quiet edge-command-agent.service")

	if got := readFile(t, s.configPath); !bytes.Equal(got, oldConfig) {
		t.Fatal("enroll upgrade overwrote an existing valid config")
	}
	if got := readFile(t, filepath.Join(s.stateDir, "installation.json")); !bytes.Equal(got, oldIdentity) {
		t.Fatal("installation identity changed during upgrade")
	}
	if got := readFile(t, filepath.Join(s.stateDir, "runs", "run-1.jsonl")); !bytes.Equal(got, oldJournal) {
		t.Fatal("journal changed during upgrade")
	}
	if got := readFile(t, s.binPath); bytes.Equal(got, oldBinary) {
		t.Fatal("binary was not replaced")
	}
	if got := readFile(t, s.unitPath); bytes.Equal(got, oldUnit) {
		t.Fatal("unit was not replaced")
	}
	if st, err := os.Stat(filepath.Join(s.serviceDir, "active")); err != nil || st.IsDir() {
		t.Fatalf("service was not restarted: %v", err)
	}
}

func TestInstallNoStartUpgradeStopsAndLeavesStopped(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(true)
	oldConfig := readFile(t, s.configPath)
	oldIdentity := readFile(t, filepath.Join(s.stateDir, "installation.json"))

	stdout, stderr, err := s.run([]string{"--no-start"}, nil)
	requireNoError(t, stdout, stderr, err)
	if !strings.Contains(stdout, "not started") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}

	events := s.events()
	requireEvent(t, events, "systemctl stop edge-command-agent.service")
	requireNoEvent(t, events, "systemctl restart")
	requireNoEvent(t, events, "systemctl start")
	requireNoEvent(t, events, "systemctl enable")
	if _, err := os.Stat(filepath.Join(s.serviceDir, "active")); !os.IsNotExist(err) {
		t.Fatal("service was left active after --no-start")
	}
	if got := readFile(t, s.configPath); !bytes.Equal(got, oldConfig) {
		t.Fatal("config changed during --no-start upgrade")
	}
	if got := readFile(t, filepath.Join(s.stateDir, "installation.json")); !bytes.Equal(got, oldIdentity) {
		t.Fatal("installation identity changed during --no-start upgrade")
	}
	assertMode(t, s.configPath, 0o600)
	assertMode(t, s.stateDir, 0o700)
}

func TestInstallRejectsBadIdentityWithoutSideEffects(t *testing.T) {
	symlinkHome := func(s *installSandbox) string {
		link := filepath.Join(s.root, "home", "alice-link")
		if err := os.Symlink(s.aliceHome, link); err != nil {
			s.t.Fatal(err)
		}
		return link
	}

	cases := []struct {
		name      string
		overrides func(*installSandbox) map[string]string
	}{
		{"missing_sudo_uid", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice"}
		}},
		{"missing_sudo_user", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_UID": "4242"}
		}},
		{"sudo_uid_mismatch", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "9999"}
		}},
		{"non_numeric_sudo_uid", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "abc"}
		}},
		{"abnormal_sudo_user", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice;bad", "SUDO_UID": "4242"}
		}},
		{"unknown_user", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "bob", "SUDO_UID": "4242"}
		}},
		{"id_uid_mismatch", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ID_ALICE_UID": "5252"}
		}},
		{"id_gid_mismatch", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ID_ALICE_GID": "5252"}
		}},
		{"relative_home", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ALICE_HOME": "home/alice"}
		}},
		{"root_home", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ALICE_HOME": "/"}
		}},
		{"dotdot_home", func(*installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ALICE_HOME": "/home/../alice"}
		}},
		{"missing_home", func(s *installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ALICE_HOME": filepath.Join(s.root, "home", "missing")}
		}},
		{"symlink_home", func(s *installSandbox) map[string]string {
			return map[string]string{"SUDO_USER": "alice", "SUDO_UID": "4242", "MOCK_ALICE_HOME": symlinkHome(s)}
		}},
		{"not_root", func(*installSandbox) map[string]string {
			return map[string]string{"MOCK_EUID": "1000"}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newInstallSandbox(t)
			s.seed(true)
			before := snapshot(t, s.configPath, s.binPath, s.unitPath,
				filepath.Join(s.stateDir, "installation.json"),
				filepath.Join(s.stateDir, "runs", "run-1.jsonl"))
			stdout, stderr, err := s.run(nil, tc.overrides(s))
			if err == nil {
				t.Fatalf("expected failure, stdout=%s stderr=%s", stdout, stderr)
			}
			if !strings.Contains(stderr, "error:") {
				t.Fatalf("missing error message: %s", stderr)
			}
			events := s.events()
			requireNoEvent(t, events, "curl ")
			requireNoEvent(t, events, "systemctl stop")
			requireNoEvent(t, events, "install-file")
			requireNoEvent(t, events, "chown ")
			assertSnapshot(t, before)
			if _, err := os.Stat(filepath.Join(s.serviceDir, "active")); err != nil {
				t.Fatal("service was disturbed by a preflight failure")
			}
		})
	}
}

func TestInstallDownloadFailureDoesNotTouchServiceOrFiles(t *testing.T) {
	for name, overrides := range map[string]map[string]string{
		"transport_error": {"MOCK_FAIL_DOWNLOAD": "1"},
		"http_error":      {"MOCK_HTTP_CODE": "500"},
	} {
		t.Run(name, func(t *testing.T) {
			s := newInstallSandbox(t)
			s.seed(true)
			before := snapshot(t, s.configPath, s.binPath, s.unitPath,
				filepath.Join(s.stateDir, "installation.json"),
				filepath.Join(s.stateDir, "runs", "run-1.jsonl"))
			stdout, stderr, err := s.run(nil, overrides)
			if err == nil {
				t.Fatalf("expected download failure, stdout=%s stderr=%s", stdout, stderr)
			}
			events := s.events()
			requireEvent(t, events, "curl ")
			requireNoEvent(t, events, "systemctl stop")
			requireNoEvent(t, events, "install-file")
			requireNoEvent(t, events, "chown ")
			assertSnapshot(t, before)
			if _, err := os.Stat(filepath.Join(s.serviceDir, "active")); err != nil {
				t.Fatal("service was disturbed by a download failure")
			}
		})
	}
}

func TestInstallStopFailureDoesNotModifyHost(t *testing.T) {
	for name, overrides := range map[string]map[string]string{
		"stop_returns_error": {"MOCK_FAIL_STOP": "1"},
		"still_active":       {"MOCK_IGNORE_STOP": "1"},
		"show_query_error":   {"MOCK_FAIL_SHOW": "1"},
		"state_unknown":      {"MOCK_ACTIVE_STATE": "unknown"},
		"state_active":       {"MOCK_ACTIVE_STATE": "active"},
	} {
		t.Run(name, func(t *testing.T) {
			s := newInstallSandbox(t)
			s.seed(true)
			before := snapshot(t, s.configPath, s.binPath, s.unitPath,
				filepath.Join(s.stateDir, "installation.json"),
				filepath.Join(s.stateDir, "runs", "run-1.jsonl"))
			stdout, stderr, err := s.run(nil, overrides)
			if err == nil {
				t.Fatalf("expected stop confirmation failure, stdout=%s stderr=%s", stdout, stderr)
			}
			events := s.events()
			if name != "show_query_error" && name != "state_unknown" {
				requireEvent(t, events, "systemctl stop")
			}
			requireNoEvent(t, events, "install-file")
			requireNoEvent(t, events, "chown ")
			requireNoEvent(t, events, "systemctl restart")
			assertSnapshot(t, before)
		})
	}
}

func TestInstallAcceptsExplicitFailedStopState(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(true)
	stdout, stderr, err := s.run(nil, map[string]string{"MOCK_ACTIVE_STATE": "failed"})
	requireNoError(t, stdout, stderr, err)

	events := s.events()
	requireOrder(t, events,
		"systemctl stop edge-command-agent.service",
		"systemctl show --property=ActiveState --value edge-command-agent.service",
		"install-file owner=root group=root mode=0755",
		"systemctl restart edge-command-agent.service",
	)
	if got := readFile(t, s.unitPath); !strings.Contains(string(got), "User=root") {
		t.Fatalf("unit was not replaced after failed->inactive confirmation: %s", got)
	}
}

func TestInstallRejectsSymlinkLayoutBeforeStopping(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*installSandbox) string
	}{
		{"config_dir", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-config-dir")
			if err := os.MkdirAll(outside, 0o755); err != nil {
				s.t.Fatal(err)
			}
			if err := os.Symlink(outside, s.configDir); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
		{"config_file", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-config.json")
			s.write(outside, []byte("outside\n"), 0o600)
			if err := os.MkdirAll(s.configDir, 0o755); err != nil {
				s.t.Fatal(err)
			}
			if err := os.Symlink(outside, s.configPath); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
		{"state_dir", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-state")
			if err := os.MkdirAll(outside, 0o700); err != nil {
				s.t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(s.stateDir), 0o755); err != nil {
				s.t.Fatal(err)
			}
			if err := os.Symlink(outside, s.stateDir); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
		{"state_entry", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-state-entry")
			s.write(outside, []byte("outside\n"), 0o600)
			if err := os.MkdirAll(s.stateDir, 0o700); err != nil {
				s.t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(s.stateDir, "evil")); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
		{"unit_file", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-unit.service")
			s.write(outside, []byte("[Service]\nUser=edge-command\nExecStart=agent -execution-lock "+s.stateDir+"-lock/execution.lock\n"), 0o644)
			if err := os.Symlink(outside, s.unitPath); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
		{"binary", func(s *installSandbox) string {
			outside := filepath.Join(s.root, "outside-binary")
			s.write(outside, []byte("outside\n"), 0o755)
			if err := os.Symlink(outside, s.binPath); err != nil {
				s.t.Fatal(err)
			}
			return outside
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newInstallSandbox(t)
			outside := tc.setup(s)
			s.write(filepath.Join(s.serviceDir, "active"), []byte("1"), 0o644)
			before := snapshot(t, outside)
			stdout, stderr, err := s.run(nil, nil)
			if err == nil {
				t.Fatalf("expected symlink rejection, stdout=%s stderr=%s", stdout, stderr)
			}
			if !strings.Contains(stderr, "symlink") && !strings.Contains(stderr, "special file") && !strings.Contains(stderr, "not a regular file") {
				t.Fatalf("unexpected error: %s", stderr)
			}
			events := s.events()
			requireNoEvent(t, events, "curl ")
			requireNoEvent(t, events, "systemctl stop")
			requireNoEvent(t, events, "install-file")
			requireNoEvent(t, events, "chown ")
			assertSnapshot(t, before)
			if _, err := os.Stat(filepath.Join(s.serviceDir, "active")); err != nil {
				t.Fatal("service was disturbed by a symlink rejection")
			}
		})
	}
}

func TestInstallRepeatedUpgradePreservesConfigIdentityAndJournal(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(false)
	for i := 0; i < 2; i++ {
		stdout, stderr, err := s.run(nil, nil)
		requireNoError(t, stdout, stderr, err)
	}
	if got := readFile(t, s.configPath); !strings.Contains(string(got), "old-agent") {
		t.Fatalf("existing enroll config was not reused: %s", got)
	}
	if got := readFile(t, filepath.Join(s.stateDir, "installation.json")); !strings.Contains(string(got), "keep-me") {
		t.Fatalf("installation identity was not preserved: %s", got)
	}
	if got := readFile(t, filepath.Join(s.stateDir, "runs", "run-1.jsonl")); !strings.Contains(string(got), "kept") {
		t.Fatalf("journal was not preserved: %s", got)
	}
	assertMode(t, s.configPath, 0o600)
	assertMode(t, s.stateDir, 0o700)
	assertMode(t, filepath.Join(s.stateDir, "installation.json"), 0o600)
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %04o, want %04o", path, got, want)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

type fileSnapshot struct {
	path string
	data []byte
	mode os.FileMode
}

func snapshot(t *testing.T, paths ...string) []fileSnapshot {
	t.Helper()
	result := make([]fileSnapshot, 0, len(paths))
	for _, path := range paths {
		st, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().IsRegular() {
			result = append(result, fileSnapshot{path: path, data: readFile(t, path), mode: st.Mode().Perm()})
			continue
		}
		result = append(result, fileSnapshot{path: path, mode: st.Mode()})
	}
	return result
}

func assertSnapshot(t *testing.T, before []fileSnapshot) {
	t.Helper()
	for _, old := range before {
		st, err := os.Lstat(old.path)
		if err != nil {
			t.Fatalf("%s disappeared: %v", old.path, err)
		}
		if st.Mode() != old.mode {
			t.Fatalf("%s mode changed: %v -> %v", old.path, old.mode, st.Mode())
		}
		if old.data != nil {
			if got := readFile(t, old.path); !bytes.Equal(got, old.data) {
				t.Fatalf("%s contents changed", old.path)
			}
		}
	}
}

const idMock = `#!/bin/sh
printf 'id %s\n' "$*" >> "$MOCK_EVENT_LOG"
if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then
    printf '%s\n' "${MOCK_EUID:-0}"
    exit 0
fi
case "$1:$2" in
    -u:root) echo 0 ;;
    -u:alice) echo "${MOCK_ID_ALICE_UID:-$MOCK_ALICE_UID}" ;;
    -g:root) echo 0 ;;
    -g:alice) echo "${MOCK_ID_ALICE_GID:-$MOCK_ALICE_GID}" ;;
    *) exit 1 ;;
esac
`

const getentMock = `#!/bin/sh
printf 'getent %s\n' "$*" >> "$MOCK_EVENT_LOG"
kind=$1
key=$2
case "$kind:$key" in
    passwd:root)
        printf 'root:x:0:0:root:%s:/bin/bash\n' "$MOCK_ROOT_HOME"
        ;;
    passwd:alice)
        printf 'alice:x:%s:%s:Alice:%s:/bin/bash\n' "$MOCK_ALICE_UID" "$MOCK_ALICE_GID" "$MOCK_ALICE_HOME"
        ;;
    group:0)
        printf 'root:x:0:\n'
        ;;
    group:*)
        if [ "$key" = "$MOCK_ALICE_GID" ]; then
            printf 'alice:x:%s:\n' "$MOCK_ALICE_GID"
        else
            exit 2
        fi
        ;;
    *)
        exit 2
        ;;
esac
`

const systemctlMock = `#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$MOCK_EVENT_LOG"
cmd=$1
case "$cmd" in
    is-active)
        [ -f "$MOCK_SERVICE_STATE/active" ] && exit 0
        exit 3
        ;;
    stop)
        if [ "${MOCK_FAIL_STOP:-0}" = "1" ]; then exit 1; fi
        if [ "${MOCK_IGNORE_STOP:-0}" != "1" ]; then rm -f "$MOCK_SERVICE_STATE/active"; fi
        ;;
    show)
        if [ "${MOCK_FAIL_SHOW:-0}" = "1" ]; then exit 1; fi
        if [ -n "${MOCK_ACTIVE_STATE:-}" ]; then
            printf '%s\n' "$MOCK_ACTIVE_STATE"
            exit 0
        fi
        if [ -f "$MOCK_SERVICE_STATE/active" ]; then echo active; else echo inactive; fi
        ;;
    restart)
        if [ "${MOCK_FAIL_RESTART:-0}" = "1" ]; then exit 1; fi
        touch "$MOCK_SERVICE_STATE/active" "$MOCK_SERVICE_STATE/enabled"
        ;;
    start)
        touch "$MOCK_SERVICE_STATE/active"
        ;;
    enable)
        touch "$MOCK_SERVICE_STATE/enabled"
        ;;
    disable)
        rm -f "$MOCK_SERVICE_STATE/enabled"
        ;;
    daemon-reload)
        if [ "${MOCK_FAIL_DAEMON:-0}" = "1" ]; then exit 1; fi
        ;;
    status)
        ;;
    *)
        ;;
esac
exit 0
`

const curlMock = `#!/bin/sh
printf 'curl %s\n' "$*" >> "$MOCK_EVENT_LOG"
out=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift 2 ;;
        *) shift ;;
    esac
done
if [ "${MOCK_FAIL_DOWNLOAD:-0}" = "1" ]; then exit 22; fi
if [ "${MOCK_HTTP_CODE:-200}" != "200" ]; then
    printf '%s' "$MOCK_HTTP_CODE"
    exit 0
fi
[ -n "$out" ] || exit 2
cat > "$out" <<'AGENT'
#!/bin/sh
cmd=$1
case "$cmd" in
    version)
        echo "edge-command-agent 0.1.1"
        exit 0
        ;;
    configure|enroll)
        shift
        cfg=
        state=
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -config) cfg=$2; shift 2 ;;
                -state-dir) state=$2; shift 2 ;;
                *) shift ;;
            esac
        done
        [ -n "$cfg" ] || exit 2
        if [ "$cmd" = "enroll" ] && [ -f "$cfg" ]; then
            exit 0
        fi
        umask 077
        printf '{"url":"wss://panel.example/agent/ws","agentId":"agent-test","clientId":"id","clientSecret":"secret","stateDir":"%s"}\n' "$state" > "$cfg"
        chmod 600 "$cfg"
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
AGENT
chmod 700 "$out"
printf '200'
`

const installMock = `#!/bin/sh
printf 'install-args %s\n' "$*" >> "$MOCK_EVENT_LOG"
mode=
owner=
group=
dir=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        -d) dir=1; shift ;;
        -o) owner=$2; shift 2 ;;
        -g) group=$2; shift 2 ;;
        -m) mode=$2; shift 2 ;;
        --) shift; break ;;
        -*) shift ;;
        *) break ;;
    esac
done
if [ "$dir" = "1" ]; then
    [ "$#" -gt 0 ] || exit 2
    for d in "$@"; do
        mkdir -p "$d" || exit 1
        [ -z "$mode" ] || chmod "$mode" "$d" || exit 1
        printf 'install-dir owner=%s group=%s mode=%s path=%s\n' "$owner" "$group" "$mode" "$d" >> "$MOCK_EVENT_LOG"
    done
    exit 0
fi
[ "$#" -eq 2 ] || exit 2
src=$1
dst=$2
mkdir -p "${dst%/*}" || exit 1
cp "$src" "$dst" || exit 1
[ -z "$mode" ] || chmod "$mode" "$dst" || exit 1
printf 'install-file owner=%s group=%s mode=%s src=%s dst=%s\n' "$owner" "$group" "$mode" "$src" "$dst" >> "$MOCK_EVENT_LOG"
exit 0
`

const chownMock = `#!/bin/sh
printf 'chown %s\n' "$*" >> "$MOCK_EVENT_LOG"
if [ "${MOCK_FAIL_CHOWN:-0}" = "1" ]; then exit 1; fi
exit 0
`

// Outside the fake root, the workspace's shared ownership/modes do not model
// production /usr and /var. Inside it, use real stat so unsafe-layout tests
// still exercise the complete installer permission checks.
const statMock = `#!/bin/sh
case "$3" in
 "$MOCK_ROOT"|"$MOCK_ROOT"/*) exec /usr/bin/stat "$@" ;;
 *) case "$2" in '%u') echo 0; exit 0 ;; '%a') echo 755; exit 0 ;; esac ;;
esac
exec /usr/bin/stat "$@"
`

func TestInstallRejectsRunningLegacyWithoutChangingFiles(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(true)
	s.write(s.unitPath, []byte("[Service]\nUser=root\nExecStart=legacy\n"), 0644)
	before := snapshot(t, s.configPath, s.binPath, s.unitPath)
	_, stderr, err := s.run(nil, nil)
	if err == nil || !strings.Contains(stderr, "wait for all commands") {
		t.Fatalf("expected legacy guard, err=%v stderr=%s", err, stderr)
	}
	requireNoEvent(t, s.events(), "systemctl stop")
	assertSnapshot(t, before)
}

func TestInstallerCreatesRootUpdaterAndStopsTimerForNoStart(t *testing.T) {
	s := newInstallSandbox(t)
	stdout, stderr, err := s.run(nil, nil)
	requireNoError(t, stdout, stderr, err)
	unitDir := filepath.Dir(s.unitPath)
	for _, name := range []string{"edge-command-agent-update.service", "edge-command-agent-recover.service", "edge-command-agent-update.timer"} {
		data := readFile(t, filepath.Join(unitDir, name))
		if len(data) == 0 {
			t.Fatal(name)
		}
	}
	main := string(readFile(t, s.unitPath))
	requireContains(t, main, "Type=notify")
	requireContains(t, main, "-execution-lock "+s.stateDir+"-lock/execution.lock")
	requireContains(t, string(readFile(t, filepath.Join(unitDir, "edge-command-agent-update.timer"))), "OnUnitInactiveSec=1h")
	requireContains(t, string(readFile(t, filepath.Join(unitDir, "edge-command-agent-recover.service"))), "RemainAfterExit=yes")
	for _, spec := range []struct {
		p    string
		mode os.FileMode
	}{{s.stateDir + "-update", 0700}, {s.stateDir + "-lock/execution.lock", 0644}} {
		st, err := os.Stat(spec.p)
		if err != nil || st.Mode().Perm() != spec.mode {
			t.Fatalf("permissions %s: %v %v", spec.p, st, err)
		}
	}
	s.write(s.eventLog, nil, 0600)
	stdout, stderr, err = s.run([]string{"--no-start"}, nil)
	requireNoError(t, stdout, stderr, err)
	events := s.events()
	requireEvent(t, events, "systemctl stop edge-command-agent-update.timer")
	requireNoEvent(t, events, "systemctl start ")
	requireNoEvent(t, events, "systemctl restart ")
}

func TestReinstallCannotInterruptExecutionLockHolder(t *testing.T) {
	s := newInstallSandbox(t)
	s.seed(true)
	lockDir := s.stateDir + "-lock"
	if err := os.MkdirAll(lockDir, 0755); err != nil {
		t.Fatal(err)
	}
	os.Chmod(lockDir, 0755)
	lockPath := filepath.Join(lockDir, "execution.lock")
	s.write(lockPath, nil, 0644)
	held, err := runlock.OpenShared(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	before := snapshot(t, s.configPath, s.binPath, s.unitPath)
	_, stderr, err := s.run(nil, nil)
	if err == nil || !strings.Contains(stderr, "a command is running") {
		t.Fatalf("busy reinstall: %v %s", err, stderr)
	}
	requireNoEvent(t, s.events(), "systemctl stop")
	assertSnapshot(t, before)
}

package update

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"edge-command-agent/internal/runlock"
)

var oldFixture, newFixture []byte

func TestMain(m *testing.M) {
	if os.Getenv("ECP_UPDATE_CRASH_HELPER") == "1" {
		os.Exit(m.Run())
	}
	if err := os.MkdirAll(".paseo-scratch", 0700); err != nil {
		panic(err)
	}
	dir, err := os.MkdirTemp(".paseo-scratch", "update-fixtures-")
	if err != nil {
		panic(err)
	}
	src := filepath.Join(dir, "main.go")
	code := `package main
import "fmt"
var v string
func main(){fmt.Printf("edge-command-agent %s\n",v)}
`
	if err := os.WriteFile(src, []byte(code), 0600); err != nil {
		panic(err)
	}
	for _, v := range []string{"0.1.2", "0.1.3"} {
		dst := filepath.Join(dir, v)
		cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", dst, "-ldflags", "-X main.v="+v, src)
		if out, err := cmd.CombinedOutput(); err != nil {
			panic(fmt.Sprintf("fixture: %v %s", err, out))
		}
		b, err := os.ReadFile(dst)
		if err != nil {
			panic(err)
		}
		if v == "0.1.2" {
			oldFixture = b
		} else {
			newFixture = b
		}
	}
	rc := m.Run()
	os.RemoveAll(dir)
	os.Exit(rc)
}
func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func write(t *testing.T, p string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(p, b, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

type fakeService struct {
	active                  bool
	pid, starts, stops      int
	target                  string
	badHealth, failRollback bool
	events                  []string
}

func (s *fakeService) Stop(context.Context) error {
	s.stops++
	s.events = append(s.events, "stop")
	if s.failRollback && s.stops > 1 {
		return errors.New("stop failed")
	}
	s.active = false
	s.pid = 0
	return nil
}
func (s *fakeService) Start(context.Context) error {
	s.starts++
	s.events = append(s.events, "start")
	s.active = true
	s.pid = 100 + s.starts
	return nil
}
func (s *fakeService) IsActive(context.Context) (bool, error) {
	b, _ := os.ReadFile(s.target)
	if s.badHealth && s.active && sum(b) == sum(newFixture) {
		return false, errors.New("new process readiness failed")
	}
	return s.active, nil
}
func (s *fakeService) MainPID(context.Context) (int, error) { return s.pid, nil }

type fixture struct {
	u           *Updater
	s           *fakeService
	requests    atomic.Int32
	payload     []byte
	checksum    string
	server      *httptest.Server
	root        string
	requestHook func()
}

func setup(t *testing.T) *fixture {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("root-owned transaction/permission tests require an isolated root environment")
	}
	f := &fixture{root: t.TempDir(), payload: newFixture}
	f.checksum = sum(f.payload)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		if f.requestHook != nil {
			f.requestHook()
		}
		switch {
		case strings.Contains(r.URL.Path, "/repos/"):
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `[{"tag_name":"web-v99.0.0"},{"tag_name":"agent-v9.0.0","prerelease":true},{"tag_name":"agent-v0.1.3"}]`)
		case strings.HasSuffix(r.URL.Path, "SHA256SUMS"):
			fmt.Fprintf(w, "%s  edge-agent-linux-amd64\n%s  edge-agent-linux-arm64\n%s  install.sh\n", f.checksum, f.checksum, sum([]byte("installer")))
		default:
			w.Write(f.payload)
		}
	}))
	t.Cleanup(f.server.Close)
	state := filepath.Join(f.root, "state")
	binDir := filepath.Join(f.root, "bin")
	lockDir := filepath.Join(f.root, "locks")
	for _, d := range []string{state, binDir, lockDir} {
		if err := os.Mkdir(d, 0755); err != nil {
			t.Fatal(err)
		}
		os.Chmod(d, 0755)
	}
	os.Chmod(state, 0700)
	binary := filepath.Join(binDir, "agent")
	lock := filepath.Join(lockDir, "execution.lock")
	write(t, binary, oldFixture, 0755)
	write(t, lock, nil, 0644)
	f.s = &fakeService{active: true, pid: 100, target: binary}
	parsed, _ := url.Parse(f.server.URL)
	u, err := New(Options{StateDir: state, TargetBinary: binary, ExecutionLockPath: lock, Service: f.s,
		StableFor: time.Millisecond, RollbackStable: time.Millisecond, HealthPoll: time.Millisecond, Jitter: func(time.Duration) time.Duration { return 0 },
		HTTP: HTTPConfig{APIBase: f.server.URL, DownloadBase: f.server.URL, AllowedHosts: map[string]bool{parsed.Hostname(): true}, AllowHTTP: true, AllowCustomPort: true}})
	if err != nil {
		t.Fatal(err)
	}
	f.u = u
	return f
}
func TestVerifiedUpdateAndPersistentSchedule(t *testing.T) {
	f := setup(t)
	f.requestHook = func() {
		st, err := LoadState(f.u.opt.StateDir)
		if err != nil || st.NextCheck <= time.Now().UnixMilli() {
			t.Error("network before durable schedule reservation")
		}
	}
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusUpdated {
		t.Fatalf("%+v %v", res, err)
	}
	b, _ := os.ReadFile(f.u.opt.TargetBinary)
	if sum(b) != sum(newFixture) {
		t.Fatal("new binary not installed")
	}
	if f.s.starts != 1 || f.s.stops != 1 {
		t.Fatalf("service: %+v", f.s)
	}
	before := f.requests.Load()
	res, err = f.u.Run(context.Background())
	if err != nil || res.Status != StatusSkipped || f.requests.Load() != before {
		t.Fatalf("restart bypassed scheduling: %+v %v", res, err)
	}
}
func TestBusyUpdateDoesNotStopTask(t *testing.T) {
	f := setup(t)
	lock, err := runlock.OpenShared(f.u.opt.ExecutionLockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusBusy || f.s.stops != 0 {
		t.Fatalf("%+v %v stops=%d", res, err, f.s.stops)
	}
	b, _ := os.ReadFile(f.u.opt.TargetBinary)
	if sum(b) != sum(oldFixture) {
		t.Fatal("busy binary replaced")
	}
}
func TestBadArtifactsNeverStopService(t *testing.T) {
	for _, kind := range []string{"hash", "html", "arch", "version"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			switch kind {
			case "hash":
				f.checksum = strings.Repeat("0", 64)
			case "html":
				f.payload = []byte("<html>error</html>")
				f.checksum = sum(f.payload)
			case "arch":
				f.payload = append([]byte(nil), newFixture...)
				f.payload[18] = 183
				f.payload[19] = 0
				f.checksum = sum(f.payload)
			case "version":
				f.payload = oldFixture
				f.checksum = sum(f.payload)
			}
			res, err := f.u.Run(context.Background())
			if err != nil || res.Status != StatusBackoff || f.s.stops != 0 {
				t.Fatalf("%+v %v", res, err)
			}
		})
	}
}
func TestFailedNewProcessIsStoppedBeforeRollback(t *testing.T) {
	f := setup(t)
	f.s.badHealth = true
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusRolledBack {
		t.Fatalf("%+v %v", res, err)
	}
	b, _ := os.ReadFile(f.u.opt.TargetBinary)
	if sum(b) != sum(oldFixture) || strings.Join(f.s.events, ",") != "stop,start,stop,start" {
		t.Fatalf("rollback: %v", f.s.events)
	}
}
func TestPostRenameSyncFailureRollsBack(t *testing.T) {
	f := setup(t)
	f.u.opt.SyncTargetDir = func(string) error { return errors.New("disk sync failed") }
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusRolledBack {
		t.Fatalf("%+v %v", res, err)
	}
	b, _ := os.ReadFile(f.u.opt.TargetBinary)
	if sum(b) != sum(oldFixture) {
		t.Fatal("new binary kept after sync failure")
	}
}
func TestRollbackFailureBlocksFurtherAttempts(t *testing.T) {
	f := setup(t)
	f.s.badHealth = true
	f.s.failRollback = true
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusBlocked {
		t.Fatalf("%+v %v", res, err)
	}
	n := f.requests.Load()
	res, err = f.u.Run(context.Background())
	if err != nil || res.Status != StatusBlocked || f.requests.Load() != n {
		t.Fatal("blocked updater retried")
	}
}
func TestCrashRecoveryAtEveryDurableStage(t *testing.T) {
	for _, phase := range []TransactionStage{StagePreparing, StageBackup, StageReplacing, StageReplaced, StageStarting, StageCommitted} {
		t.Run(string(phase), func(t *testing.T) {
			f := setup(t)
			f.u.opt.Checkpoint = func(s TransactionStage) error {
				if s == phase {
					return errors.New("injected process death")
				}
				return nil
			}
			_, err := f.u.Run(context.Background())
			if err == nil {
				t.Fatal("checkpoint not reached")
			}
			txn, err := LoadTransaction(f.u.opt.StateDir)
			if err != nil || txn == nil || txn.Stage != phase {
				t.Fatal("transaction not durable")
			}
			f.u.opt.Checkpoint = nil
			f.s.active = false
			f.s.pid = 0
			starts, stops := f.s.starts, f.s.stops
			res, err := f.u.RecoverBoot(context.Background())
			if err != nil || res.Status != StatusRecovered {
				t.Fatalf("%+v %v", res, err)
			}
			if f.s.starts != starts || f.s.stops != stops {
				t.Fatal("boot recovery touched dependent service")
			}
			b, _ := os.ReadFile(f.u.opt.TargetBinary)
			want := oldFixture
			if phase == StageCommitted {
				want = newFixture
			}
			if sum(b) != sum(want) {
				t.Fatal("wrong recovered binary")
			}
			txn, err = LoadTransaction(f.u.opt.StateDir)
			if err != nil || txn != nil {
				t.Fatal("transaction not cleared")
			}
		})
	}
}
func TestStoppedServiceAndConcurrentUpdaterAreUntouched(t *testing.T) {
	f := setup(t)
	f.s.active = false
	f.s.pid = 0
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusSkipped || f.requests.Load() != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	lock, err := runlock.OpenExclusive(f.u.opt.UpdaterLockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	res, err = f.u.Run(context.Background())
	if err != nil || res.Status != StatusBusy {
		t.Fatalf("%+v %v", res, err)
	}
}
func TestUnsafePathsAndTransactionsFailClosed(t *testing.T) {
	f := setup(t)
	target := f.u.opt.TargetBinary
	real := target + ".real"
	if err := os.Rename(target, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, target); err != nil {
		t.Fatal(err)
	}
	if _, err := f.u.Run(context.Background()); err == nil {
		t.Fatal("symlink target accepted")
	}
	if _, err := ParseSHA256SUMS([]byte(strings.Repeat("0", 64) + "  ../escape\n")); err == nil {
		t.Fatal("unsafe checksum path accepted")
	}
	txn := &Transaction{TargetPath: "/not-the-agent"}
	if err := f.u.validateTransaction(txn); err == nil {
		t.Fatal("foreign transaction accepted")
	}
}
func TestRateLimitAndNoDowngrade(t *testing.T) {
	c := NewClient(HTTPConfig{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"7200"}}, Body: http.NoBody}, nil
	})})
	_, err := c.ListReleases(context.Background())
	var rate *RateLimitError
	if !errors.As(err, &rate) || rate.RetryAfter != 2*time.Hour {
		t.Fatalf("rate error: %v", err)
	}
	f := setup(t)
	st := State{}
	res, err := f.u.fail(st, time.Now(), "limited", rate)
	if err != nil || time.Until(res.NextCheck) < 119*time.Minute {
		t.Fatalf("%+v %v", res, err)
	}
	for _, s := range []string{"agent-v01.2.3", "agent-v1.2.3-beta", "web-v9.0.0", "agent-v99999999999.1.1"} {
		if _, ok := ParseReleaseTag(s); ok {
			t.Fatal("accepted", s)
		}
	}
	current, _ := ParseVersion("0.1.3")
	if _, ok := SelectRelease([]Release{{Version: Version{Patch: 1}}}, current); ok {
		t.Fatal("downgrade selected")
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestHTTPPolicyAndIndependentDownloadTimeout(t *testing.T) {
	cfg := HTTPConfig{}.withDefaults()
	for _, s := range []string{"http://github.com/x", "https://github.com.evil.test/x", "https://user@github.com/x", "https://github.com:8443/x"} {
		u, _ := url.Parse(s)
		if validateURL(u, cfg) == nil {
			t.Fatal("unsafe URL accepted", s)
		}
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "SHA256SUMS") {
			time.Sleep(30 * time.Millisecond)
			fmt.Fprint(w, "hello")
		} else {
			http.Redirect(w, r, "https://evil.test/payload", 302)
		}
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	c := NewClient(HTTPConfig{APIBase: server.URL, DownloadBase: server.URL, AllowedHosts: map[string]bool{u.Hostname(): true}, AllowCustomPort: true, Transport: server.Client().Transport, Timeout: time.Millisecond, DownloadTimeout: time.Second})
	dst := filepath.Join(t.TempDir(), "sums")
	if _, _, err := c.DownloadAsset(context.Background(), "agent-v0.1.3", assetSums, dst); err != nil {
		t.Fatal("metadata timeout incorrectly capped download", err)
	}
	if _, _, err := c.DownloadAsset(context.Background(), "agent-v0.1.3", assetAmd64, dst+".bad"); err == nil {
		t.Fatal("foreign redirect accepted")
	}
}
func TestVersionCheckTimeoutKillsDescendantPipe(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hang")
	write(t, p, []byte("#!/bin/sh\nsleep 30 &\nwait\n"), 0700)
	start := time.Now()
	if _, err := VersionOutput(context.Background(), p, 30*time.Millisecond); err == nil {
		t.Fatal("hung version accepted")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("version timeout unbounded")
	}
}
func TestStateRejectsCorruptOrWritableFiles(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("ownership")
	}
	d := t.TempDir()
	write(t, filepath.Join(d, "state.json"), []byte("invalid"), 0600)
	if _, err := LoadState(d); err == nil {
		t.Fatal("corruption accepted")
	}
	write(t, filepath.Join(d, "state.json"), []byte(`{}`), 0666)
	if _, err := LoadState(d); err == nil {
		t.Fatal("writable state accepted")
	}
}

func TestUpdaterKilledProcess(t *testing.T) {
	if os.Getenv("ECP_UPDATE_CRASH_HELPER") != "1" {
		return
	}
	root, base, phase := os.Getenv("ECP_UPDATE_ROOT"), os.Getenv("ECP_UPDATE_BASE"), os.Getenv("ECP_UPDATE_PHASE")
	parsed, _ := url.Parse(base)
	target := filepath.Join(root, "bin", "agent")
	svc := &fakeService{active: true, pid: 100, target: target}
	u, err := New(Options{StateDir: filepath.Join(root, "state"), TargetBinary: target, ExecutionLockPath: filepath.Join(root, "locks", "execution.lock"), Service: svc,
		StableFor: time.Millisecond, HealthPoll: time.Millisecond,
		HTTP: HTTPConfig{APIBase: base, DownloadBase: base, AllowedHosts: map[string]bool{parsed.Hostname(): true}, AllowHTTP: true, AllowCustomPort: true},
		Checkpoint: func(p TransactionStage) error {
			if string(p) == phase {
				fmt.Println("checkpoint")
				select {}
			}
			return nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := u.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Fatal("checkpoint not reached")
}
func TestActualUpdaterDeathReleasesLocksAndRecovers(t *testing.T) {
	for _, phase := range []TransactionStage{StageReplacing, StageReplaced, StageCommitted} {
		t.Run(string(phase), func(t *testing.T) {
			f := setup(t)
			cmd := exec.Command(os.Args[0], "-test.run=^TestUpdaterKilledProcess$")
			cmd.Env = append(os.Environ(), "ECP_UPDATE_CRASH_HELPER=1", "ECP_UPDATE_ROOT="+f.root, "ECP_UPDATE_BASE="+f.server.URL, "ECP_UPDATE_PHASE="+string(phase))
			output, _ := cmd.StdoutPipe()
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { cmd.Process.Kill() })
			ready := make(chan string, 1)
			go func() { line, _ := bufio.NewReader(output).ReadString('\n'); ready <- line }()
			select {
			case line := <-ready:
				if line != "checkpoint\n" {
					t.Fatalf("checkpoint: %q", line)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("updater failed to reach checkpoint")
			}
			if err := cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			cmd.Wait()
			f.s.active = false
			f.s.pid = 0
			res, err := f.u.RecoverBoot(context.Background())
			if err != nil || res.Status != StatusRecovered {
				t.Fatalf("%+v %v", res, err)
			}
			got, _ := os.ReadFile(f.u.opt.TargetBinary)
			want := oldFixture
			if phase == StageCommitted {
				want = newFixture
			}
			if sum(got) != sum(want) {
				t.Fatal("killed process recovery selected wrong binary")
			}
		})
	}
}
func TestBusyCandidateCacheIsReused(t *testing.T) {
	f := setup(t)
	lock, err := runlock.OpenShared(f.u.opt.ExecutionLockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusBusy {
		t.Fatalf("%+v %v", res, err)
	}
	st, _ := LoadState(f.u.opt.StateDir)
	st.NextCheck = 0
	SaveState(f.u.opt.StateDir, st)
	before := f.requests.Load()
	res, err = f.u.Run(context.Background())
	if err != nil || res.Status != StatusBusy || f.requests.Load()-before != 1 {
		t.Fatalf("cached candidate downloaded again: %+v %v requests=%d", res, err, f.requests.Load()-before)
	}
}
func TestRecoveryRepairsMissingTargetAndNeverKillsRunningCommand(t *testing.T) {
	f := setup(t)
	f.u.opt.Checkpoint = func(s TransactionStage) error {
		if s == StageReplaced {
			return errors.New("crash")
		}
		return nil
	}
	if _, err := f.u.Run(context.Background()); err == nil {
		t.Fatal("no crash")
	}
	f.u.opt.Checkpoint = nil
	lock, err := runlock.OpenShared(f.u.opt.ExecutionLockPath)
	if err != nil {
		t.Fatal(err)
	}
	stops := f.s.stops
	res, err := f.u.Run(context.Background())
	if err != nil || res.Status != StatusBusy || f.s.stops != stops {
		t.Fatal("recovery stopped an executing command")
	}
	lock.Close()
	os.Remove(f.u.opt.TargetBinary)
	f.s.active = false
	f.s.pid = 0
	res, err = f.u.RecoverBoot(context.Background())
	if err != nil || res.Status != StatusRecovered {
		t.Fatalf("%+v %v", res, err)
	}
	got, _ := os.ReadFile(f.u.opt.TargetBinary)
	if sum(got) != sum(oldFixture) {
		t.Fatal("missing binary not repaired")
	}
}
func TestPaginationCapAndHighestNumericVersion(t *testing.T) {
	var pages []string
	c := NewClient(HTTPConfig{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		pages = append(pages, r.URL.Query().Get("page"))
		items := make([]map[string]any, 100)
		for i := range items {
			items[i] = map[string]any{"tag_name": "web-v99.0.0"}
		}
		switch len(pages) {
		case 1:
			items[0]["tag_name"] = "agent-v0.1.9"
		case 2:
			items[0]["tag_name"] = "agent-v0.1.12"
		case 3:
			items[0]["tag_name"] = "agent-v0.1.10"
		}
		b, _ := json.Marshal(items)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b))}, nil
	})})
	releases, err := c.ListReleases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	v, _ := ParseVersion("0.1.2")
	best, ok := SelectRelease(releases, v)
	if !ok || best.Tag != "agent-v0.1.12" || strings.Join(pages, ",") != "1,2,3" {
		t.Fatalf("%+v %v", best, pages)
	}
}

func TestOrphanFenceRecoveryAndUncommittedFenceLifetime(t *testing.T) {
	f := setup(t)
	if err := f.u.createFence(); err != nil {
		t.Fatal(err)
	}
	res, err := f.u.RecoverBoot(context.Background())
	if err != nil || res.Status != StatusSkipped {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := os.Stat(f.u.opt.ExecutionLockPath + ".pending"); !os.IsNotExist(err) {
		t.Fatal("orphan fence leaked")
	}
	f.u.opt.Checkpoint = func(p TransactionStage) error {
		if p == StageReplaced {
			return errors.New("death")
		}
		return nil
	}
	if _, err := f.u.Run(context.Background()); err == nil {
		t.Fatal("checkpoint not reached")
	}
	if _, err := os.Stat(f.u.opt.ExecutionLockPath + ".pending"); err != nil {
		t.Fatal("transaction not fenced", err)
	}
	f.s.active = false
	f.s.pid = 0
	res, err = f.u.RecoverBoot(context.Background())
	if err != nil || res.Status != StatusRecovered {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := os.Stat(f.u.opt.ExecutionLockPath + ".pending"); !os.IsNotExist(err) {
		t.Fatal("recovered fence leaked")
	}
}

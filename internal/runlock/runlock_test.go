package runlock

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestLockHelperProcess(t *testing.T) {
	if os.Getenv("ECP_LOCK_HELPER") != "1" {
		return
	}
	var l *Lock
	var err error
	if os.Getenv("ECP_LOCK_MODE") == "exclusive" {
		l, err = OpenExclusive(os.Getenv("ECP_LOCK_PATH"))
	} else {
		l, err = OpenShared(os.Getenv("ECP_LOCK_PATH"))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println("ready")
	bufio.NewReader(os.Stdin).ReadByte()
	l.Close()
	os.Exit(0)
}
func TestRealProcessSharedAndExclusiveExclusion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "execution.lock")
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"shared", "exclusive"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestLockHelperProcess$")
			cmd.Env = append(os.Environ(), "ECP_LOCK_HELPER=1", "ECP_LOCK_MODE="+mode, "ECP_LOCK_PATH="+path)
			input, _ := cmd.StdinPipe()
			output, _ := cmd.StdoutPipe()
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { input.Close(); cmd.Process.Kill() })
			line, err := bufio.NewReader(output).ReadString('\n')
			if err != nil || line != "ready\n" {
				t.Fatalf("child failed: %q %v", line, err)
			}
			if l, err := OpenExclusive(path); !errors.Is(err, ErrBusy) {
				l.Close()
				t.Fatalf("exclusive admitted during child %s: %v", mode, err)
			}
			if mode == "exclusive" {
				if l, err := OpenShared(path); !errors.Is(err, ErrBusy) {
					l.Close()
					t.Fatal("command admitted during update")
				}
			}
			input.Write([]byte("x"))
			input.Close()
			if err := cmd.Wait(); err != nil {
				t.Fatal(err)
			}
			l, err := OpenExclusive(path)
			if err != nil {
				t.Fatal("lock not released on child exit", err)
			}
			l.Close()
		})
	}
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if l, err := OpenShared(link); err == nil {
		l.Close()
		t.Fatal("symlink followed")
	}
}

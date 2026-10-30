package sdnotify

import (
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestReadinessDatagram(t *testing.T) {
	p := filepath.Join(t.TempDir(), "notify")
	c, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: p, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t.Setenv("NOTIFY_SOCKET", p)
	if err := Ready(); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	b := make([]byte, 32)
	n, _, err := c.ReadFromUnix(b)
	if err != nil || string(b[:n]) != "READY=1" {
		t.Fatalf("%q %v", b[:n], err)
	}
}

// Package sdnotify sends the small subset of the systemd readiness protocol
// used by the agent. It deliberately has no systemd library dependency.
package sdnotify

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// Ready sends READY=1 to $NOTIFY_SOCKET. A missing socket is not an error:
// the agent also runs in development and under non-systemd supervisors.
func Ready() error {
	return notify("READY=1")
}

// Notify sends an arbitrary status line. It is exported for tests.
func Notify(state string) error {
	return notify(state)
}

func notify(state string) error {
	socket := os.Getenv("NOTIFY_SOCKET")
	if socket == "" {
		return nil
	}
	if strings.ContainsAny(state, "\r\n\x00") {
		return fmt.Errorf("sdnotify: invalid state")
	}
	addr := socket
	if strings.HasPrefix(addr, "@") {
		// Linux abstract namespace: a leading NUL byte.
		addr = "\x00" + addr[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: addr, Net: "unixgram"})
	if err != nil {
		return fmt.Errorf("sdnotify: dial: %w", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(state)); err != nil {
		return fmt.Errorf("sdnotify: write: %w", err)
	}
	return nil
}

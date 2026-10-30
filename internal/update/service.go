package update

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Service is the fixed service-management surface used by the updater. There
// is deliberately no generic command or shell entry point.
type Service interface {
	Stop(ctx context.Context) error
	Start(ctx context.Context) error
	IsActive(ctx context.Context) (bool, error)
	MainPID(ctx context.Context) (int, error)
}

// SystemdService runs systemctl for one fixed service name.
type SystemdService struct {
	Name string
}

func (s SystemdService) run(ctx context.Context, args ...string) ([]byte, error) {
	if s.Name == "" {
		return nil, errors.New("update: empty service name")
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "systemctl", append(args, s.Name)...)
	return cmd.CombinedOutput()
}

func (s SystemdService) Stop(ctx context.Context) error {
	out, err := s.run(ctx, "stop")
	if err != nil {
		return fmt.Errorf("update: systemctl stop %s: %w: %s", s.Name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s SystemdService) Start(ctx context.Context) error {
	out, err := s.run(ctx, "start")
	if err != nil {
		return fmt.Errorf("update: systemctl start %s: %w: %s", s.Name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s SystemdService) IsActive(ctx context.Context) (bool, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "systemctl", "is-active", "--quiet", s.Name)
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		// is-active uses 3 for inactive/failed and 4 for unknown.
		if code := exitErr.ExitCode(); code == 3 {
			return false, nil
		}
	}
	return false, fmt.Errorf("update: systemctl is-active %s: %w", s.Name, err)
}

func (s SystemdService) MainPID(ctx context.Context) (int, error) {
	out, err := s.run(ctx, "show", "--property=MainPID", "--value")
	if err != nil {
		return 0, fmt.Errorf("update: systemctl show %s: %w: %s", s.Name, err, strings.TrimSpace(string(out)))
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid < 0 {
		return 0, fmt.Errorf("update: invalid MainPID %q", strings.TrimSpace(string(out)))
	}
	return pid, nil
}

// stopConfirmed stops the service and requires systemd to report it inactive.
func stopConfirmed(ctx context.Context, svc Service) error {
	if err := svc.Stop(ctx); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		active, err := svc.IsActive(ctx)
		if err != nil {
			return err
		}
		pid, err := svc.MainPID(ctx)
		if err != nil {
			return err
		}
		if !active && pid == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("update: service is still active after stop")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// waitHealthy requires the service to be active with a non-zero, unchanged
// MainPID for stable. It never contacts the panel or the network.
func waitHealthy(ctx context.Context, svc Service, stable, poll time.Duration) (int, error) {
	if stable <= 0 {
		stable = 30 * time.Second
	}
	if poll <= 0 {
		poll = time.Second
	}
	deadline := time.Now().Add(stable + 2*time.Minute)
	var pid int
	var stableSince time.Time
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		active, err := svc.IsActive(ctx)
		if err != nil {
			return 0, err
		}
		cur, err := svc.MainPID(ctx)
		if err != nil {
			return 0, err
		}
		if active && cur > 0 {
			if pid != cur {
				pid = cur
				stableSince = time.Now()
			} else if time.Since(stableSince) >= stable {
				return pid, nil
			}
		} else {
			pid = 0
			stableSince = time.Time{}
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("update: service %s did not become healthy", "edge-command-agent")
		}
		t := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			t.Stop()
			return 0, ctx.Err()
		case <-t.C:
		}
	}
}

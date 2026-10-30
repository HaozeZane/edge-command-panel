// Command edge-command-agent runs the outbound command agent, or performs
// one-time enrollment/configuration.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"edge-command-agent/internal/client"
	"edge-command-agent/internal/config"
	"edge-command-agent/internal/enroll"
	"edge-command-agent/internal/journal"
	"edge-command-agent/internal/sdnotify"
	"edge-command-agent/internal/update"
)

// Version is overridden with -ldflags at build time.
var Version = "0.1.2"

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if err := run(os.Args[1:]); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return runAgent(nil)
	}
	switch args[0] {
	case "version", "-version", "--version":
		fmt.Printf("edge-command-agent %s\n", Version)
		return nil
	case "enroll":
		return runEnroll(args[1:])
	case "configure":
		return runConfigure(args[1:])
	case "run":
		return runAgent(args[1:])
	case "bootstrap":
		return runBootstrap(args[1:])
	default:
		if len(args[0]) > 0 && args[0][0] == '-' {
			return runAgent(args)
		}
		return fmt.Errorf("unknown command %q (want run, enroll, configure, bootstrap, version)", args[0])
	}
}

func runBootstrap(args []string) error {
	if len(args) != 1 {
		return errors.New("bootstrap: want exactly one of update or recover")
	}
	if os.Geteuid() != 0 {
		return errors.New("bootstrap: must run as root")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	u, err := update.New(update.Options{})
	if err != nil {
		return err
	}
	switch args[0] {
	case "update":
		res, err := u.Run(ctx)
		if err != nil {
			return err
		}
		log.Printf("bootstrap update: status=%s version=%s reason=%s nextCheck=%s",
			res.Status, res.Version, res.Reason, res.NextCheck.UTC().Format(time.RFC3339))
		if res.Status == update.StatusBlocked {
			return errors.New("updates blocked; inspect the update service journal and saved transaction")
		}
		return nil
	case "recover":
		res, err := u.RecoverBoot(ctx)
		if err != nil {
			return err
		}
		log.Printf("bootstrap recover: status=%s version=%s reason=%s nextCheck=%s",
			res.Status, res.Version, res.Reason, res.NextCheck.UTC().Format(time.RFC3339))
		if res.Status == update.StatusBlocked {
			return errors.New("boot recovery blocked; repair the saved transaction before starting the agent")
		}
		return nil
	default:
		return fmt.Errorf("bootstrap: unknown operation %q (want update or recover)", args[0])
	}
}

func runAgent(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cfgPath := fs.String("config", config.DefaultPath, "configuration file")
	lockPath := fs.String("execution-lock", "", "root-managed execution/update lock file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *lockPath != "" {
		if err := update.ValidateRootDir(filepath.Dir(*lockPath)); err != nil {
			return err
		}
		if err := update.ValidateRootFile(*lockPath); err != nil {
			return err
		}
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	j, err := journal.Open(cfg.StateDir, journal.DefaultOptions())
	if err != nil {
		return err
	}
	defer j.Close()
	if err := j.ReconcileInterrupted(); err != nil {
		return fmt.Errorf("reconcile journal: %w", err)
	}
	agent, err := client.New(client.Options{
		Config: cfg, Journal: j, Version: Version, ExecutionLock: *lockPath,
		OnReady: func() {
			if err := sdnotify.Ready(); err != nil {
				log.Printf("systemd readiness notification failed: %v", err)
			}
		},
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("starting %s (%s)", Version, cfg.Redacted())
	return agent.Run(ctx)
}

func defaultStateDir() string {
	if v := os.Getenv("ECP_STATE_DIR"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, config.DefaultStateDirName)
	}
	return "/var/lib/edge-command-agent"
}

func runEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	cfgPath := fs.String("config", config.DefaultPath, "configuration file to write")
	stateDir := fs.String("state-dir", defaultStateDir(), "state directory for the installation key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *stateDir == "" {
		return errors.New("enroll: -state-dir is required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	cfg, err := enroll.Run(ctx, enroll.Options{
		ConfigPath: *cfgPath, StateDir: *stateDir,
		BaseURL: os.Getenv("ECP_URL"), ClientID: os.Getenv("ECP_CLIENT_ID"),
		ClientSecret: os.Getenv("ECP_CLIENT_SECRET"),
	})
	if err != nil {
		return err
	}
	fmt.Printf("enrolled agent %s\n", cfg.AgentID)
	return nil
}

func runConfigure(args []string) error {
	fs := flag.NewFlagSet("configure", flag.ContinueOnError)
	cfgPath := fs.String("config", config.DefaultPath, "configuration file to write")
	stateDir := fs.String("state-dir", defaultStateDir(), "state directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	if *stateDir != "" {
		cfg.StateDir = *stateDir
	}
	if cfg.StateDir == "" {
		return errors.New("configure: state directory is required")
	}
	if err := config.WriteAtomic(*cfgPath, cfg); err != nil {
		return err
	}
	fmt.Printf("configured agent %s\n", cfg.AgentID)
	return nil
}

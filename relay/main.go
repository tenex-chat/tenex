package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

var (
	// Version is set via ldflags at build time
	Version = "dev"
)

func defaultConfigPath() string {
	if base := os.Getenv("TENEX_BASE_DIR"); base != "" {
		return filepath.Join(base, "relay", "relay.json")
	}
	return "~/.tenex/relay/relay.json"
}

func main() {
	// Command-line flags
	configPath := flag.String("config", defaultConfigPath(), "Path to configuration file")
	port := flag.Int("port", 0, "Override port from config")
	genConfig := flag.Bool("gen-config", false, "Generate a default configuration file and exit")
	showVersion := flag.Bool("version", false, "Show version and exit")

	flag.Parse()

	// migrate subcommand: import JSONL (or legacy events.json) into BadgerDB
	// Usage: tenex-relay migrate [/path/to/export.jsonl[.gz]]
	if flag.NArg() > 0 && flag.Arg(0) == "migrate" {
		config, err := LoadConfig(*configPath)
		if err != nil {
			log.Fatalf("Failed to load configuration: %v", err)
		}
		if *port != 0 {
			config.Port = *port
		}
		inputPath := ""
		if flag.NArg() > 1 {
			inputPath = flag.Arg(1)
		}
		if err := runMigrate(config, inputPath); err != nil {
			log.Fatalf("Migration failed: %v", err)
		}
		return
	}

	// Show version
	if *showVersion {
		fmt.Printf("tenex-relay %s\n", Version)
		os.Exit(0)
	}

	// Generate config template
	if *genConfig {
		path := expandPath(*configPath)
		if err := WriteConfigTemplate(path); err != nil {
			log.Fatalf("Failed to write config template: %v", err)
		}
		fmt.Printf("Configuration template written to %s\n", path)
		os.Exit(0)
	}

	// Load configuration
	config, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	if *port != 0 {
		config.Port = *port
	}

	log.Printf("TENEX Relay %s starting...", Version)
	log.Printf("Configuration loaded from %s", expandPath(*configPath))
	log.Printf("Data directory: %s", config.DataDir)

	// Create relay
	relay, err := NewRelay(config)
	if err != nil {
		log.Fatalf("Failed to create relay: %v", err)
	}

	// Setup signal handling for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		log.Printf("Received signal %v, initiating shutdown...", sig)
		cancel()
	}()

	// Start relay
	if err := relay.Start(ctx); err != nil {
		log.Fatalf("Relay error: %v", err)
	}
}

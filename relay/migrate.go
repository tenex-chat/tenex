package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	badger "github.com/dgraph-io/badger/v4"
	evbadger "github.com/fiatjaf/eventstore/badger"
	"github.com/nbd-wtf/go-nostr"
)

// runMigrate imports events from a JSONL file (optionally gzipped) into BadgerDB.
// Pass the input path as the first non-flag argument after "migrate".
// If no path is given, falls back to <data_dir>/events.json (legacy JSON array).
func runMigrate(config *Config, inputPath string) error {
	badgerPath := filepath.Join(config.DataDir, "badger")

	if inputPath == "" {
		inputPath = filepath.Join(config.DataDir, "events.json")
	}

	if _, err := os.Stat(inputPath); os.IsNotExist(err) {
		return fmt.Errorf("input file not found: %s", inputPath)
	}

	log.Printf("Migrating from %s → %s", inputPath, badgerPath)

	db := &evbadger.BadgerBackend{
		Path: badgerPath,
		BadgerOptionsModifier: func(opts badger.Options) badger.Options {
			return opts.WithLogger(nil)
		},
	}
	if err := db.Init(); err != nil {
		return fmt.Errorf("failed to open BadgerDB: %w", err)
	}
	defer db.Close()

	f, err := os.Open(inputPath)
	if err != nil {
		return fmt.Errorf("failed to open input: %w", err)
	}
	defer f.Close()

	var reader io.Reader = f
	if strings.HasSuffix(inputPath, ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return fmt.Errorf("failed to open gzip: %w", err)
		}
		defer gz.Close()
		reader = gz
	}

	ctx := context.Background()
	total, failed := 0, 0
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 2*1024*1024), 2*1024*1024) // 2MB per line

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var evt nostr.Event
		if err := json.Unmarshal(line, &evt); err != nil {
			log.Printf("Warning: failed to decode event: %v", err)
			failed++
			continue
		}

		if nostr.IsReplaceableKind(evt.Kind) || nostr.IsAddressableKind(evt.Kind) {
			err = db.ReplaceEvent(ctx, &evt)
		} else {
			err = db.SaveEvent(ctx, &evt)
		}
		if err != nil {
			failed++
		}

		total++
		if total%50000 == 0 {
			log.Printf("  %d events imported...", total)
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read error: %w", err)
	}

	log.Printf("Migration complete: %d imported, %d failed/skipped", total, failed)
	return nil
}

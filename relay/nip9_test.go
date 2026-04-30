package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	evbadger "github.com/fiatjaf/eventstore/badger"
	"github.com/nbd-wtf/go-nostr"
)

func TestNIP9Deletion(t *testing.T) {
	// Create a temp directory for the test
	tmpDir, err := os.MkdirTemp("", "nip9-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create storage
	storage := &evbadger.BadgerBackend{
		Path:                  filepath.Join(tmpDir, "badger"),
		BadgerOptionsModifier: silentBadger,
	}
	if err := storage.Init(); err != nil {
		t.Fatalf("failed to initialize storage: %v", err)
	}
	defer storage.Close()

	ctx := context.Background()
	testPubkey := strings.Repeat("a", 64)
	otherPubkey := strings.Repeat("b", 64)

	// Create a test event
	originalEvent := &nostr.Event{
		ID:        strings.Repeat("1", 64),
		PubKey:    testPubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   "Hello, world!",
		Sig:       strings.Repeat("c", 128),
	}

	// Save the original event
	if err := storage.SaveEvent(ctx, originalEvent); err != nil {
		t.Fatalf("failed to save original event: %v", err)
	}

	// Verify event exists
	count, _ := storage.CountEvents(ctx, nostr.Filter{IDs: []string{originalEvent.ID}})
	if count != 1 {
		t.Fatalf("expected 1 event, got %d", count)
	}

	t.Run("delete event with matching pubkey", func(t *testing.T) {
		// Create a kind 5 deletion event from the same author
		deletionEvent := &nostr.Event{
			ID:        strings.Repeat("2", 64),
			PubKey:    testPubkey, // Same pubkey as original
			CreatedAt: nostr.Timestamp(time.Now().Unix()),
			Kind:      5,
			Tags:      nostr.Tags{{"e", originalEvent.ID}},
			Content:   "delete this",
			Sig:       strings.Repeat("d", 128),
		}

		// Simulate NIP-9 processing (what OnEventSaved does)
		for _, tag := range deletionEvent.Tags {
			if len(tag) >= 2 && tag[0] == "e" {
				targetID := tag[1]

				ch, err := storage.QueryEvents(ctx, nostr.Filter{
					IDs:   []string{targetID},
					Limit: 1,
				})
				if err != nil {
					t.Fatalf("failed to query event: %v", err)
				}

				for targetEvent := range ch {
					if targetEvent.PubKey == deletionEvent.PubKey {
						if err := storage.DeleteEvent(ctx, targetEvent); err != nil {
							t.Fatalf("failed to delete event: %v", err)
						}
					}
				}
			}
		}

		// Verify event is deleted
		count, _ := storage.CountEvents(ctx, nostr.Filter{IDs: []string{originalEvent.ID}})
		if count != 0 {
			t.Errorf("expected 0 events after deletion, got %d", count)
		}
	})

	t.Run("reject deletion from different pubkey", func(t *testing.T) {
		// Re-add the original event
		if err := storage.SaveEvent(ctx, originalEvent); err != nil {
			t.Fatalf("failed to re-save original event: %v", err)
		}

		// Create a deletion event from a different author
		maliciousDeletion := &nostr.Event{
			ID:        strings.Repeat("3", 64),
			PubKey:    otherPubkey, // Different pubkey!
			CreatedAt: nostr.Timestamp(time.Now().Unix()),
			Kind:      5,
			Tags:      nostr.Tags{{"e", originalEvent.ID}},
			Content:   "trying to delete someone else's event",
			Sig:       strings.Repeat("e", 128),
		}

		// Simulate NIP-9 processing - should NOT delete
		deleted := false
		for _, tag := range maliciousDeletion.Tags {
			if len(tag) >= 2 && tag[0] == "e" {
				targetID := tag[1]

				ch, err := storage.QueryEvents(ctx, nostr.Filter{
					IDs:   []string{targetID},
					Limit: 1,
				})
				if err != nil {
					t.Fatalf("failed to query event: %v", err)
				}

				for targetEvent := range ch {
					if targetEvent.PubKey == maliciousDeletion.PubKey {
						// This should NOT happen since pubkeys don't match
						deleted = true
						storage.DeleteEvent(ctx, targetEvent)
					}
				}
			}
		}

		if deleted {
			t.Error("deletion should have been rejected due to pubkey mismatch")
		}

		// Verify event still exists
		count, _ := storage.CountEvents(ctx, nostr.Filter{IDs: []string{originalEvent.ID}})
		if count != 1 {
			t.Errorf("expected event to still exist after rejected deletion, got count %d", count)
		}
	})

	t.Run("delete non-existent event", func(t *testing.T) {
		// Try to delete an event that doesn't exist
		deletionEvent := &nostr.Event{
			ID:        strings.Repeat("4", 64),
			PubKey:    testPubkey,
			CreatedAt: nostr.Timestamp(time.Now().Unix()),
			Kind:      5,
			Tags:      nostr.Tags{{"e", strings.Repeat("5", 64)}},
			Content:   "delete this",
			Sig:       strings.Repeat("f", 128),
		}

		// This should not panic or error
		for _, tag := range deletionEvent.Tags {
			if len(tag) >= 2 && tag[0] == "e" {
				targetID := tag[1]

				ch, err := storage.QueryEvents(ctx, nostr.Filter{
					IDs:   []string{targetID},
					Limit: 1,
				})
				if err != nil {
					t.Fatalf("failed to query event: %v", err)
				}

				// Should receive no events
				eventCount := 0
				for range ch {
					eventCount++
				}

				if eventCount != 0 {
					t.Errorf("expected 0 events for non-existent ID, got %d", eventCount)
				}
			}
		}
	})
}

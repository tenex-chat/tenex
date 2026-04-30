package main

import (
	"context"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func TestEphemeralCacheReplayWithinRetention(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1700000000, 0)
	cache := newEphemeralEventCache(time.Minute)
	cache.now = func() time.Time { return now }

	event := &nostr.Event{
		ID:        "event-1",
		PubKey:    "pubkey-1",
		CreatedAt: nostr.Timestamp(now.Unix()),
		Kind:      24123,
		Tags:      nostr.Tags{{"p", "target"}},
		Content:   "payload",
		Sig:       "sig-1",
	}
	cache.Store(ctx, event)

	event.Content = "mutated"
	event.Tags[0][1] = "mutated"

	events := collectCachedEvents(t, cache, nostr.Filter{
		Kinds: []int{24123},
		Tags:  nostr.TagMap{"p": []string{"target"}},
	})

	if len(events) != 1 {
		t.Fatalf("expected 1 cached event, got %d", len(events))
	}
	if events[0].Content != "payload" {
		t.Fatalf("expected cached event content to be isolated, got %q", events[0].Content)
	}
}

func TestEphemeralCacheExpiresAfterRetention(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1700000000, 0)
	cache := newEphemeralEventCache(time.Minute)
	cache.now = func() time.Time { return now }

	cache.Store(ctx, &nostr.Event{
		ID:        "event-1",
		PubKey:    "pubkey-1",
		CreatedAt: nostr.Timestamp(now.Unix()),
		Kind:      24123,
		Tags:      nostr.Tags{},
		Content:   "payload",
		Sig:       "sig-1",
	})

	now = now.Add(time.Minute + time.Nanosecond)

	events := collectCachedEvents(t, cache, nostr.Filter{Kinds: []int{24123}})
	if len(events) != 0 {
		t.Fatalf("expected cached event to expire, got %d event(s)", len(events))
	}
}

func TestEphemeralCacheHonorsKindAndLimit(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1700000000, 0)
	cache := newEphemeralEventCache(time.Minute)
	cache.now = func() time.Time { return now }

	cache.Store(ctx, &nostr.Event{
		ID:        "older",
		PubKey:    "pubkey-1",
		CreatedAt: nostr.Timestamp(now.Add(-time.Second).Unix()),
		Kind:      24123,
		Tags:      nostr.Tags{},
		Content:   "older",
		Sig:       "sig-1",
	})
	cache.Store(ctx, &nostr.Event{
		ID:        "newer",
		PubKey:    "pubkey-1",
		CreatedAt: nostr.Timestamp(now.Unix()),
		Kind:      24123,
		Tags:      nostr.Tags{},
		Content:   "newer",
		Sig:       "sig-2",
	})

	events := collectCachedEvents(t, cache, nostr.Filter{Kinds: []int{24123}, Limit: 1})
	if len(events) != 1 || events[0].ID != "newer" {
		t.Fatalf("expected newest matching event only, got %#v", events)
	}

	events = collectCachedEvents(t, cache, nostr.Filter{Kinds: []int{1}})
	if len(events) != 0 {
		t.Fatalf("expected non-ephemeral kind filter to skip cache, got %d event(s)", len(events))
	}
}

func TestRelayReplaysEphemeralEventForLaterREQ(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	cfg.Sync.Relays = nil

	relay, err := NewRelay(cfg)
	if err != nil {
		t.Fatalf("failed to create relay: %v", err)
	}
	defer relay.db.Close()

	now := time.Now()
	event := &nostr.Event{
		ID:        "event-1",
		PubKey:    "pubkey-1",
		CreatedAt: nostr.Timestamp(now.Unix()),
		Kind:      24123,
		Tags:      nostr.Tags{{"p", "target"}},
		Content:   "payload",
		Sig:       "sig-1",
	}

	if _, err := relay.khatru.AddEvent(context.Background(), event); err != nil {
		t.Fatalf("failed to add ephemeral event: %v", err)
	}

	var events []*nostr.Event
	for _, query := range relay.khatru.QueryEvents {
		ch, err := query(context.Background(), nostr.Filter{Kinds: []int{24123}})
		if err != nil {
			t.Fatalf("failed to query relay: %v", err)
		}
		for event := range ch {
			events = append(events, event)
		}
	}

	if len(events) != 1 {
		t.Fatalf("expected relay REQ path to replay 1 ephemeral event, got %d", len(events))
	}
	if events[0].ID != "event-1" {
		t.Fatalf("expected replayed event ID event-1, got %s", events[0].ID)
	}
}

func collectCachedEvents(t *testing.T, cache *ephemeralEventCache, filter nostr.Filter) []*nostr.Event {
	t.Helper()

	ch, err := cache.QueryEvents(context.Background(), filter)
	if err != nil {
		t.Fatalf("failed to query cache: %v", err)
	}

	var events []*nostr.Event
	for event := range ch {
		events = append(events, event)
	}
	return events
}

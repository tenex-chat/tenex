package main

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const ephemeralEventRetention = time.Minute

type ephemeralEventCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	entries []ephemeralEventEntry
}

type ephemeralEventEntry struct {
	event      *nostr.Event
	receivedAt time.Time
}

func newEphemeralEventCache(ttl time.Duration) *ephemeralEventCache {
	return &ephemeralEventCache{
		ttl: ttl,
		now: time.Now,
	}
}

func (c *ephemeralEventCache) Store(ctx context.Context, event *nostr.Event) {
	if c == nil || event == nil || !nostr.IsEphemeralKind(event.Kind) {
		return
	}

	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()

	c.pruneLocked(now)
	c.entries = append(c.entries, ephemeralEventEntry{
		event:      cloneNostrEvent(event),
		receivedAt: now,
	})
}

func (c *ephemeralEventCache) QueryEvents(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
	out := make(chan *nostr.Event)
	if c == nil || filter.LimitZero || !filterCanMatchEphemeral(filter) {
		close(out)
		return out, nil
	}

	now := c.now()

	c.mu.Lock()
	c.pruneLocked(now)
	events := make([]*nostr.Event, 0, len(c.entries))
	for _, entry := range c.entries {
		if filter.Matches(entry.event) {
			events = append(events, cloneNostrEvent(entry.event))
		}
	}
	c.mu.Unlock()

	sort.Slice(events, func(i, j int) bool {
		if events[i].CreatedAt == events[j].CreatedAt {
			return events[i].ID > events[j].ID
		}
		return events[i].CreatedAt > events[j].CreatedAt
	})

	go func() {
		defer close(out)
		limit := filter.Limit
		for i, event := range events {
			if limit > 0 && i >= limit {
				return
			}

			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}

func (c *ephemeralEventCache) pruneLocked(now time.Time) {
	if c.ttl <= 0 {
		c.entries = nil
		return
	}

	kept := c.entries[:0]
	for _, entry := range c.entries {
		if now.Sub(entry.receivedAt) <= c.ttl {
			kept = append(kept, entry)
		}
	}
	c.entries = kept
}

func filterCanMatchEphemeral(filter nostr.Filter) bool {
	if len(filter.Kinds) == 0 {
		return true
	}
	for _, kind := range filter.Kinds {
		if nostr.IsEphemeralKind(kind) {
			return true
		}
	}
	return false
}

func cloneNostrEvent(event *nostr.Event) *nostr.Event {
	if event == nil {
		return nil
	}

	clone := *event
	if event.Tags != nil {
		clone.Tags = make(nostr.Tags, len(event.Tags))
		for i, tag := range event.Tags {
			if tag == nil {
				continue
			}
			clone.Tags[i] = append(nostr.Tag(nil), tag...)
		}
	}
	return &clone
}

package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fiatjaf/eventstore"
	"github.com/nbd-wtf/go-nostr"
)

// RelayStatus tracks the connection status for a single sync relay
type RelayStatus struct {
	URL       string `json:"url"`
	Connected bool   `json:"connected"`
	LastError string `json:"last_error,omitempty"`
}

// SyncStats holds sync statistics exposed via /stats
type SyncStats struct {
	mu           sync.RWMutex
	EventsSynced int64                  `json:"events_synced"`
	LastSyncTime *time.Time             `json:"last_sync_time,omitempty"`
	RelayStatus  map[string]RelayStatus `json:"relay_status"`
}

func (s *SyncStats) snapshot() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	statuses := make(map[string]interface{})
	for url, rs := range s.RelayStatus {
		statuses[url] = map[string]interface{}{
			"connected":  rs.Connected,
			"last_error": rs.LastError,
		}
	}

	result := map[string]interface{}{
		"events_synced": s.EventsSynced,
		"relay_status":  statuses,
	}
	if s.LastSyncTime != nil {
		result["last_sync_time"] = s.LastSyncTime.Format(time.RFC3339)
	}
	return result
}

// Syncer manages event synchronization from remote relays
type Syncer struct {
	config        SyncConfig
	storage       eventstore.Store
	stats         SyncStats
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	OnEventStored func(*nostr.Event)
}

// NewSyncer creates a new Syncer
func NewSyncer(config SyncConfig, storage eventstore.Store) *Syncer {
	return &Syncer{
		config:  config,
		storage: storage,
		stats: SyncStats{
			RelayStatus: make(map[string]RelayStatus),
		},
	}
}

// Start launches a goroutine per sync relay
func (s *Syncer) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)

	for _, url := range s.config.Relays {
		s.stats.mu.Lock()
		s.stats.RelayStatus[url] = RelayStatus{URL: url}
		s.stats.mu.Unlock()

		s.wg.Add(1)
		go func(relayURL string) {
			defer s.wg.Done()
			s.syncRelay(ctx, relayURL)
		}(url)
	}

	log.Printf("[sync] started sync for %d relay(s), %d kind(s)", len(s.config.Relays), len(s.config.Kinds))
}

// Stop cancels all sync goroutines and waits for them to finish
func (s *Syncer) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.wg.Wait()
	log.Println("[sync] stopped")
}

// Stats returns the current sync stats snapshot
func (s *Syncer) Stats() map[string]interface{} {
	return s.stats.snapshot()
}

// syncRelay is the reconnection loop for a single relay with exponential backoff
func (s *Syncer) syncRelay(ctx context.Context, url string) {
	backoff := 5 * time.Second
	maxBackoff := 5 * time.Minute

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		err := s.runSync(ctx, url)
		if ctx.Err() != nil {
			return
		}

		s.setRelayStatus(url, false, err)

		log.Printf("[sync] %s disconnected (err: %v), reconnecting in %v", url, err, backoff)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		// Exponential backoff capped at maxBackoff
		backoff = backoff * 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// runSync connects to a relay, subscribes to configured kinds, and streams events
func (s *Syncer) runSync(ctx context.Context, url string) error {
	connectCtx, connectCancel := context.WithTimeout(ctx, 10*time.Second)
	defer connectCancel()

	relay, err := nostr.RelayConnect(connectCtx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer relay.Close()

	s.setRelayStatus(url, true, nil)
	log.Printf("[sync] connected to %s", url)

	// Subscribe to configured kinds
	filters := nostr.Filters{{
		Kinds: s.config.Kinds,
	}}

	sub, err := relay.Subscribe(ctx, filters)
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	defer sub.Unsub()

	// Scope profile refresh workers to this connection lifecycle.
	profileCtx, cancelProfile := context.WithCancel(ctx)
	defer cancelProfile()
	profileLoopStarted := false

	// Track authors for profile sync after EOSE
	var authorsMu sync.Mutex
	authors := make(map[string]struct{})
	for {
		select {
		case evt, ok := <-sub.Events:
			if !ok {
				return fmt.Errorf("subscription closed")
			}

			if err := s.storeEvent(ctx, evt); err != nil {
				log.Printf("[sync] store error for %s: %v", evt.ID[:12], err)
				continue
			}

			atomic.AddInt64(&s.stats.EventsSynced, 1)
			s.stats.mu.Lock()
			now := time.Now()
			s.stats.LastSyncTime = &now
			s.stats.mu.Unlock()

			// Collect author for profile sync
			authorsMu.Lock()
			authors[evt.PubKey] = struct{}{}
			authorsMu.Unlock()

		case <-sub.EndOfStoredEvents:
			authorsMu.Lock()
			authorList := make([]string, 0, len(authors))
			for a := range authors {
				authorList = append(authorList, a)
			}
			authorsMu.Unlock()

			log.Printf("[sync] EOSE from %s, synced %d events so far, %d unique authors",
				url, atomic.LoadInt64(&s.stats.EventsSynced), len(authorList))

			// Start one profile refresh loop per connection.
			if !profileLoopStarted {
				profileLoopStarted = true
				go s.profileSyncLoop(profileCtx, relay, &authorsMu, &authors, authorList)
			}

		case reason := <-sub.ClosedReason:
			return fmt.Errorf("relay closed subscription: %s", reason)

		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// profileSyncLoop runs an initial profile sync, then refreshes all known author
// profiles periodically (every 30 minutes). It picks up new authors that arrive
// via live events between refresh cycles.
func (s *Syncer) profileSyncLoop(ctx context.Context, relay *nostr.Relay, authorsMu *sync.Mutex, authors *map[string]struct{}, initialAuthors []string) {
	// Initial sync
	s.syncProfiles(ctx, relay, initialAuthors)

	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			authorsMu.Lock()
			authorList := make([]string, 0, len(*authors))
			for a := range *authors {
				authorList = append(authorList, a)
			}
			authorsMu.Unlock()

			if len(authorList) > 0 {
				log.Printf("[sync] periodic profile refresh for %d authors", len(authorList))
				s.syncProfiles(ctx, relay, authorList)
			}
		}
	}
}

// syncProfiles fetches kind:0 profiles for the given authors, replacing any existing ones
func (s *Syncer) syncProfiles(ctx context.Context, relay *nostr.Relay, authors []string) {
	log.Printf("[sync] fetching profiles for %d authors", len(authors))

	batchSize := 100
	for i := 0; i < len(authors); i += batchSize {
		select {
		case <-ctx.Done():
			return
		default:
		}

		end := i + batchSize
		if end > len(authors) {
			end = len(authors)
		}
		batch := authors[i:end]

		events, err := relay.QuerySync(ctx, nostr.Filter{
			Authors: batch,
			Kinds:   []int{0},
		})
		if err != nil {
			log.Printf("[sync] profile batch query failed: %v", err)
			continue
		}

		stored := 0
		for _, evt := range events {
			if err := s.storeEvent(ctx, evt); err == nil {
				stored++
			}
		}
		log.Printf("[sync] stored %d/%d profiles (batch %d-%d)", stored, len(events), i, end)
	}
}

// storeEvent saves an event, using ReplaceEvent for replaceable/addressable kinds.
func (s *Syncer) storeEvent(ctx context.Context, event *nostr.Event) error {
	var err error
	if nostr.IsReplaceableKind(event.Kind) || nostr.IsAddressableKind(event.Kind) {
		err = s.storage.ReplaceEvent(ctx, event)
	} else {
		err = s.storage.SaveEvent(ctx, event)
	}

	if err == nil && s.OnEventStored != nil {
		s.OnEventStored(event)
	}
	return err
}

func (s *Syncer) setRelayStatus(url string, connected bool, err error) {
	s.stats.mu.Lock()
	defer s.stats.mu.Unlock()

	status := RelayStatus{URL: url, Connected: connected}
	if err != nil {
		status.LastError = err.Error()
	}
	s.stats.RelayStatus[url] = status
}

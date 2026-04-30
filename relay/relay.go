package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	badger "github.com/dgraph-io/badger/v4"
	"github.com/fiatjaf/eventstore"
	evbadger "github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/nbd-wtf/go-nostr"
)

// silentBadger suppresses BadgerDB's internal logging.
func silentBadger(opts badger.Options) badger.Options {
	return opts.WithLogger(nil)
}

// Relay wraps a Khatru relay with TENEX-specific configuration
type Relay struct {
	config *Config
	khatru *khatru.Relay
	server *http.Server
	db     eventstore.Store
	syncer *Syncer
	acl    *ACL

	mu        sync.RWMutex
	startTime time.Time
}

// NewRelay creates a new relay with the given configuration
func NewRelay(config *Config) (*Relay, error) {
	if err := config.EnsureDataDir(); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	dbImpl := &evbadger.BadgerBackend{
		Path:                  filepath.Join(config.DataDir, "badger"),
		BadgerOptionsModifier: silentBadger,
	}
	if err := dbImpl.Init(); err != nil {
		return nil, fmt.Errorf("failed to initialize storage: %w", err)
	}
	var db eventstore.Store = dbImpl

	relay := khatru.NewRelay()
	ephemeralCache := newEphemeralEventCache(ephemeralEventRetention)
	relay.MaxMessageSize = int64(config.Limits.MaxMessageLength)
	recentHistoricalQueries := newHistoricalQueryReplayGuard(5 * time.Second)

	relay.Info.Name = config.NIP11.Name
	relay.Info.Description = config.NIP11.Description
	relay.Info.PubKey = config.NIP11.Pubkey
	relay.Info.Contact = config.NIP11.Contact
	supportedNIPs := make([]any, len(config.NIP11.SupportedNIPs))
	for i, nip := range config.NIP11.SupportedNIPs {
		supportedNIPs[i] = nip
	}
	relay.Info.SupportedNIPs = supportedNIPs
	relay.Info.Software = config.NIP11.Software
	relay.Info.Version = config.NIP11.Version

	relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
	relay.OnEphemeralEvent = append(relay.OnEphemeralEvent, ephemeralCache.Store)
	relay.QueryEvents = append(relay.QueryEvents, ephemeralCache.QueryEvents, instrumentQueryEvents(db.QueryEvents))
	relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)
	relay.CountEvents = append(relay.CountEvents, dbImpl.CountEvents)

	connectionLogger := newRelayConnectionLogger(config)
	relay.OnConnect = append(relay.OnConnect, connectionLogger.OnConnect)
	relay.OnDisconnect = append(relay.OnDisconnect, connectionLogger.OnDisconnect)

	// NIP-9: handle deletion events (kind 5)
	relay.OnEventSaved = append(relay.OnEventSaved, func(ctx context.Context, event *nostr.Event) {
		if event.Kind != 5 {
			return
		}
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "e" {
				targetID := tag[1]
				ch, err := db.QueryEvents(ctx, nostr.Filter{IDs: []string{targetID}, Limit: 1})
				if err != nil {
					log.Printf("NIP-9: failed to query event %s: %v", targetID, err)
					continue
				}
				for targetEvent := range ch {
					if targetEvent.PubKey == event.PubKey {
						if err := db.DeleteEvent(ctx, targetEvent); err != nil {
							log.Printf("NIP-9: failed to delete event %s: %v", targetID, err)
						} else {
							log.Printf("NIP-9: deleted event %s (requested by %s...)", truncateForLog(targetID, 12), truncateForLog(event.PubKey, 12))
						}
					} else {
						log.Printf("NIP-9: ignoring deletion request for %s (pubkey mismatch)", truncateForLog(targetID, 12))
					}
				}
			}
		}
	})

	preventLargeTags := policies.PreventLargeTags(config.Limits.MaxEventTags)
	queryRateLimiter := policies.FilterIPRateLimiter(20, time.Second, 40)
	relay.RejectEvent = append(relay.RejectEvent,
		func(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
			reject, msg = preventLargeTags(ctx, event)
			if reject {
				logRejectedEventWrite(ctx, event, msg)
			}
			return reject, msg
		},
		func(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
			if len(event.Content) > config.Limits.MaxContentLength {
				msg := fmt.Sprintf("content too large: %d > %d bytes", len(event.Content), config.Limits.MaxContentLength)
				logRejectedEventWrite(ctx, event, msg)
				return true, msg
			}
			return false, ""
		},
	)

	relay.RejectConnection = append(relay.RejectConnection,
		policies.ConnectionRateLimiter(10, time.Second, 20),
		func(r *http.Request) bool { return false },
	)

	relay.RejectFilter = append(relay.RejectFilter,
		queryRateLimiter,
		func(ctx context.Context, filter nostr.Filter) (reject bool, msg string) {
			if !config.RequireAuth || khatru.GetAuthed(ctx) != "" {
				return false, ""
			}
			// Allow unauthenticated subscriptions for ephemeral-only filters
			if len(filter.Kinds) > 0 {
				allEphemeral := true
				for _, k := range filter.Kinds {
					if !isEphemeral(k) {
						allEphemeral = false
						break
					}
				}
				if allEphemeral {
					return false, ""
				}
			}
			khatru.RequestAuth(ctx)
			return true, "auth-required: authenticate to subscribe"
		},
		policies.NoSearchQueries,
		policies.NoEmptyFilters,
		func(ctx context.Context, filter nostr.Filter) (reject bool, msg string) {
			return rejectBroadHistoricalCountFilter(filter)
		},
	)

	relay.RejectCountFilter = append(relay.RejectCountFilter,
		queryRateLimiter,
		policies.NoSearchQueries,
		policies.NoEmptyFilters,
		func(ctx context.Context, filter nostr.Filter) (reject bool, msg string) {
			return rejectBroadHistoricalCountFilter(filter)
		},
	)

	relay.OverwriteFilter = append(relay.OverwriteFilter, func(ctx context.Context, filter *nostr.Filter) {
		normalizeQueryFilter(filter, config.Limits)
		recentHistoricalQueries.Apply(ctx, filter)
	})

	acl := NewACL(config.AdminPubkeys, db, config.RequireAuth)
	relay.OverwriteFilter = append(relay.OverwriteFilter, acl.OverwriteFilterHook)
	relay.PreventBroadcast = append(relay.PreventBroadcast, acl.PreventBroadcastHook)
	relay.OnEventSaved = append(relay.OnEventSaved, acl.OnEventSavedHook)

	return &Relay{
		config: config,
		khatru: relay,
		db:     db,
		acl:    acl,
	}, nil
}

// Start starts the relay server
func (r *Relay) Start(ctx context.Context) error {
	r.mu.Lock()
	r.startTime = time.Now()
	r.mu.Unlock()
	r.acl.StartWhitelistFileSync(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", r.handleHealth)
	mux.Handle("/", r.khatru)

	addr := fmt.Sprintf("%s:%d", r.config.BindAddress, r.config.Port)
	r.server = &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	log.Printf("Starting TENEX relay on %s", addr)
	log.Printf("NIP-11 Info: %s - %s", r.config.NIP11.Name, r.config.NIP11.Description)

	errCh := make(chan error, 1)
	go func() {
		if err := r.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	if len(r.config.Sync.Relays) > 0 {
		r.syncer = NewSyncer(r.config.Sync, r.db)
		r.syncer.OnEventStored = func(event *nostr.Event) {
			if event.Kind == 14199 {
				r.acl.ProcessWhitelistEvent(event)
			}
		}
		r.syncer.Start(ctx)
	}

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return r.Shutdown()
	}
}

// Shutdown gracefully shuts down the relay
func (r *Relay) Shutdown() error {
	log.Println("Shutting down relay...")

	if r.syncer != nil {
		r.syncer.Stop()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if r.server != nil {
		if err := r.server.Shutdown(ctx); err != nil {
			log.Printf("Server shutdown error: %v", err)
		}
	}

	if r.db != nil {
		r.db.Close()
	}

	log.Println("Relay shutdown complete")
	return nil
}

func (r *Relay) handleHealth(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "healthy",
		"relay":  r.config.NIP11.Name,
	})
}

func normalizeQueryFilter(filter *nostr.Filter, limits LimitsConfig) {
	if filter == nil || filter.LimitZero {
		return
	}

	if len(filter.IDs) == 0 {
		if filter.Limit <= 0 {
			filter.Limit = limits.DefaultQueryLimit
		} else if filter.Limit > limits.MaxQueryLimit {
			filter.Limit = limits.MaxQueryLimit
		}
	}

	if shouldApplyDefaultTimeWindow(*filter) {
		since := nostr.Now() - nostr.Timestamp(int64(limits.MaxQueryWindowHours)*3600)
		filter.Since = &since
	}
}

func shouldApplyDefaultTimeWindow(filter nostr.Filter) bool {
	if filter.LimitZero {
		return false
	}
	if len(filter.IDs) > 0 {
		return false
	}
	if filter.Since != nil || filter.Until != nil {
		return false
	}
	if isReplaceableDiscoveryFilter(filter) {
		return false
	}
	return true
}

func isBroadHistoricalFilter(filter nostr.Filter) bool {
	if filter.LimitZero {
		return false
	}
	if len(filter.IDs) > 0 || len(filter.Authors) > 0 || len(filter.Tags) > 0 {
		return false
	}
	if filter.Since != nil || filter.Until != nil {
		return false
	}
	return true
}

func isReplaceableDiscoveryFilter(filter nostr.Filter) bool {
	if len(filter.Kinds) != 1 {
		return false
	}
	kind := filter.Kinds[0]
	if !(nostr.IsReplaceableKind(kind) || nostr.IsAddressableKind(kind)) {
		return false
	}
	return len(filter.Authors) > 0
}

func rejectBroadHistoricalCountFilter(filter nostr.Filter) (bool, string) {
	if isBroadHistoricalFilter(filter) {
		return true, "broad historical counts must include an author, a tag, an id, or a time bound"
	}
	return false, ""
}

type historicalQueryReplayGuard struct {
	window   time.Duration
	mu       sync.Mutex
	lastSeen map[string]time.Time
}

func newHistoricalQueryReplayGuard(window time.Duration) *historicalQueryReplayGuard {
	return &historicalQueryReplayGuard{
		window:   window,
		lastSeen: make(map[string]time.Time),
	}
}

func (g *historicalQueryReplayGuard) Apply(ctx context.Context, filter *nostr.Filter) {
	if g == nil || filter == nil || filter.LimitZero || len(filter.IDs) > 0 {
		return
	}

	ip := khatru.GetIP(ctx)
	if ip == "" {
		return
	}

	// Include authed pubkey so unauthenticated requests don't poison
	// the cache for subsequent authenticated retries after NIP-42.
	authed := khatru.GetAuthed(ctx)
	key := ip + "|" + authed + "|" + historicalQuerySignature(*filter)
	now := time.Now()

	g.mu.Lock()
	defer g.mu.Unlock()

	for k, seenAt := range g.lastSeen {
		if now.Sub(seenAt) > g.window {
			delete(g.lastSeen, k)
		}
	}

	if seenAt, ok := g.lastSeen[key]; ok && now.Sub(seenAt) <= g.window {
		filter.LimitZero = true
		log.Printf("[relay] skipped duplicate historical replay ip=%s filter=%s", ip, filter.String())
		return
	}

	g.lastSeen[key] = now
}

func historicalQuerySignature(filter nostr.Filter) string {
	var b strings.Builder

	if len(filter.Kinds) > 0 {
		b.WriteString("k:")
		for _, kind := range filter.Kinds {
			b.WriteString(fmt.Sprintf("%d,", kind))
		}
	}

	if len(filter.Authors) > 0 {
		b.WriteString("|a:")
		for _, author := range filter.Authors {
			b.WriteString(author)
			b.WriteByte(',')
		}
	}

	if len(filter.Tags) > 0 {
		keys := make([]string, 0, len(filter.Tags))
		for key := range filter.Tags {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			values := append([]string(nil), filter.Tags[key]...)
			sort.Strings(values)
			b.WriteString("|t:")
			b.WriteString(key)
			b.WriteByte('=')
			for _, value := range values {
				b.WriteString(value)
				b.WriteByte(',')
			}
		}
	}

	b.WriteString("|q:")
	b.WriteString(filter.Search)
	b.WriteString("|l:")
	b.WriteString(fmt.Sprintf("%d", filter.Limit))

	// Time bounds must be part of the signature: paginated walks reuse
	// the same kinds/authors/tags/limit but with different `since` /
	// `until` cursors. Excluding them caused the replay guard to flag
	// each page-2+ request as a duplicate and silently zero the limit.
	if filter.Since != nil {
		b.WriteString("|s:")
		b.WriteString(fmt.Sprintf("%d", *filter.Since))
	}
	if filter.Until != nil {
		b.WriteString("|u:")
		b.WriteString(fmt.Sprintf("%d", *filter.Until))
	}

	return b.String()
}

func instrumentQueryEvents(
	next func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error),
) func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
	return func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		start := time.Now()
		ch, err := next(ctx, filter)
		if err != nil || ch == nil {
			return ch, err
		}

		out := make(chan *nostr.Event)
		ip := khatru.GetIP(ctx)
		subID := ""
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[relay] panic recovering subscription id (ip=%s): %v", ip, r)
				}
			}()
			subID = khatru.GetSubscriptionID(ctx)
		}()

		go func() {
			count := 0
			for evt := range ch {
				count++
				out <- evt
			}
			close(out)

			duration := time.Since(start)
			if duration >= 250*time.Millisecond || count >= 100 {
				log.Printf("[relay] historical query ip=%s sub=%s count=%d duration=%s filter=%s", ip, subID, count, duration.Round(time.Millisecond), filter.String())
			}
		}()

		return out, nil
	}
}

func logRejectedEventWrite(ctx context.Context, event *nostr.Event, reason string) {
	eventID := truncateForLog(event.ID, 12)
	pubkey := truncateForLog(event.PubKey, 12)
	ip := khatru.GetIP(ctx)
	if ip == "" {
		ip = "unknown"
	}
	if reason == "" {
		reason = "blocked: no reason provided"
	}
	log.Printf("[relay] rejected EVENT id=%s kind=%d pubkey=%s ip=%s reason=%s", eventID, event.Kind, pubkey, ip, reason)
}

func truncateForLog(value string, max int) string {
	if value == "" {
		return "unknown"
	}
	if len(value) <= max {
		return value
	}
	return value[:max] + "..."
}

// WriteConfigTemplate writes a config template to the given path
func WriteConfigTemplate(path string) error {
	config := DefaultConfig()
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

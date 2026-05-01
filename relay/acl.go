package main

import (
	"bufio"
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fiatjaf/eventstore"
	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// deferredSub records a subscription that was deferred (LimitZero) because the
// client was not yet whitelisted. Stored so we can backfill when they are later
// added to the whitelist.
type deferredSub struct {
	ws        *khatru.WebSocket
	id        string
	filter    nostr.Filter
	ctx       context.Context // reqCtx — canceled on CLOSE or disconnect
	createdAt time.Time       // age-based expiry guards against accumulation when no 14199 ever arrives
}

// deferredSubMaxAge bounds how long a deferred subscription stays in memory
// when its owner never publishes a whitelisting event.
const deferredSubMaxAge = 30 * time.Second

// backfillDrainTimeout caps how long the drain goroutine waits to drain a
// query channel after the parent context has been canceled. Without it, a
// stuck event store could leak goroutines indefinitely.
const backfillDrainTimeout = 5 * time.Second

// ACL manages a pubkey whitelist for read access control.
// Admin pubkeys (from config) are always whitelisted. Publishing a kind 14199
// event with p-tags dynamically whitelists those tagged pubkeys. Whitelisting
// is transitive: if A whitelists B, and B has a 14199 tagging C, C also gets
// whitelisted.
type ACL struct {
	adminPubkeys map[string]bool
	whitelist    map[string]bool
	fileAllow    map[string]bool
	deferred     map[string][]deferredSub // pubkey -> pending subs awaiting whitelist
	mu           sync.RWMutex

	storage eventstore.Store

	requireAuth       bool
	whitelistFilePath string
}

func NewACL(adminPubkeys []string, storage eventstore.Store, requireAuth bool) *ACL {
	admins := make(map[string]bool, len(adminPubkeys))
	for _, pk := range adminPubkeys {
		admins[pk] = true
	}

	acl := &ACL{
		adminPubkeys:      admins,
		whitelist:         make(map[string]bool),
		fileAllow:         make(map[string]bool),
		deferred:          make(map[string][]deferredSub),
		storage:           storage,
		requireAuth:       requireAuth,
		whitelistFilePath: defaultDaemonWhitelistPath(),
	}

	acl.loadWhitelistFile()
	acl.buildWhitelistFromStorage()
	return acl
}

func (a *ACL) IsWhitelisted(pubkey string) bool {
	if pubkey == "" {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.adminPubkeys[pubkey] || a.whitelist[pubkey] || a.fileAllow[pubkey]
}

func defaultDaemonWhitelistPath() string {
	if base := os.Getenv("TENEX_BASE_DIR"); base != "" {
		return filepath.Join(base, "daemon", "whitelist.txt")
	}
	return expandPath("~/.tenex/daemon/whitelist.txt")
}

// StartWhitelistFileSync polls daemon/whitelist.txt so newly added pubkeys
// become effective without restarting the relay.
func (a *ACL) StartWhitelistFileSync(ctx context.Context) {
	// Initial refresh on startup.
	a.loadWhitelistFile()

	ticker := time.NewTicker(2 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.loadWhitelistFile()
			}
		}
	}()
}

func (a *ACL) loadWhitelistFile() {
	path := a.whitelistFilePath
	if path == "" {
		return
	}

	fileAllow := make(map[string]bool)

	file, err := os.Open(path)
	if err != nil {
		// Missing file means no daemon whitelist entries.
		if !os.IsNotExist(err) {
			log.Printf("[acl] failed to open whitelist file %s: %v", path, err)
		}
	} else {
		defer file.Close()

		scanner := bufio.NewScanner(file)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			line := strings.TrimSpace(scanner.Text())
			if idx := strings.Index(line, "#"); idx >= 0 {
				line = strings.TrimSpace(line[:idx])
			}
			if line == "" {
				continue
			}
			if !nostr.IsValidPublicKey(line) {
				log.Printf("[acl] ignoring invalid pubkey in %s:%d", path, lineNo)
				continue
			}
			fileAllow[line] = true
		}
		if err := scanner.Err(); err != nil {
			log.Printf("[acl] failed reading whitelist file %s: %v", path, err)
		}
	}

	a.mu.Lock()
	prev := a.fileAllow
	changed := !samePubkeySet(prev, fileAllow)
	a.fileAllow = fileAllow
	a.mu.Unlock()

	if changed {
		log.Printf("[acl] loaded %d pubkey(s) from whitelist file %s", len(fileAllow), path)
	}
}

func samePubkeySet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// buildWhitelistFromStorage queries all stored 14199 events and whitelists
// every p-tagged pubkey.  A 14199 is self-authorizing: the author signed it,
// so we trust their declaration of backends/agents unconditionally.
func (a *ACL) buildWhitelistFromStorage() {
	ch, err := a.storage.QueryEvents(context.Background(), nostr.Filter{
		Kinds: []int{14199},
	})
	if err != nil {
		log.Printf("[acl] failed to query stored 14199 events: %v", err)
		return
	}

	for evt := range ch {
		// Whitelist the 14199 author themselves
		if !a.adminPubkeys[evt.PubKey] && !a.whitelist[evt.PubKey] {
			a.whitelist[evt.PubKey] = true
			log.Printf("[acl] whitelisted author %s... (published 14199)", truncatePubkey(evt.PubKey))
		}

		for _, tag := range evt.Tags {
			if len(tag) >= 2 && tag[0] == "p" {
				pk := tag[1]
				if !a.adminPubkeys[pk] && !a.whitelist[pk] {
					a.whitelist[pk] = true
					log.Printf("[acl] whitelisted %s... (from stored 14199 by %s...)", truncatePubkey(pk), truncatePubkey(evt.PubKey))
				}
			}
		}
	}

	log.Printf("[acl] built whitelist: %d admin(s), %d dynamic entries", len(a.adminPubkeys), len(a.whitelist))
}

// ProcessWhitelistEvent handles a kind 14199 event.  A 14199 is
// self-authorizing: any authenticated user can publish one to declare
// their backends/agents.  The author and all p-tagged pubkeys are
// whitelisted unconditionally.
func (a *ACL) ProcessWhitelistEvent(event *nostr.Event) {
	if event.Kind != 14199 {
		return
	}

	a.mu.Lock()

	var newlyWhitelisted []string

	if !a.adminPubkeys[event.PubKey] && !a.whitelist[event.PubKey] {
		a.whitelist[event.PubKey] = true
		newlyWhitelisted = append(newlyWhitelisted, event.PubKey)
		log.Printf("[acl] whitelisted author %s... (published 14199)", truncatePubkey(event.PubKey))
	}

	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			pk := tag[1]
			if !a.adminPubkeys[pk] && !a.whitelist[pk] {
				a.whitelist[pk] = true
				newlyWhitelisted = append(newlyWhitelisted, pk)
				log.Printf("[acl] whitelisted %s... (14199 from %s...)", truncatePubkey(pk), truncatePubkey(event.PubKey))
			}
		}
	}

	// Pull deferred subs for newly whitelisted pubkeys while still under lock.
	a.pruneExpiredDeferredLocked(time.Now())
	toBackfill := make(map[string][]deferredSub, len(newlyWhitelisted))
	for _, pk := range newlyWhitelisted {
		if subs := a.deferred[pk]; len(subs) > 0 {
			toBackfill[pk] = subs
			delete(a.deferred, pk)
		}
	}

	a.mu.Unlock()

	for pk, subs := range toBackfill {
		go a.backfillSubs(pk, subs)
	}
}

func (a *ACL) backfillSubs(pubkey string, subs []deferredSub) {
	now := time.Now()
	for _, sub := range subs {
		if sub.ctx.Err() != nil {
			continue // subscription already closed or connection dropped
		}
		if now.Sub(sub.createdAt) > deferredSubMaxAge {
			continue // owner took too long; the client will resubscribe if still interested
		}
		ch, err := a.storage.QueryEvents(sub.ctx, sub.filter)
		if err != nil {
			log.Printf("[acl] backfill query failed for %s...: %v", truncatePubkey(pubkey), err)
			continue
		}
		count := 0
		for event := range ch {
			if sub.ctx.Err() != nil {
				drainBackfillChannel(ch)
				break
			}
			sub.ws.WriteJSON(nostr.EventEnvelope{SubscriptionID: &sub.id, Event: *event})
			count++
		}
		log.Printf("[acl] backfilled %d event(s) to %s... (sub %s)", count, truncatePubkey(pubkey), sub.id)
	}
}

// drainBackfillChannel consumes any remaining events from a backfill query
// channel after its associated subscription context was canceled. The drain is
// bounded by backfillDrainTimeout so a wedged event store cannot leak goroutines.
func drainBackfillChannel(ch <-chan *nostr.Event) {
	go func() {
		drainCtx, cancel := context.WithTimeout(context.Background(), backfillDrainTimeout)
		defer cancel()
		for {
			select {
			case _, ok := <-ch:
				if !ok {
					return
				}
			case <-drainCtx.Done():
				log.Printf("[acl] abandoned backfill drain after %s", backfillDrainTimeout)
				return
			}
		}
	}()
}

// pruneExpiredDeferredLocked drops deferred subscriptions older than
// deferredSubMaxAge. Caller must hold a.mu for writing.
func (a *ACL) pruneExpiredDeferredLocked(now time.Time) {
	for pk, subs := range a.deferred {
		kept := subs[:0]
		for _, sub := range subs {
			if sub.ctx.Err() == nil && now.Sub(sub.createdAt) <= deferredSubMaxAge {
				kept = append(kept, sub)
			}
		}
		// Clear the tail of the backing array so dropped entries' websocket,
		// context, and filter pointers become unreachable and GC-eligible.
		// Without this, reusing subs[:0] keeps those pointers alive in the
		// underlying array until the slot is later overwritten.
		for i := len(kept); i < len(subs); i++ {
			subs[i] = deferredSub{}
		}
		if len(kept) == 0 {
			delete(a.deferred, pk)
		} else {
			a.deferred[pk] = kept
		}
	}
}

// Public readable kinds are available to authenticated non-whitelisted users.
// These are TENEX metadata streams that should be broadly visible.
func isPublicReadableKind(kind int) bool {
	return kind == 4199 || kind == 14199 || kind == 34199
}

// isEphemeral returns true for kinds 20000-29999
func isEphemeral(kind int) bool {
	return kind >= 20000 && kind <= 29999
}

func isNonRestrictedKind(kind int) bool {
	return isEphemeral(kind) || isPublicReadableKind(kind)
}

// OverwriteFilterHook defers subscriptions for authenticated but non-whitelisted
// pubkeys by setting LimitZero, which skips stored event queries but still
// registers the listener for live events.
//
// Exception: filters that request only public-readable kinds (4199, 34199) or
// ephemeral kinds are allowed for non-whitelisted users.
//
// Unauthenticated users are left unmodified so RejectFilter can send
// auth-required.
func (a *ACL) OverwriteFilterHook(ctx context.Context, filter *nostr.Filter) {
	if !a.requireAuth {
		return
	}

	// Filters that request only non-restricted kinds bypass ACL.
	if len(filter.Kinds) > 0 {
		allNonRestricted := true
		for _, k := range filter.Kinds {
			if !isNonRestrictedKind(k) {
				allNonRestricted = false
				break
			}
		}
		if allNonRestricted {
			return
		}
	}

	pubkey := khatru.GetAuthed(ctx)

	// Not authenticated: don't set LimitZero, let RejectFilter handle auth-required
	if pubkey == "" {
		return
	}

	// Authenticated and whitelisted: allow normally
	if a.IsWhitelisted(pubkey) {
		return
	}

	// Authenticated but not whitelisted: record the sub for later backfill, then defer.
	ws := khatru.GetConnection(ctx)
	subID := khatru.GetSubscriptionID(ctx)
	filterCopy := *filter // copy before LimitZero is set

	a.mu.Lock()
	a.pruneExpiredDeferredLocked(time.Now())
	a.deferred[pubkey] = append(a.deferred[pubkey], deferredSub{
		ws:        ws,
		id:        subID,
		filter:    filterCopy,
		ctx:       ctx,
		createdAt: time.Now(),
	})
	a.mu.Unlock()

	filter.LimitZero = true
	log.Printf("[acl] deferred subscription for non-whitelisted pubkey %s...", truncatePubkey(pubkey))
}

// PreventBroadcastHook blocks live event delivery to non-whitelisted
// subscribers.
//
// Exceptions for non-whitelisted users:
// - Ephemeral events (20000-29999)
// - Public readable events (4199, 34199)
func (a *ACL) PreventBroadcastHook(ws *khatru.WebSocket, event *nostr.Event) bool {
	if !a.requireAuth {
		return false
	}

	if isNonRestrictedKind(event.Kind) {
		return false
	}

	if a.IsWhitelisted(ws.AuthedPublicKey) {
		return false
	}

	return true
}

// OnEventSavedHook processes kind 14199 events to update the whitelist.
func (a *ACL) OnEventSavedHook(ctx context.Context, event *nostr.Event) {
	if event.Kind != 14199 {
		return
	}
	a.ProcessWhitelistEvent(event)
}

func truncatePubkey(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

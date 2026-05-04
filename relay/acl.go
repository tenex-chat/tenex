package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/fiatjaf/eventstore"
	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// activeSub records an open subscription for a non-backend authenticated
// viewer. It exists so we can backfill the subscription if the viewer's
// access expands later — either by being added to the backend whitelist via
// kind 14199, or by being added as a member to a private project via 31933.
type activeSub struct {
	ws     *khatru.WebSocket
	subID  string
	filter nostr.Filter
	ctx    context.Context // canceled on CLOSE or disconnect
}

// ACL combines two layers of access control:
//
//   - A backend-tier whitelist of pubkeys derived from kind 14199 events
//     (TENEX backend agents / operators). Whitelisted pubkeys read everything.
//   - A per-project registry derived from kind 31933 events that gates
//     visibility of private projects and events a-tagging them. Non-whitelisted
//     authenticated viewers are filtered against this registry at delivery time.
//
// Open non-backend subscriptions are tracked so they can be backfilled with
// previously-hidden events when the viewer's access expands.
type ACL struct {
	whitelist map[string]bool
	mu        sync.RWMutex

	storage  eventstore.Store
	registry *ProjectRegistry

	subsMu     sync.Mutex
	activeSubs map[string][]*activeSub
}

func NewACL(storage eventstore.Store) *ACL {
	acl := &ACL{
		whitelist:  make(map[string]bool),
		storage:    storage,
		registry:   NewProjectRegistry(),
		activeSubs: make(map[string][]*activeSub),
	}

	acl.buildFromStorage()
	return acl
}

// Registry exposes the project registry for filter wrappers.
func (a *ACL) Registry() *ProjectRegistry { return a.registry }

// IsBackendWhitelisted reports whether pubkey has unrestricted read access.
func (a *ACL) IsBackendWhitelisted(pubkey string) bool {
	if pubkey == "" {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.whitelist[pubkey]
}

// buildFromStorage seeds the backend whitelist from stored kind 14199 events
// and the project registry from stored kind 31933 events.
func (a *ACL) buildFromStorage() {
	ch14199, err := a.storage.QueryEvents(context.Background(), nostr.Filter{
		Kinds: []int{14199},
	})
	if err != nil {
		log.Printf("[acl] failed to query stored 14199 events: %v", err)
	} else {
		for evt := range ch14199 {
			for _, tag := range evt.Tags {
				if len(tag) >= 2 && tag[0] == "p" {
					pk := tag[1]
					if !a.whitelist[pk] {
						a.whitelist[pk] = true
						log.Printf("[acl] whitelisted %s... (from stored 14199 by %s...)", truncatePubkey(pk), truncatePubkey(evt.PubKey))
					}
				}
			}
		}
	}

	ch31933, err := a.storage.QueryEvents(context.Background(), nostr.Filter{
		Kinds: []int{projectKind},
	})
	if err != nil {
		log.Printf("[acl] failed to query stored 31933 events: %v", err)
	} else {
		count := 0
		for evt := range ch31933 {
			a.registry.Upsert(evt)
			count++
		}
		log.Printf("[acl] loaded %d project(s) into registry", count)
	}

	log.Printf("[acl] backend whitelist: %d entries", len(a.whitelist))
}

// ProcessWhitelistEvent handles a kind 14199 event: every p-tagged pubkey is
// added to the backend whitelist, and any of their open subscriptions are
// backfilled with previously-hidden events.
func (a *ACL) ProcessWhitelistEvent(event *nostr.Event) {
	if event.Kind != 14199 {
		return
	}

	a.mu.Lock()
	var newlyWhitelisted []string
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			pk := tag[1]
			if !a.whitelist[pk] {
				a.whitelist[pk] = true
				newlyWhitelisted = append(newlyWhitelisted, pk)
				log.Printf("[acl] whitelisted %s... (14199 from %s...)", truncatePubkey(pk), truncatePubkey(event.PubKey))
			}
		}
	}
	a.mu.Unlock()

	for _, pk := range newlyWhitelisted {
		go a.backfillBackendGrant(pk)
	}
}

// PreventBroadcastHook gates live event delivery. Backend-whitelisted viewers
// receive everything; everyone else is filtered through the project registry.
//
// As an extension to the project ACL: an event that would otherwise be hidden
// is still delivered if it e-tags any event the viewer authored. This keeps
// non-members in the loop on replies to their own posts inside private
// projects they don't belong to.
func (a *ACL) PreventBroadcastHook(ws *khatru.WebSocket, event *nostr.Event) bool {
	viewer := ws.AuthedPublicKey
	if a.IsBackendWhitelisted(viewer) {
		return false
	}
	if a.registry.CanDeliver(viewer, event) {
		return false
	}
	if a.viewerAuthoredAnyETaggedEvent(viewer, event) {
		return false
	}
	return true
}

// viewerAuthoredAnyETaggedEvent reports whether viewer is the author of any
// event referenced by an "e" tag on event. It runs a single targeted storage
// query (IDs ∩ Authors) so the cost stays bounded even when the event has
// many e-tags.
func (a *ACL) viewerAuthoredAnyETaggedEvent(viewer string, event *nostr.Event) bool {
	if viewer == "" || event == nil {
		return false
	}
	var ids []string
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "e" && tag[1] != "" {
			ids = append(ids, tag[1])
		}
	}
	if len(ids) == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ch, err := a.storage.QueryEvents(ctx, nostr.Filter{
		IDs:     ids,
		Authors: []string{viewer},
		Limit:   1,
	})
	if err != nil {
		log.Printf("[acl] e-tag ownership lookup failed for %s...: %v", truncatePubkey(viewer), err)
		return false
	}
	found := false
	for range ch {
		found = true
		// Drain remaining (shouldn't happen with Limit:1 but be defensive).
	}
	return found
}

// processProjectEvent records a kind 31933 event in the project registry and
// backfills open subscriptions for newly-granted members.
func (a *ACL) processProjectEvent(event *nostr.Event) {
	prev := a.registry.Upsert(event)
	if event == nil || event.Kind != projectKind {
		return
	}

	current := a.registry.Get(projectAddress(event.PubKey, projectDTag(event)))
	if current == nil {
		return
	}

	newMembers := diffNewMembers(prev, current)
	for _, pk := range newMembers {
		go a.backfillProjectGrant(pk)
	}
}

// OnEventSavedHook routes kind 14199 (backend whitelist) and kind 31933
// (project registry) updates to their respective handlers.
func (a *ACL) OnEventSavedHook(ctx context.Context, event *nostr.Event) {
	switch event.Kind {
	case 14199:
		a.ProcessWhitelistEvent(event)
	case projectKind:
		a.processProjectEvent(event)
	}
}

// OverwriteFilterHook records the open subscription so it can be backfilled
// later if the viewer is granted backend access (14199) or added to a private
// project (31933). Backend-whitelisted viewers and unauthenticated requests
// are not tracked.
func (a *ACL) OverwriteFilterHook(ctx context.Context, filter *nostr.Filter) {
	pubkey := khatru.GetAuthed(ctx)
	if pubkey == "" || a.IsBackendWhitelisted(pubkey) {
		return
	}

	ws := khatru.GetConnection(ctx)
	subID := khatru.GetSubscriptionID(ctx)
	if ws == nil || subID == "" {
		return
	}

	sub := &activeSub{
		ws:     ws,
		subID:  subID,
		filter: *filter,
		ctx:    ctx,
	}
	a.registerSub(pubkey, sub)
}

func (a *ACL) registerSub(viewer string, sub *activeSub) {
	a.subsMu.Lock()
	a.activeSubs[viewer] = append(a.activeSubs[viewer], sub)
	a.subsMu.Unlock()

	go func() {
		<-sub.ctx.Done()
		a.unregisterSub(viewer, sub)
	}()
}

func (a *ACL) unregisterSub(viewer string, sub *activeSub) {
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	subs := a.activeSubs[viewer]
	for i, s := range subs {
		if s == sub {
			a.activeSubs[viewer] = append(subs[:i], subs[i+1:]...)
			break
		}
	}
	if len(a.activeSubs[viewer]) == 0 {
		delete(a.activeSubs, viewer)
	}
}

func (a *ACL) snapshotSubs(viewer string) []*activeSub {
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	subs := a.activeSubs[viewer]
	out := make([]*activeSub, len(subs))
	copy(out, subs)
	return out
}

// backfillBackendGrant ships every event matching each open subscription's
// filter, since the viewer is now backend-tier and may read everything.
func (a *ACL) backfillBackendGrant(viewer string) {
	subs := a.snapshotSubs(viewer)
	for _, sub := range subs {
		a.replayUnfiltered(sub, viewer)
	}
}

// backfillProjectGrant ships matching events to the viewer's open
// subscriptions, applying the (now more permissive) project ACL. The client
// may receive duplicates of events it already saw; events are idempotent by id.
func (a *ACL) backfillProjectGrant(viewer string) {
	subs := a.snapshotSubs(viewer)
	for _, sub := range subs {
		a.replayWithACL(sub, viewer)
	}
}

func (a *ACL) replayUnfiltered(sub *activeSub, viewer string) {
	if sub.ctx.Err() != nil {
		return
	}
	ch, err := a.storage.QueryEvents(sub.ctx, sub.filter)
	if err != nil {
		log.Printf("[acl] backfill query failed for %s...: %v", truncatePubkey(viewer), err)
		return
	}
	count := 0
	for evt := range ch {
		if sub.ctx.Err() != nil {
			drain(ch)
			break
		}
		sub.ws.WriteJSON(nostr.EventEnvelope{SubscriptionID: &sub.subID, Event: *evt})
		count++
	}
	log.Printf("[acl] backend backfill: sent %d event(s) to %s... (sub %s)", count, truncatePubkey(viewer), sub.subID)
}

func (a *ACL) replayWithACL(sub *activeSub, viewer string) {
	if sub.ctx.Err() != nil {
		return
	}
	ch, err := a.storage.QueryEvents(sub.ctx, sub.filter)
	if err != nil {
		log.Printf("[acl] project backfill query failed for %s...: %v", truncatePubkey(viewer), err)
		return
	}
	count := 0
	for evt := range ch {
		if sub.ctx.Err() != nil {
			drain(ch)
			break
		}
		if !a.registry.CanDeliver(viewer, evt) {
			continue
		}
		sub.ws.WriteJSON(nostr.EventEnvelope{SubscriptionID: &sub.subID, Event: *evt})
		count++
	}
	log.Printf("[acl] project backfill: sent %d event(s) to %s... (sub %s)", count, truncatePubkey(viewer), sub.subID)
}

func drain(ch chan *nostr.Event) {
	go func() {
		for range ch {
		}
	}()
}

// projectDTag returns the d-tag of a kind 31933 event, or "" if absent.
func projectDTag(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "d" {
			return tag[1]
		}
	}
	return ""
}

// diffNewMembers returns members present in current but not in prev. The author
// is treated as an implicit member; transitions in authorship are also
// reported. Empty pubkeys are skipped.
func diffNewMembers(prev, current *ProjectACL) []string {
	if current == nil {
		return nil
	}
	prevSet := map[string]struct{}{}
	if prev != nil {
		if prev.AuthorPubkey != "" {
			prevSet[prev.AuthorPubkey] = struct{}{}
		}
		for pk := range prev.Members {
			prevSet[pk] = struct{}{}
		}
	}

	var out []string
	add := func(pk string) {
		if pk == "" {
			return
		}
		if _, seen := prevSet[pk]; seen {
			return
		}
		prevSet[pk] = struct{}{} // dedupe within current
		out = append(out, pk)
	}

	add(current.AuthorPubkey)
	for pk := range current.Members {
		add(pk)
	}
	return out
}

func truncatePubkey(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

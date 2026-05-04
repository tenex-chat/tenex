package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	evbadger "github.com/fiatjaf/eventstore/badger"
	"github.com/nbd-wtf/go-nostr"
)

func makePubkey(b byte) string { return strings.Repeat(string([]byte{b}), 64) }

func projectEvent(author, dTag string, members []string, private bool) *nostr.Event {
	tags := nostr.Tags{{"d", dTag}}
	for _, m := range members {
		tags = append(tags, nostr.Tag{"p", m})
	}
	if private {
		tags = append(tags, nostr.Tag{"scope", "private"})
	}
	return &nostr.Event{
		Kind:   projectKind,
		PubKey: author,
		Tags:   tags,
	}
}

func aTagEvent(author string, projectAddrs ...string) *nostr.Event {
	tags := nostr.Tags{}
	for _, addr := range projectAddrs {
		tags = append(tags, nostr.Tag{"a", addr})
	}
	return &nostr.Event{Kind: 1, PubKey: author, Tags: tags}
}

func TestParseProjectAddress(t *testing.T) {
	cases := []struct {
		in     string
		author string
		dTag   string
		ok     bool
	}{
		{"31933:" + makePubkey('a') + ":proj-1", makePubkey('a'), "proj-1", true},
		{"31933:" + makePubkey('a') + ":has:colon", makePubkey('a'), "has:colon", true},
		{"30023:" + makePubkey('a') + ":x", "", "", false},
		{"31933:abc", "", "", false},
		{"31933::dtag", "", "", false},
		{"31933:abc:", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		author, dTag, ok := parseProjectAddress(c.in)
		if ok != c.ok || author != c.author || dTag != c.dTag {
			t.Errorf("parseProjectAddress(%q) = (%q,%q,%v), want (%q,%q,%v)", c.in, author, dTag, ok, c.author, c.dTag, c.ok)
		}
	}
}

func TestEventScopeIsPrivate(t *testing.T) {
	if eventScopeIsPrivate(&nostr.Event{Tags: nostr.Tags{{"scope", "public"}}}) {
		t.Error("expected non-private for scope=public")
	}
	if !eventScopeIsPrivate(&nostr.Event{Tags: nostr.Tags{{"scope", "private"}}}) {
		t.Error("expected private for scope=private")
	}
	if eventScopeIsPrivate(&nostr.Event{}) {
		t.Error("expected non-private when scope tag absent")
	}
}

func TestRegistryUpsertReplacesByAddress(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')

	r.Upsert(projectEvent(author, "p1", []string{makePubkey('b')}, false))
	if got := r.Get(projectAddress(author, "p1")); got == nil || got.IsPrivate || len(got.Members) != 1 {
		t.Fatalf("first upsert: unexpected ACL %+v", got)
	}

	// Second event for same (author, dTag) replaces, now private with two members.
	r.Upsert(projectEvent(author, "p1", []string{makePubkey('b'), makePubkey('c')}, true))
	got := r.Get(projectAddress(author, "p1"))
	if got == nil || !got.IsPrivate || len(got.Members) != 2 {
		t.Fatalf("upsert did not replace: %+v", got)
	}

	// Non-31933 events ignored.
	r.Upsert(&nostr.Event{Kind: 1, PubKey: author})
	if r.Get(projectAddress(author, "p1")) == nil {
		t.Fatal("non-31933 event affected registry")
	}
}

func TestCanDeliverPublicProject(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')
	stranger := makePubkey('z')

	pub := projectEvent(author, "p1", nil, false)
	r.Upsert(pub)

	if !r.CanDeliver(stranger, pub) {
		t.Error("public 31933 must be visible to strangers")
	}
	if !r.CanDeliver(stranger, aTagEvent(stranger, projectAddress(author, "p1"))) {
		t.Error("event a-tagging public project must be visible to its author")
	}
	if !r.CanDeliver(stranger, aTagEvent(makePubkey('y'), projectAddress(author, "p1"))) {
		t.Error("event a-tagging public project must be visible to bystanders")
	}
}

func TestCanDeliverPrivateProject(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')
	member := makePubkey('b')
	stranger := makePubkey('z')

	priv := projectEvent(author, "secret", []string{member}, true)
	r.Upsert(priv)
	addr := projectAddress(author, "secret")

	// Rule 2: 31933 visibility
	if !r.CanDeliver(author, priv) {
		t.Error("author must see own private 31933")
	}
	if !r.CanDeliver(member, priv) {
		t.Error("member must see private 31933")
	}
	if r.CanDeliver(stranger, priv) {
		t.Error("stranger must not see private 31933")
	}

	// Rule 3: a-tagging private project
	strangerEvt := aTagEvent(stranger, addr)
	if !r.CanDeliver(stranger, strangerEvt) {
		t.Error("stranger must see their own event a-tagging private project")
	}
	memberEvt := aTagEvent(member, addr)
	if r.CanDeliver(stranger, memberEvt) {
		t.Error("stranger must NOT see member's event a-tagging private project")
	}
	if !r.CanDeliver(member, memberEvt) {
		t.Error("member must see events a-tagging private project")
	}
	if !r.CanDeliver(author, memberEvt) {
		t.Error("project author must see events a-tagging private project")
	}
}

func TestCanDeliverMixedATags(t *testing.T) {
	r := NewProjectRegistry()
	authorA := makePubkey('a')
	authorB := makePubkey('b')
	memberA := makePubkey('c')
	stranger := makePubkey('z')

	r.Upsert(projectEvent(authorA, "private-a", []string{memberA}, true))
	r.Upsert(projectEvent(authorB, "public-b", nil, false))

	addrPrivate := projectAddress(authorA, "private-a")
	addrPublic := projectAddress(authorB, "public-b")

	mixed := aTagEvent(makePubkey('y'), addrPublic, addrPrivate)

	if r.CanDeliver(stranger, mixed) {
		t.Error("event referencing inaccessible private project must be hidden even when also a-tagging a public one")
	}
	if !r.CanDeliver(memberA, mixed) {
		t.Error("member of the private project must see the mixed event")
	}

	// All-public a-tags pass through for everyone.
	publicOnly := aTagEvent(makePubkey('y'), addrPublic)
	if !r.CanDeliver(stranger, publicOnly) {
		t.Error("event a-tagging only public projects must be visible to strangers")
	}
}

func TestCanDeliverUnknownAddressableTagsIgnored(t *testing.T) {
	r := NewProjectRegistry()
	stranger := makePubkey('z')

	// a-tag pointing at a non-31933 addressable kind is irrelevant to project ACL.
	evt := &nostr.Event{
		Kind:   1,
		PubKey: makePubkey('y'),
		Tags:   nostr.Tags{{"a", "30023:" + makePubkey('a') + ":article"}},
	}
	if !r.CanDeliver(stranger, evt) {
		t.Error("non-31933 a-tags must not trigger project filtering")
	}

	// Unknown 31933 reference (not yet in registry) is treated as public.
	evt2 := aTagEvent(makePubkey('y'), projectAddress(makePubkey('a'), "unknown"))
	if !r.CanDeliver(stranger, evt2) {
		t.Error("unknown 31933 reference must not block delivery")
	}
}

func TestProjectACLIsMember(t *testing.T) {
	author := makePubkey('a')
	member := makePubkey('b')
	acl := &ProjectACL{
		AuthorPubkey: author,
		Members:      map[string]struct{}{member: {}},
	}
	if !acl.IsMember(author) {
		t.Error("author must be a member")
	}
	if !acl.IsMember(member) {
		t.Error("p-tagged pubkey must be a member")
	}
	if acl.IsMember(makePubkey('z')) {
		t.Error("stranger must not be a member")
	}
	if acl.IsMember("") {
		t.Error("empty pubkey must not be a member")
	}
	var nilACL *ProjectACL
	if nilACL.IsMember(author) {
		t.Error("nil ACL must not report membership")
	}
}

func TestUpsertRespectsTimestamp(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')

	newer := projectEvent(author, "p1", []string{makePubkey('b')}, true)
	newer.CreatedAt = 200
	r.Upsert(newer)

	stale := projectEvent(author, "p1", []string{makePubkey('c')}, false)
	stale.CreatedAt = 100 // older
	r.Upsert(stale)

	got := r.Get(projectAddress(author, "p1"))
	if got == nil || !got.IsPrivate {
		t.Fatal("stale event must not overwrite newer state")
	}
	if _, ok := got.Members[makePubkey('b')]; !ok {
		t.Error("stale event must not replace member set")
	}
}

func TestUpsertReturnsPrevious(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')

	e1 := projectEvent(author, "p1", []string{makePubkey('b')}, false)
	e1.CreatedAt = 100
	if prev := r.Upsert(e1); prev != nil {
		t.Errorf("first upsert: expected nil previous, got %+v", prev)
	}

	e2 := projectEvent(author, "p1", []string{makePubkey('b'), makePubkey('c')}, true)
	e2.CreatedAt = 200
	prev := r.Upsert(e2)
	if prev == nil {
		t.Fatal("second upsert: expected non-nil previous")
	}
	if prev.IsPrivate {
		t.Error("returned previous should reflect prior state, not new state")
	}
	if _, ok := prev.Members[makePubkey('c')]; ok {
		t.Error("previous should not include the new member")
	}
}

func TestRegistryDelete(t *testing.T) {
	r := NewProjectRegistry()
	author := makePubkey('a')
	r.Upsert(projectEvent(author, "p1", nil, true))
	addr := projectAddress(author, "p1")
	if r.Get(addr) == nil {
		t.Fatal("project not stored")
	}
	r.Delete(addr)
	if r.Get(addr) != nil {
		t.Error("project not removed by Delete")
	}
}

func TestDiffNewMembers(t *testing.T) {
	a := makePubkey('a')
	b := makePubkey('b')
	c := makePubkey('c')

	prev := &ProjectACL{AuthorPubkey: a, Members: map[string]struct{}{b: {}}}
	curr := &ProjectACL{AuthorPubkey: a, Members: map[string]struct{}{b: {}, c: {}}}

	got := diffNewMembers(prev, curr)
	if len(got) != 1 || got[0] != c {
		t.Errorf("expected [%s], got %v", c, got)
	}

	// Brand-new project: every member (and the author) is new.
	got = diffNewMembers(nil, curr)
	if len(got) != 3 {
		t.Errorf("expected 3 new members for fresh project, got %v", got)
	}

	// No diff when membership is unchanged.
	got = diffNewMembers(curr, curr)
	if len(got) != 0 {
		t.Errorf("expected no new members on identity diff, got %v", got)
	}
}

func TestViewerAuthoredAnyETaggedEvent(t *testing.T) {
	tmp, err := os.MkdirTemp("", "live-etag-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	defer os.RemoveAll(tmp)

	storage := &evbadger.BadgerBackend{
		Path:                  filepath.Join(tmp, "badger"),
		BadgerOptionsModifier: silentBadger,
	}
	if err := storage.Init(); err != nil {
		t.Fatalf("init storage: %v", err)
	}
	defer storage.Close()

	// Use hex-valid pubkey/id strings — BadgerBackend hex-decodes them.
	viewer := makePubkey('a')
	stranger := makePubkey('b')

	ownEventID := strings.Repeat("1", 64)
	if err := storage.SaveEvent(context.Background(), &nostr.Event{
		ID:        ownEventID,
		PubKey:    viewer,
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   "mine",
		Sig:       strings.Repeat("a", 128),
	}); err != nil {
		t.Fatalf("save own event: %v", err)
	}

	otherEventID := strings.Repeat("2", 64)
	if err := storage.SaveEvent(context.Background(), &nostr.Event{
		ID:        otherEventID,
		PubKey:    stranger,
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   "stranger's",
		Sig:       strings.Repeat("b", 128),
	}); err != nil {
		t.Fatalf("save other event: %v", err)
	}

	acl := &ACL{
		whitelist:  make(map[string]bool),
		storage:    storage,
		registry:   NewProjectRegistry(),
		activeSubs: make(map[string][]*activeSub),
	}

	reply := &nostr.Event{
		Kind:   1,
		PubKey: stranger,
		Tags:   nostr.Tags{{"e", ownEventID}, {"p", viewer}},
	}
	if !acl.viewerAuthoredAnyETaggedEvent(viewer, reply) {
		t.Error("expected viewer ownership to be detected via e-tag")
	}

	unrelated := &nostr.Event{
		Kind:   1,
		PubKey: stranger,
		Tags:   nostr.Tags{{"e", otherEventID}},
	}
	if acl.viewerAuthoredAnyETaggedEvent(viewer, unrelated) {
		t.Error("e-tag pointing at someone else's event must not match")
	}

	noETags := &nostr.Event{Kind: 1, PubKey: stranger}
	if acl.viewerAuthoredAnyETaggedEvent(viewer, noETags) {
		t.Error("event without e-tags must not match")
	}

	if acl.viewerAuthoredAnyETaggedEvent("", reply) {
		t.Error("empty viewer must short-circuit to false")
	}
}

func TestEventReferencesOwnedID(t *testing.T) {
	owned := map[string]struct{}{"abc": {}}

	yes := &nostr.Event{Tags: nostr.Tags{{"e", "abc"}}}
	if !eventReferencesOwnedID(yes, owned) {
		t.Error("event e-tagging owned id should match")
	}

	no := &nostr.Event{Tags: nostr.Tags{{"e", "other"}, {"p", "abc"}}}
	if eventReferencesOwnedID(no, owned) {
		t.Error("p-tag with owned id must not match (only e-tags count)")
	}

	if eventReferencesOwnedID(yes, nil) {
		t.Error("nil owned set must never match")
	}
}

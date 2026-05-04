package main

import (
	"strings"
	"sync"

	"github.com/nbd-wtf/go-nostr"
)

// projectKind is the addressable kind for TENEX project events.
const projectKind = 31933

// ProjectACL is the visibility-relevant projection of a kind 31933 event.
type ProjectACL struct {
	AuthorPubkey  string
	DTag          string
	Members       map[string]struct{}
	IsPrivate     bool
	LastTimestamp nostr.Timestamp // created_at of the event this ACL was derived from
}

// IsMember reports whether pubkey is the project author or appears in its p-tags.
func (p *ProjectACL) IsMember(pubkey string) bool {
	if p == nil || pubkey == "" {
		return false
	}
	if p.AuthorPubkey == pubkey {
		return true
	}
	_, ok := p.Members[pubkey]
	return ok
}

// ProjectRegistry is an in-memory index of project ACLs keyed by their
// addressable identifier ("31933:<author>:<d-tag>").
type ProjectRegistry struct {
	mu       sync.RWMutex
	projects map[string]*ProjectACL
}

func NewProjectRegistry() *ProjectRegistry {
	return &ProjectRegistry{projects: make(map[string]*ProjectACL)}
}

// Upsert ingests a kind 31933 event, replacing any prior entry for the same
// (author, d-tag) when the new event is at least as recent. Returns the
// previous ACL (or nil) so callers can diff membership and detect grants.
// Non-31933 events are ignored.
func (r *ProjectRegistry) Upsert(event *nostr.Event) (previous *ProjectACL) {
	if event == nil || event.Kind != projectKind {
		return nil
	}

	acl := &ProjectACL{
		AuthorPubkey:  event.PubKey,
		Members:       make(map[string]struct{}),
		LastTimestamp: event.CreatedAt,
	}
	for _, tag := range event.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case "d":
			acl.DTag = tag[1]
		case "p":
			acl.Members[tag[1]] = struct{}{}
		case "scope":
			if tag[1] == "private" {
				acl.IsPrivate = true
			}
		}
	}

	addr := projectAddress(acl.AuthorPubkey, acl.DTag)
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.projects[addr]
	if prev != nil && prev.LastTimestamp > acl.LastTimestamp {
		return prev // stale event, keep newer state
	}
	r.projects[addr] = acl
	return prev
}

// Delete removes a project from the registry. Used when its 31933 event is
// deleted via NIP-9.
func (r *ProjectRegistry) Delete(addr string) {
	r.mu.Lock()
	delete(r.projects, addr)
	r.mu.Unlock()
}

// Get returns the ACL for an address, or nil if unknown.
func (r *ProjectRegistry) Get(addr string) *ProjectACL {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.projects[addr]
}

// IsPrivate reports whether a known project is private. Unknown projects are
// treated as public.
func (r *ProjectRegistry) IsPrivate(addr string) bool {
	acl := r.Get(addr)
	return acl != nil && acl.IsPrivate
}

// CanViewProject reports whether viewer may read events belonging to the given
// project. Public (or unknown) projects are visible to all authenticated
// viewers; private projects are restricted to the author and p-tagged members.
func (r *ProjectRegistry) CanViewProject(viewer, addr string) bool {
	acl := r.Get(addr)
	if acl == nil || !acl.IsPrivate {
		return true
	}
	return acl.IsMember(viewer)
}

// CanDeliver implements the per-event visibility rules:
//
//  1. Kind 31933 events: visible iff the event isn't private, the viewer is the
//     author, or the viewer appears in the event's p-tags.
//  2. All other events: every "a" tag pointing at a known private project must
//     resolve to a project the viewer can view; otherwise the event is hidden,
//     unless the viewer is the event's own author.
func (r *ProjectRegistry) CanDeliver(viewer string, event *nostr.Event) bool {
	if event == nil {
		return true
	}

	if event.PubKey == viewer {
		return true
	}

	if event.Kind == projectKind {
		if !eventScopeIsPrivate(event) {
			return true
		}
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "p" && tag[1] == viewer {
				return true
			}
		}
		return false
	}

	for _, tag := range event.Tags {
		if len(tag) < 2 || tag[0] != "a" {
			continue
		}
		author, dTag, ok := parseProjectAddress(tag[1])
		if !ok {
			continue
		}
		if !r.CanViewProject(viewer, projectAddress(author, dTag)) {
			return false
		}
	}
	return true
}

// eventScopeIsPrivate returns true when the event carries ["scope", "private"].
func eventScopeIsPrivate(event *nostr.Event) bool {
	if event == nil {
		return false
	}
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "scope" && tag[1] == "private" {
			return true
		}
	}
	return false
}

// parseProjectAddress decodes "31933:<author>:<d-tag>" references. d-tag may
// contain colons, which are preserved.
func parseProjectAddress(addr string) (author, dTag string, ok bool) {
	const prefix = "31933:"
	if !strings.HasPrefix(addr, prefix) {
		return "", "", false
	}
	rest := addr[len(prefix):]
	idx := strings.IndexByte(rest, ':')
	if idx <= 0 || idx == len(rest)-1 {
		return "", "", false
	}
	return rest[:idx], rest[idx+1:], true
}

func projectAddress(author, dTag string) string {
	return "31933:" + author + ":" + dTag
}

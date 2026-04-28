# `tenex-identity` — Product Spec

## Purpose

A Rust library that resolves `pubkey → IdentityView` (display name, picture, NIP-05, banner, etc.) from kind:0 metadata events. Cache hits return immediately; misses fetch from relays, write-through to a local cache, and return. Same shape as `tenex-conversations` and `tenex-project`: schema-as-contract SQLite, library not daemon, multi-process safe.

Replaces ad-hoc per-binary identity resolution (the summarizer's first-pass fallback chain, and eventually the bun runtime's `PubkeyService` once the TS path retires).

## What it owns

- A host-wide kind:0 cache at `~/.tenex/identity-cache.db` (one file, all projects, because pubkeys are global identities, not project-scoped).
- TTL-based freshness: cached rows older than 24h trigger a background refetch; readers get the cached row immediately while it refreshes.
- In-process + on-disk coalescing: simultaneous `resolve(pubkey)` calls within a process share a single fetch; cross-process simultaneous fetches double-fetch but the writes are idempotent (latest event wins by `created_at`).
- Fetch via `nostr-sdk` directly today; through the relay-mux when that lands. Single localized swap.

## API surface

```
resolve(pubkey)        -> IdentityView  // cached if recent; else fetch + cache
resolve_cached(pubkey) -> Option<IdentityView>  // never fetches
batch(pubkeys)         -> HashMap<pubkey, IdentityView>  // single relay request
prime(events)          -> ()  // write known kind:0 events into the cache (e.g. from a passing subscription)
```

`IdentityView` carries: `pubkey`, `display_name`, `name`, `nip05`, `picture`, `banner`, `about`, `lud16`, `fetched_at`, `event_id`, `created_at`.

## Storage

- One SQLite file: `~/.tenex/identity-cache.db`.
- WAL mode, busy-timeout. Multi-reader / single-writer, but writes here are rare (one per resolution + one per refresh) and idempotent.
- Schema: `identities (pubkey TEXT PRIMARY KEY, display_name, name, nip05, picture, banner, about, lud16, event_id, created_at, fetched_at)`. Migrations versioned.

## Layering

```
tenex-identity
     ↓
nostr-sdk (or relay-mux when it lands)
SQLite
```

Library, not daemon. No socket. Every Rust binary that needs a name links it.

## Non-goals

- No transport-principal resolution (Telegram users, etc.) in v1. Add later if needed.
- No subscription management for kind:0 updates. TTL-based refresh only. A future version could subscribe via the relay-mux and call `prime()` on incoming events; not v1.
- No bun TS binding in v1. The TS `PubkeyService` is unaffected. When the TS runtime is retired (or sooner if we want), a TS binding lands.

## Success criteria

- The summarizer's identity fallback chain becomes a single `tenex_identity::resolve(pubkey).display_name()` call.
- Two consecutive resolutions of the same pubkey produce one relay fetch.
- Cache hits are sub-millisecond.
- A new Rust binary that needs names: links one crate, makes one call.

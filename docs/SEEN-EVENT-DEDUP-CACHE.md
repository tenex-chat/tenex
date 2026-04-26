# Seen-Event Dedup Cache

The daemon maintains a process-wide in-memory cache of Nostr event IDs that have already been routed through ingress. Without it, the same event would be processed multiple times — once per relay the daemon is connected to, and again when a relay replays stored events on reconnect.

## Why it exists

Without deduplication, every duplicate flows through `process_verified_nostr_event`, causing per-event side effects to fire multiple times for what the user sent as a single event. Examples:

- `ConfigUpdate` (kind 31933) triggers 24011 republishes
- `AgentCreate` re-runs `install_agent_from_nostr`
- `Boot` (kind 24000) signals `project_booted_tx` repeatedly

## Behavior

- **Record and check:** `SeenEventCache::record(event_id)` returns `true` if the ID was new (caller should process), `false` if already seen (caller should drop).
- **FIFO eviction:** When the cache is full, the oldest recorded ID is dropped to make room. Capacity defaults to 4096 entries (each a 64-char hex ID, so well under 1 MB).
- **In-memory only:** The cache is not persisted across daemon restarts. On restart, the relay redelivers recent events; downstream stores (project event index, dispatch queue, agent install) already treat re-receipt idempotently, so the brief re-processing window on startup is safe.

## Where it is used

`nostr_subscription_ingress` checks the cache before dispatching each inbound event. The `SeenEventCache` is constructed once in `run_cli` and passed as an `Arc` reference into the ingress pipeline.

## Navigation

- `crates/tenex-daemon/src/seen_event_cache.rs` — implementation
- `crates/tenex-daemon/src/nostr_subscription_ingress.rs` — consumer (`seen_events` field in ingress input)

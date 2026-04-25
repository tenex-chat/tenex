//! Process-wide bounded cache of Nostr event ids the subscription gateway has
//! already routed to ingress. The same event arrives once per relay the
//! daemon is connected to, and may be redelivered when a relay replays
//! stored events on reconnect; without dedup, every duplicate flows through
//! `process_verified_nostr_event`, causing per-event side effects (24011
//! republishes for `ConfigUpdate`, `install_agent_from_nostr` re-runs for
//! `AgentCreate`, repeated `project_booted_tx` signals for `Boot`, …) to
//! fire multiple times for what the user sent as a single event.
//!
//! The cache is in-memory only: across daemon restarts the gateway will
//! reprocess events from each relay, which the downstream stores already
//! treat idempotently (project event index, dispatch queue, agent install).
//!
//! Eviction is FIFO: when the bound is hit, the oldest recorded id is
//! dropped. The 64-character event-id strings are short enough that holding
//! a few thousand is cheap.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

/// Default capacity. Each entry is a 64-char hex event id, so the bound
/// holds the cache well under a megabyte while spanning enough recent
/// traffic to absorb relay redeliveries on reconnect.
pub const DEFAULT_CAPACITY: usize = 4096;

#[derive(Debug)]
pub struct SeenEventCache {
    inner: Mutex<SeenEventCacheInner>,
}

#[derive(Debug)]
struct SeenEventCacheInner {
    capacity: usize,
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl SeenEventCache {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            inner: Mutex::new(SeenEventCacheInner {
                capacity,
                seen: HashSet::with_capacity(capacity),
                order: VecDeque::with_capacity(capacity),
            }),
        }
    }

    /// Record `event_id`. Returns `true` if this id had not been seen,
    /// `false` if it was already in the cache (caller should drop the
    /// duplicate). Evicts the oldest id when the cache is full.
    pub fn record(&self, event_id: &str) -> bool {
        let mut inner = self.inner.lock().expect("seen-event cache poisoned");
        if inner.seen.contains(event_id) {
            return false;
        }
        if inner.seen.len() >= inner.capacity
            && let Some(oldest) = inner.order.pop_front()
        {
            inner.seen.remove(&oldest);
        }
        inner.seen.insert(event_id.to_string());
        inner.order.push_back(event_id.to_string());
        true
    }
}

impl Default for SeenEventCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_record_is_new_repeat_is_duplicate() {
        let cache = SeenEventCache::new();
        assert!(cache.record("event-a"));
        assert!(!cache.record("event-a"));
    }

    #[test]
    fn distinct_ids_are_independent() {
        let cache = SeenEventCache::new();
        assert!(cache.record("event-a"));
        assert!(cache.record("event-b"));
        assert!(!cache.record("event-a"));
        assert!(!cache.record("event-b"));
    }

    #[test]
    fn fifo_eviction_drops_oldest_when_capacity_exceeded() {
        let cache = SeenEventCache::with_capacity(2);
        assert!(cache.record("oldest"));
        assert!(cache.record("middle"));
        // Inserting a third id evicts "oldest"; cache now tracks {middle, newest}.
        assert!(cache.record("newest"));
        // "middle" and "newest" are still tracked.
        assert!(!cache.record("middle"));
        assert!(!cache.record("newest"));
        // "oldest" was evicted, so re-recording it returns true.
        assert!(cache.record("oldest"));
    }

    #[test]
    fn capacity_below_one_is_clamped_to_one() {
        let cache = SeenEventCache::with_capacity(0);
        assert!(cache.record("only"));
        assert!(!cache.record("only"));
        // Capacity 1 means inserting another evicts the previous.
        assert!(cache.record("next"));
        assert!(cache.record("only"));
    }
}

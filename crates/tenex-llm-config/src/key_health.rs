//! Per-key failure tracking for provider API keys.
//!
//! When a caller reports that key[n] for provider P failed, that key is
//! excluded from healthy results for `COOLDOWN` (5 minutes). After the
//! cooldown the key automatically becomes eligible again — no explicit
//! "re-enable" call needed.
//!
//! If every key for a provider is in cooldown, `healthy_indices` returns an
//! empty vec and the caller receives an `all_keys_exhausted` error.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Key identified by (provider_id, 0-based index into the provider's key array).
type KeyId = (String, usize);

#[derive(Default)]
pub struct KeyHealthTracker {
    failures: Mutex<HashMap<KeyId, Instant>>,
}

impl KeyHealthTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark key at position `key_index` for `provider` as failed.
    /// It will be excluded for [`COOLDOWN`].
    pub fn mark_failed(&self, provider: &str, key_index: usize) {
        let mut map = self.failures.lock().unwrap();
        map.insert((provider.to_string(), key_index), Instant::now());
    }

    /// Return the indices (0-based, preserving order) of keys that are not
    /// currently in cooldown.  `count` is the total number of keys for the
    /// provider.
    pub fn healthy_indices(&self, provider: &str, count: usize) -> Vec<usize> {
        let map = self.failures.lock().unwrap();
        let now = Instant::now();
        (0..count)
            .filter(|i| match map.get(&(provider.to_string(), *i)) {
                Some(failed_at) => now.duration_since(*failed_at) >= COOLDOWN,
                None => true,
            })
            .collect()
    }

    /// Check whether a single key (identified by its original 0-based index in
    /// the provider's key array) is currently healthy. Used by per-request
    /// retry helpers that need to skip keys marked failed earlier in the
    /// process lifetime.
    pub fn is_healthy(&self, provider: &str, key_index: usize) -> bool {
        let map = self.failures.lock().unwrap();
        match map.get(&(provider.to_string(), key_index)) {
            Some(failed_at) => Instant::now().duration_since(*failed_at) >= COOLDOWN,
            None => true,
        }
    }
}

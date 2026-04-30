//! `IdentityResolver` impl backed by the host-wide
//! `~/.tenex/identity-cache.db`.
//!
//! Reads from the cache only; never blocks on the identity socket. If a
//! pubkey isn't cached, falls back to the first 8 hex chars. The
//! identity daemon (`tenex daemon` supervises it) is what populates the
//! cache.
//!
//! Stale-name lifecycle: if a chunk is embedded before a pubkey is in
//! the cache, the chunk content carries the hex fallback. Re-running
//! `tenex-embedder backfill --reset` re-renders all chunks with current
//! cache contents.

use std::sync::Arc;

use tenex_identity::IdentityCache;
use tenex_protocol::transcript::IdentityResolver;

pub struct CacheResolver {
    cache: Arc<IdentityCache>,
}

impl CacheResolver {
    pub fn new(cache: Arc<IdentityCache>) -> Self {
        Self { cache }
    }
}

impl IdentityResolver for CacheResolver {
    fn label_for(&self, pubkey: &str) -> String {
        match self.cache.get_any(pubkey) {
            Ok(Some(view)) => view.best_name().to_string(),
            _ => fallback(pubkey),
        }
    }
}

fn fallback(pubkey: &str) -> String {
    if pubkey.is_empty() {
        return "unknown".to_string();
    }
    pubkey.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_uses_8_char_prefix() {
        assert_eq!(fallback("0123456789abcdef"), "01234567");
    }

    #[test]
    fn fallback_handles_empty_pubkey() {
        assert_eq!(fallback(""), "unknown");
    }
}

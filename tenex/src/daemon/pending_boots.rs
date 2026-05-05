//! `--boot <prefix>` queue.
//!
//! The CLI lets the operator pre-arm the daemon with one or more d-tag
//! prefixes that should boot as soon as a matching project is discovered on
//! Nostr — without waiting for a kind:1 / 24000 trigger. This module holds
//! that queue and the first-match-wins resolution rule.

use tokio::sync::Mutex;
use tracing::warn;

/// Tracks `--boot <prefix>` requests waiting for a matching project discovery.
/// `pending` shrinks as prefixes are matched against newly-discovered d-tags;
/// `consumed` retains them so a later discovery that would have also matched
/// an already-booted prefix can be reported as ambiguous.
pub struct PendingBoots {
    pending: Vec<String>,
    consumed: Vec<(String, String)>,
}

impl PendingBoots {
    pub fn new(prefixes: Vec<String>) -> Self {
        Self {
            pending: prefixes.into_iter().filter(|p| !p.is_empty()).collect(),
            consumed: Vec::new(),
        }
    }
}

/// Pop every pending prefix that the freshly-discovered d-tag starts with,
/// move them into `consumed`, and warn for any already-consumed prefix that
/// would have also matched this discovery (first-match-wins ambiguity).
pub async fn resolve(pending_boots: &Mutex<PendingBoots>, d_tag: &str) -> Vec<String> {
    let mut pb = pending_boots.lock().await;
    let mut matched: Vec<String> = Vec::new();
    pb.pending.retain(|prefix| {
        if d_tag.starts_with(prefix) {
            matched.push(prefix.clone());
            false
        } else {
            true
        }
    });
    for p in &matched {
        pb.consumed.push((p.clone(), d_tag.to_string()));
    }
    for (prefix, prior_d_tag) in &pb.consumed {
        if prior_d_tag != d_tag && d_tag.starts_with(prefix) {
            warn!(
                prefix = %prefix,
                booted = %prior_d_tag,
                also_matches = %d_tag,
                "ambiguous --boot prefix: already booted earlier match; ignoring later discovery"
            );
        }
    }
    matched
}

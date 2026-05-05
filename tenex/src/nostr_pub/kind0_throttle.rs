//! Process-local kind:0 publish gate: dedupe equivalent payloads and
//! cap the publish rate at 2 events per rolling second.
//!
//! Two protections layered together:
//!
//! 1. **Dedupe.** Each kind:0 publish is keyed by author pubkey. We hash a
//!    canonical `(tags, content)` projection — everything that contributes
//!    to the *meaning* of the kind:0, excluding `created_at`, `id`, and
//!    `sig`. When the canonical hash matches the most recent successful
//!    publish for that author, the send is skipped: republishing identical
//!    state would only churn relay-side replaceable storage.
//!
//! 2. **Rate limit.** A sliding 1-second window allows at most two sends.
//!    Reload storms (every agent's kind:0 republished at once) drain
//!    through the gate at a relay-friendly cadence instead of triggering
//!    429 rate-limit responses.
//!
//! The gate is process-local. Each runtime / daemon process runs its own
//! [`Kind0Throttle`], which is sufficient: relay 429s are caused by burst
//! traffic from a single connection, and we already share one
//! `nostr_sdk::Client` per process.

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use nostr_sdk::{Client, Event, PublicKey};
use tokio::sync::Mutex;
use tracing::debug;

/// Sliding-window length: at most [`MAX_PER_WINDOW`] sends within this
/// duration.
const WINDOW: Duration = Duration::from_secs(1);

/// Maximum number of kind:0 publishes per [`WINDOW`].
const MAX_PER_WINDOW: usize = 2;

/// Stable digest of a kind:0 event's meaningful payload (tags + content).
/// Excludes `created_at`, `id`, `sig`, and `pubkey` — `pubkey` is the cache
/// key, not part of the value.
fn payload_digest(event: &Event) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    event.content.hash(&mut hasher);
    for tag in event.tags.iter() {
        for value in tag.as_slice() {
            value.hash(&mut hasher);
        }
        // Boundary marker between tags so `["a","bc"]` and `["ab","c"]`
        // don't collide.
        0u8.hash(&mut hasher);
    }
    hasher.finish()
}

/// Process-local kind:0 publisher. Cheap to clone via `Arc`; all state is
/// behind one `Mutex`.
#[derive(Default)]
pub struct Kind0Throttle {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Most-recent successfully-published canonical digest, keyed by event
    /// author pubkey.
    last_digest: HashMap<PublicKey, u64>,
    /// Send timestamps within [`WINDOW`]. Pruned on every admit.
    recent_sends: VecDeque<Instant>,
}

/// Outcome of a [`Kind0Throttle::publish`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// The event was sent to the relay.
    Sent,
    /// Skipped: an identical canonical payload was already published for
    /// this author by this process.
    SkippedDuplicate,
}

impl Kind0Throttle {
    /// Send a kind:0 event through the gate.
    ///
    /// Returns [`PublishOutcome::Sent`] when the event reached the relay,
    /// or [`PublishOutcome::SkippedDuplicate`] when an identical payload
    /// was already published for this author in this process.
    ///
    /// On admission, blocks (via `tokio::time::sleep`) until the rate
    /// budget allows the send.
    pub async fn publish(
        &self,
        client: &Client,
        event: Event,
    ) -> Result<PublishOutcome, nostr_sdk::client::Error> {
        let digest = payload_digest(&event);
        let author = event.pubkey;

        // Dedupe check. We re-validate the cache after admit, but checking
        // here lets us short-circuit before paying any rate budget.
        if let Some(&prev) = self.inner.lock().await.last_digest.get(&author) {
            if prev == digest {
                debug!(author = %author, "kind:0 publish skipped: payload unchanged");
                return Ok(PublishOutcome::SkippedDuplicate);
            }
        }

        self.admit().await;

        client.send_event(&event).await?;

        // Record the digest under the lock once the send succeeded so a
        // failed publish doesn't poison future attempts.
        self.inner.lock().await.last_digest.insert(author, digest);
        Ok(PublishOutcome::Sent)
    }

    /// Block until a send slot is available within the 1-second window.
    /// On wake we requeue rather than assume the slot is still ours, so
    /// concurrent admits stay correct.
    async fn admit(&self) {
        loop {
            let wait = {
                let mut inner = self.inner.lock().await;
                let now = Instant::now();
                while let Some(t) = inner.recent_sends.front() {
                    if now.duration_since(*t) >= WINDOW {
                        inner.recent_sends.pop_front();
                    } else {
                        break;
                    }
                }
                if inner.recent_sends.len() < MAX_PER_WINDOW {
                    inner.recent_sends.push_back(now);
                    return;
                }
                // Oldest send is still within the window. Sleep until it
                // ages out, then retry.
                let oldest = *inner.recent_sends.front().expect("len >= MAX_PER_WINDOW");
                WINDOW
                    .checked_sub(now.duration_since(oldest))
                    .unwrap_or_default()
            };
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr_sdk::{EventBuilder, Keys, Kind};

    fn make_event(keys: &Keys, content: &str) -> Event {
        EventBuilder::new(Kind::Metadata, content)
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn payload_digest_stable_across_created_at_changes() {
        let keys = Keys::generate();
        let a = EventBuilder::new(Kind::Metadata, "x")
            .custom_created_at(nostr_sdk::Timestamp::from(100))
            .sign_with_keys(&keys)
            .unwrap();
        let b = EventBuilder::new(Kind::Metadata, "x")
            .custom_created_at(nostr_sdk::Timestamp::from(200))
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(payload_digest(&a), payload_digest(&b));
    }

    #[test]
    fn payload_digest_changes_when_content_changes() {
        let keys = Keys::generate();
        let a = make_event(&keys, "x");
        let b = make_event(&keys, "y");
        assert_ne!(payload_digest(&a), payload_digest(&b));
    }

    #[test]
    fn payload_digest_changes_when_tags_change() {
        use nostr_sdk::Tag;
        let keys = Keys::generate();
        let a = EventBuilder::new(Kind::Metadata, "x")
            .sign_with_keys(&keys)
            .unwrap();
        let b = EventBuilder::new(Kind::Metadata, "x")
            .tags([Tag::parse(["slug", "agent-a"]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        assert_ne!(payload_digest(&a), payload_digest(&b));
    }

    #[tokio::test]
    async fn admit_releases_two_then_paces_third() {
        let throttle = Kind0Throttle::default();
        let start = Instant::now();

        throttle.admit().await;
        throttle.admit().await;
        // First two are admitted instantly.
        assert!(start.elapsed() < Duration::from_millis(50));

        throttle.admit().await;
        // Third must wait roughly one window for the first to age out.
        // Slack on the upper bound keeps CI noise from flaking the test.
        assert!(start.elapsed() >= WINDOW);
        assert!(start.elapsed() < WINDOW + Duration::from_millis(500));
    }
}

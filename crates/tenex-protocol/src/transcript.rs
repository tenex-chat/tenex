//! Render a set of Nostr events as a sorted, speaker-labeled
//! transcript.
//!
//! The renderer is a pure function over `(events, identity_resolver)`.
//! Speaker resolution is delegated to the [`IdentityResolver`] trait so
//! callers can plug in `tenex-identity::IdentityCache` (production) or
//! a stub (tests).

use nostr::event::Event;

use crate::event_filter::{conversation_id_from_event, is_conversation_event};

/// One transcript line, suitable for chunking or direct rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptLine {
    /// Hex event id — used by callers to dedupe across pages.
    pub event_id: String,
    /// Conversation root id this event belongs to.
    pub conversation_id: String,
    /// Author pubkey (hex).
    pub author_pubkey: String,
    /// Display name as resolved by the [`IdentityResolver`].
    pub speaker: String,
    /// Unix seconds (`Event::created_at`).
    pub created_at_secs: i64,
    /// Body text (`Event::content`, untrimmed).
    pub body: String,
}

impl TranscriptLine {
    /// One-line render — `speaker: body`. Multiline bodies are rendered as-is.
    pub fn render(&self) -> String {
        format!("{}: {}", self.speaker, self.body)
    }
}

/// Resolve a hex pubkey to a display label. Implementors should never
/// block on network — this is called once per event during chunking.
pub trait IdentityResolver {
    fn label_for(&self, pubkey: &str) -> String;
}

/// Reject non-transcript events, sort by `(created_at, event_id)`, and
/// project each survivor to a [`TranscriptLine`]. Stable order across
/// runs given the same input set.
pub fn render_events(events: &[Event], resolver: &dyn IdentityResolver) -> Vec<TranscriptLine> {
    let mut filtered: Vec<&Event> = events.iter().filter(|e| is_conversation_event(e)).collect();
    filtered.sort_by(|a, b| {
        a.created_at
            .as_secs()
            .cmp(&b.created_at.as_secs())
            .then_with(|| a.id.to_hex().cmp(&b.id.to_hex()))
    });
    filtered
        .into_iter()
        .map(|e| {
            let author = e.pubkey.to_hex();
            TranscriptLine {
                event_id: e.id.to_hex(),
                conversation_id: conversation_id_from_event(e),
                author_pubkey: author.clone(),
                speaker: resolver.label_for(&author),
                created_at_secs: e.created_at.as_secs() as i64,
                body: e.content.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::event::EventBuilder;
    use nostr::{Keys, Kind};
    use std::collections::HashMap;

    struct StaticResolver(HashMap<String, String>);

    impl IdentityResolver for StaticResolver {
        fn label_for(&self, pubkey: &str) -> String {
            self.0
                .get(pubkey)
                .cloned()
                .unwrap_or_else(|| pubkey.chars().take(8).collect())
        }
    }

    fn make_event(content: &str, kind: Kind) -> (Event, Keys) {
        let keys = Keys::generate();
        let event = EventBuilder::new(kind, content)
            .sign_with_keys(&keys)
            .unwrap();
        (event, keys)
    }

    #[test]
    fn empty_input_returns_empty() {
        let resolver = StaticResolver(HashMap::new());
        assert!(render_events(&[], &resolver).is_empty());
    }

    #[test]
    fn rejected_events_are_skipped() {
        let (a, _) = make_event("", Kind::TextNote); // empty content
        let (b, _) = make_event("hi", Kind::Custom(123)); // wrong kind
        let resolver = StaticResolver(HashMap::new());
        assert!(render_events(&[a, b], &resolver).is_empty());
    }

    #[test]
    fn lines_are_sorted_by_created_at() {
        // Generate three events; control created_at via custom timestamps.
        let k1 = Keys::generate();
        let e1 = EventBuilder::new(Kind::TextNote, "first")
            .custom_created_at(nostr::Timestamp::from(100u64))
            .sign_with_keys(&k1)
            .unwrap();
        let k2 = Keys::generate();
        let e2 = EventBuilder::new(Kind::TextNote, "second")
            .custom_created_at(nostr::Timestamp::from(200u64))
            .sign_with_keys(&k2)
            .unwrap();
        let k3 = Keys::generate();
        let e3 = EventBuilder::new(Kind::TextNote, "third")
            .custom_created_at(nostr::Timestamp::from(50u64))
            .sign_with_keys(&k3)
            .unwrap();

        let resolver = StaticResolver(HashMap::new());
        // Submit unsorted; renderer should sort.
        let lines = render_events(&[e1, e2, e3], &resolver);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].body, "third");
        assert_eq!(lines[1].body, "first");
        assert_eq!(lines[2].body, "second");
    }

    #[test]
    fn speaker_uses_resolver_then_falls_back() {
        let (e, k) = make_event("hi", Kind::TextNote);
        let mut map = HashMap::new();
        map.insert(k.public_key().to_hex(), "Alice".to_string());
        let resolver = StaticResolver(map);
        let lines = render_events(&[e], &resolver);
        assert_eq!(lines[0].speaker, "Alice");
    }

    #[test]
    fn render_produces_speaker_colon_body() {
        let line = TranscriptLine {
            event_id: "evid".into(),
            conversation_id: "convid".into(),
            author_pubkey: "pk".into(),
            speaker: "Bob".into(),
            created_at_secs: 0,
            body: "hello world".into(),
        };
        assert_eq!(line.render(), "Bob: hello world");
    }
}

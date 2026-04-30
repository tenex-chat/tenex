//! Group events into conversations and dedupe across pages.
//!
//! Walk-forward semantics: events arrive in time-ordered pages. A
//! conversation is "stable enough to embed" the first time we see it on
//! a page, *and* every subsequent page we see new events for it (the
//! chunker is content-hash idempotent, so re-passes only embed
//! genuinely-new chunks).
//!
//! This module is a pure data structure. The scheduler decides when to
//! flush.

use std::collections::{HashMap, HashSet};

use nostr::event::Event;
use tenex_protocol::event_filter::conversation_id_from_event;

#[derive(Debug, Default)]
pub struct Accumulator {
    by_conversation: HashMap<String, Vec<Event>>,
    seen_event_ids: HashSet<String>,
}

impl Accumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if the event was newly accumulated; `false` if it
    /// was a duplicate from an earlier page.
    pub fn ingest(&mut self, event: Event) -> bool {
        let id = event.id.to_hex();
        if !self.seen_event_ids.insert(id) {
            return false;
        }
        let conv_id = conversation_id_from_event(&event);
        self.by_conversation.entry(conv_id).or_default().push(event);
        true
    }

    pub fn ingest_all<I: IntoIterator<Item = Event>>(&mut self, events: I) -> usize {
        events.into_iter().filter(|_| true).fold(
            0,
            |acc, e| {
                if self.ingest(e) {
                    acc + 1
                } else {
                    acc
                }
            },
        )
    }

    pub fn conversation_ids(&self) -> Vec<String> {
        self.by_conversation.keys().cloned().collect()
    }

    pub fn events_for(&self, conversation_id: &str) -> &[Event] {
        self.by_conversation
            .get(conversation_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn dedupe_count(&self) -> usize {
        self.seen_event_ids.len()
    }

    pub fn conversation_count(&self) -> usize {
        self.by_conversation.len()
    }

    /// Number of events stored for a single conversation.
    pub fn event_count_for(&self, conversation_id: &str) -> usize {
        self.events_for(conversation_id).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::event::EventBuilder;
    use nostr::{Keys, Kind};

    #[test]
    fn ingest_dedupes_repeated_events() {
        let mut acc = Accumulator::new();
        let k = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "hi")
            .sign_with_keys(&k)
            .unwrap();
        assert!(acc.ingest(event.clone()));
        assert!(!acc.ingest(event));
        assert_eq!(acc.dedupe_count(), 1);
    }

    #[test]
    fn groups_events_by_conversation_root_id() {
        let mut acc = Accumulator::new();
        let k = Keys::generate();
        let root = EventBuilder::new(Kind::TextNote, "root")
            .sign_with_keys(&k)
            .unwrap();
        let root_id = root.id.to_hex();

        let reply_tag = nostr::Tag::parse(["e", &root_id, "", "root"]).unwrap();
        let reply = EventBuilder::new(Kind::TextNote, "reply")
            .tag(reply_tag)
            .sign_with_keys(&k)
            .unwrap();

        acc.ingest(root);
        acc.ingest(reply);
        assert_eq!(acc.conversation_count(), 1);
        assert_eq!(acc.event_count_for(&root_id), 2);
    }
}

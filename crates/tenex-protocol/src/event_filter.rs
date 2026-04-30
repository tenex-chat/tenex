//! Predicates and helpers for projecting Nostr events onto TENEX
//! conversations.
//!
//! Two responsibilities:
//!
//! - [`is_conversation_event`] — minimum bar for an event to participate
//!   in a transcript: kind 1, non-empty content, no
//!   `tool` / `intent` / `reasoning` / `error` head tags. Scope (which
//!   project the event belongs to) is enforced at the relay filter level
//!   via `#a` and `#e` tags, not in this predicate.
//!
//! - [`conversation_id_from_event`] — derive the conversation root id
//!   for an event: the `e`-tag with marker `root` if present, else the
//!   first unmarked `e`-tag, else the event's own id.
//!
//! These are the read-side rules. The runtime's
//! `should_persist_agent_message` is a **routing** filter (does this
//! event belong to *this* conversation I'm running?) and is not lifted
//! — it has different semantics.
//!
//! Lifted from `tenex/src/runtime_cmd/mod.rs:2131`. Keep this module
//! and that file in sync if either rule changes.

use nostr::event::Event;
use nostr::{Alphabet, SingleLetterTag, TagKind};

/// Head-tag names that disqualify an event from being part of a human
/// conversation transcript.
const REJECTED_HEAD_TAGS: &[&str] = &["tool", "intent", "reasoning", "error"];

/// `true` iff `event` is a candidate for inclusion in a conversation
/// transcript. The caller has already filtered by `#a` / `#e` at the
/// relay; this predicate enforces the per-event content rules.
pub fn is_conversation_event(event: &Event) -> bool {
    if event.kind != nostr::Kind::TextNote {
        return false;
    }
    if event.content.trim().is_empty() {
        return false;
    }
    for tag in event.tags.iter() {
        if let Some(head) = tag.as_slice().first() {
            if REJECTED_HEAD_TAGS.contains(&head.as_str()) {
                return false;
            }
        }
    }
    true
}

/// Derive the conversation root id for an event.
///
/// Resolution:
/// 1. `e`-tag with marker `root` → that event id.
/// 2. First `e`-tag without a marker (or empty marker) → that event id.
/// 3. Fallback: the event's own id (the event *starts* a conversation).
pub fn conversation_id_from_event(event: &Event) -> String {
    let e_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::E));
    let mut first_unmarked: Option<String> = None;

    for tag in event.tags.iter() {
        if tag.kind() != e_kind {
            continue;
        }
        let parts = tag.as_slice();
        // parts[0] = "e", parts[1] = event-id, parts[2] = relay, parts[3] = marker
        let Some(event_id) = parts.get(1) else {
            continue;
        };
        let marker = parts.get(3).map(|s| s.as_str());
        match marker {
            Some("root") => return event_id.clone(),
            None | Some("") if first_unmarked.is_none() => {
                first_unmarked = Some(event_id.clone());
            }
            None | Some("") => {}
            _ => {}
        }
    }

    first_unmarked.unwrap_or_else(|| event.id.to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::event::EventBuilder;
    use nostr::{Keys, Tag};

    fn keys() -> Keys {
        Keys::generate()
    }

    #[test]
    fn empty_content_is_rejected() {
        let k = keys();
        let event = EventBuilder::new(nostr::Kind::TextNote, "").sign_with_keys(&k).unwrap();
        assert!(!is_conversation_event(&event));
    }

    #[test]
    fn whitespace_only_content_is_rejected() {
        let k = keys();
        let event = EventBuilder::new(nostr::Kind::TextNote, "   \n\t  ").sign_with_keys(&k).unwrap();
        assert!(!is_conversation_event(&event));
    }

    #[test]
    fn wrong_kind_is_rejected() {
        let k = keys();
        let event = EventBuilder::new(nostr::Kind::Custom(31933), "hi").sign_with_keys(&k).unwrap();
        assert!(!is_conversation_event(&event));
    }

    #[test]
    fn rejected_head_tag_filters_event() {
        let k = keys();
        for head in ["tool", "intent", "reasoning", "error"] {
            let tag = Tag::parse([head, "marker"]).unwrap();
            let event = EventBuilder::new(nostr::Kind::TextNote, "hi")
                .tag(tag)
                .sign_with_keys(&k)
                .unwrap();
            assert!(
                !is_conversation_event(&event),
                "head tag {head} should disqualify"
            );
        }
    }

    #[test]
    fn plain_text_note_passes() {
        let k = keys();
        let event = EventBuilder::new(nostr::Kind::TextNote, "hello world")
            .sign_with_keys(&k)
            .unwrap();
        assert!(is_conversation_event(&event));
    }

    #[test]
    fn conversation_id_falls_back_to_event_id_when_no_e_tags() {
        let k = keys();
        let event = EventBuilder::new(nostr::Kind::TextNote, "hi")
            .sign_with_keys(&k)
            .unwrap();
        assert_eq!(conversation_id_from_event(&event), event.id.to_hex());
    }

    #[test]
    fn conversation_id_uses_root_marker_when_present() {
        let k = keys();
        let root_id = "0000000000000000000000000000000000000000000000000000000000000001";
        let other_id = "0000000000000000000000000000000000000000000000000000000000000002";
        // Add unmarked first, then root — root should still win.
        let unmarked = Tag::parse(["e", other_id]).unwrap();
        let root_tag = Tag::parse(["e", root_id, "", "root"]).unwrap();
        let event = EventBuilder::new(nostr::Kind::TextNote, "hi")
            .tag(unmarked)
            .tag(root_tag)
            .sign_with_keys(&k)
            .unwrap();
        assert_eq!(conversation_id_from_event(&event), root_id);
    }

    #[test]
    fn conversation_id_uses_first_unmarked_when_no_root() {
        let k = keys();
        let first_id = "0000000000000000000000000000000000000000000000000000000000000001";
        let second_id = "0000000000000000000000000000000000000000000000000000000000000002";
        let first = Tag::parse(["e", first_id]).unwrap();
        let second = Tag::parse(["e", second_id]).unwrap();
        let event = EventBuilder::new(nostr::Kind::TextNote, "hi")
            .tag(first)
            .tag(second)
            .sign_with_keys(&k)
            .unwrap();
        assert_eq!(conversation_id_from_event(&event), first_id);
    }
}

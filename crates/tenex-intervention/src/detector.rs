//! Completion and response detection logic ported verbatim from
//! `InterventionService.onAgentCompletion` and `onUserResponse` in the bun
//! runtime. The detection rules are load-bearing and must not change here.

use nostr_sdk::prelude::*;

/// Returns true when the event is a completion candidate:
/// - kind:1
/// - author is NOT a whitelisted pubkey (i.e. it's an agent)
/// - event p-tags at least one whitelisted pubkey
/// - the p-tagged whitelisted pubkey is the root author of the conversation
///
/// The caller is responsible for checking the root-author condition (which
/// requires looking up the conversation root event separately or passing it
/// in). This function checks the first three conditions.
pub fn is_completion_candidate(event: &Event, whitelisted_pubkeys: &[String]) -> Option<String> {
    if event.kind != Kind::TextNote {
        return None;
    }

    let author_hex = event.pubkey.to_hex();
    if whitelisted_pubkeys.contains(&author_hex) {
        return None;
    }

    // Find a whitelisted pubkey in the p-tags.
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.len() >= 2 && values[0] == "p" {
            let tagged_pk = &values[1];
            if whitelisted_pubkeys.contains(tagged_pk) {
                return Some(tagged_pk.clone());
            }
        }
    }

    None
}

/// Returns true when the event is a user response in a conversation that has
/// a pending intervention. Only counts if:
/// - kind:1
/// - author IS a whitelisted pubkey
/// - response timestamp is strictly after `completed_at_ms`
/// - response timestamp is strictly before `completed_at_ms + timeout_ms`
pub fn is_response_cancelling(
    event: &Event,
    whitelisted_pubkeys: &[String],
    completed_at_ms: u64,
    timeout_ms: u64,
) -> bool {
    if event.kind != Kind::TextNote {
        return false;
    }

    let author_hex = event.pubkey.to_hex();
    if !whitelisted_pubkeys.contains(&author_hex) {
        return false;
    }

    let response_ms = event.created_at.as_secs() * 1000;
    if response_ms <= completed_at_ms {
        return false;
    }

    let expiry_ms = completed_at_ms + timeout_ms;
    response_ms < expiry_ms
}

/// Extract the root event ID from a kind:1 event's e-tags.
/// Prefers an e-tag with marker "root", otherwise returns the first e-tag.
pub fn root_event_id(event: &Event) -> Option<String> {
    let mut first_e: Option<String> = None;
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.len() >= 2 && values[0] == "e" {
            if values.len() >= 4 && values[3] == "root" {
                return Some(values[1].clone());
            }
            if first_e.is_none() {
                first_e = Some(values[1].clone());
            }
        }
    }
    first_e
}

/// Extract the conversation ID: root event ID if present, else the event's own ID.
pub fn conversation_id(event: &Event) -> String {
    root_event_id(event).unwrap_or_else(|| event.id.to_hex())
}

/// Extract the project coordinate from an event's `a` tag.
/// Returns the full coordinate string (e.g. "31933:<pubkey>:<dTag>") when present.
pub fn project_id_from_event(event: &Event) -> Option<String> {
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.len() >= 2 && values[0] == "a" {
            let coord = &values[1];
            if coord.starts_with("31933:") {
                return Some(coord.clone());
            }
        }
    }
    None
}

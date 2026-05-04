//! Helpers for reading TENEX-extension tags off a Nostr kind:0 event.

use nostr::Event;

/// Return the first value of the first tag whose head is `name`.
///
/// Tags are `Vec<Vec<String>>` on the wire; we look for `[name, value, ...]`
/// and return `Some(value)` when found. Empty values collapse to `None` so
/// callers don't store empty strings as if they were meaningful data.
pub(crate) fn first_tag_value(event: &Event, name: &str) -> Option<String> {
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some(name) {
            continue;
        }
        if let Some(value) = parts.get(1) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

use std::collections::{HashMap, HashSet};
use tenex_conversations::{MessageRecord, ToolMessage};

pub(super) struct ShortIds {
    used: HashSet<String>,
    full_by_short: HashMap<String, String>,
}

impl ShortIds {
    pub(super) fn new() -> Self {
        Self {
            used: HashSet::new(),
            full_by_short: HashMap::new(),
        }
    }

    pub(super) fn get_or_create(&mut self, event_id: &str) -> String {
        if let Some((short, _)) = self
            .full_by_short
            .iter()
            .find(|(_, full)| full.as_str() == event_id)
        {
            return short.clone();
        }

        let base = short_id(event_id);
        let mut candidate = base.clone();
        let mut suffix = 2;
        while self.used.contains(&candidate) {
            candidate = format!("{base}-{suffix}");
            suffix += 1;
        }

        self.used.insert(candidate.clone());
        self.full_by_short
            .insert(candidate.clone(), event_id.to_string());
        candidate
    }
}

pub(super) fn event_id_for_message(message: &MessageRecord) -> Option<String> {
    message.nostr_event_id.clone().or_else(|| {
        message
            .record_id
            .strip_prefix("event:")
            .map(str::to_string)
            .or_else(|| Some(message.record_id.clone()))
    })
}

pub(super) fn message_matches(message: &MessageRecord, needle: &str) -> bool {
    id_matches(&message.record_id, needle)
        || message
            .nostr_event_id
            .as_ref()
            .is_some_and(|event_id| id_matches(event_id, needle))
        || event_id_for_message(message).is_some_and(|event_id| id_matches(&event_id, needle))
}

pub(super) fn id_matches(candidate: &str, needle: &str) -> bool {
    candidate == needle
        || ((8..candidate.len()).contains(&needle.len())
            && candidate.to_ascii_lowercase().starts_with(needle))
}

pub(super) fn normalize_lookup_id(raw: &str) -> String {
    raw.trim()
        .strip_prefix("nostr:")
        .unwrap_or_else(|| raw.trim())
        .to_ascii_lowercase()
}

pub(super) fn message_timestamp_seconds(message: &MessageRecord) -> Option<i64> {
    message.timestamp.map(timestamp_to_seconds)
}

pub(super) fn tool_timestamp_seconds(tool: &ToolMessage) -> Option<i64> {
    tool.timestamp.map(timestamp_to_seconds)
}

fn timestamp_to_seconds(value: i64) -> i64 {
    if value.abs() > 10_000_000_000 {
        value / 1000
    } else {
        value
    }
}

pub(super) fn is_full_hex_id(input: &str) -> bool {
    input.len() == 64 && input.chars().all(|c| c.is_ascii_hexdigit())
}

pub(super) fn short_id(value: &str) -> String {
    tenex_ids::shorten_full_event_id(value)
}

pub(super) fn get_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

pub(super) fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

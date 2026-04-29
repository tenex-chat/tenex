//! API-key serialisation helpers for `providers.json` entries.
//!
//! Mirrors the pure functions in `src/llm/providers/key-manager.ts:288-340`.
//! Each entry on disk can be either a single string or an array of
//! strings, where each entry is `"<key> [optional label]"`. This module
//! provides the parse / serialise / filter helpers used by:
//!
//! - the provider-select prompt (currently has its own inline copy —
//!   this module replaces that),
//! - the LLM editor's add-configuration flow (when it needs to test
//!   `hasApiKey` before letting the user pick a provider),
//! - the embed-provider auto-detect path (which needs `resolveApiKey`).
//!
//! All functions here are pure — no I/O, no side effects.

/// Mirror of `ParsedApiKeyEntry` (`key-manager.ts:25-29`).
///
/// `serialized` carries the original (trimmed) input verbatim so
/// callers can round-trip without reconstructing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedApiKeyEntry {
    pub key: String,
    pub label: Option<String>,
    pub serialized: String,
}

/// Mirror `parseApiKeyEntry` (`key-manager.ts:288-303`).
///
/// Splits on whitespace; first token is the key, remaining tokens are
/// joined with a single space to form the label. Empty input → empty
/// `key`, no `label`. The TS source uses `value.split(/\s+/)`, which
/// collapses runs of whitespace — Rust's `split_whitespace` mirrors
/// that exactly.
pub fn parse_api_key_entry(value: &str) -> ParsedApiKeyEntry {
    let serialized = value.trim().to_owned();
    if serialized.is_empty() {
        return ParsedApiKeyEntry {
            key: String::new(),
            label: None,
            serialized,
        };
    }
    let mut parts = serialized.split_whitespace();
    let key = parts.next().unwrap_or("").to_owned();
    let label_str = parts.collect::<Vec<_>>().join(" ");
    let label = if label_str.is_empty() {
        None
    } else {
        Some(label_str)
    };
    ParsedApiKeyEntry {
        key,
        label,
        serialized,
    }
}

/// Disk shape of the `apiKey` field on a single provider entry. JSON
/// permits a string or an array of strings — represented here as a
/// borrowed slice + scalar union for ergonomic matching.
pub enum ApiKeyValue<'a> {
    #[cfg(test)]
    None,
    One(&'a str),
    Many(&'a [String]),
}

/// Mirror `getApiKeyEntries` (`key-manager.ts:305-314`).
///
/// Coerce string-or-array into a `Vec<ParsedApiKeyEntry>` and drop:
/// - empty entries (key length 0 after trim),
/// - the literal sentinel `"none"` (used by `claude-code` and other
///   providers that don't take an API key but still appear configured).
pub fn get_api_key_entries(api_key: ApiKeyValue<'_>) -> Vec<ParsedApiKeyEntry> {
    let values: Vec<&str> = match api_key {
        #[cfg(test)]
        ApiKeyValue::None => return Vec::new(),
        ApiKeyValue::One(s) => vec![s],
        ApiKeyValue::Many(a) => a.iter().map(String::as_str).collect(),
    };
    values
        .into_iter()
        .map(parse_api_key_entry)
        .filter(|e| !e.key.is_empty() && e.key != "none")
        .collect()
}

/// Mirror `serializeApiKeyEntry` (`key-manager.ts:316-323`).
///
/// Joins key + label with a single space. Empty / whitespace-only
/// label collapses to just the trimmed key.
pub fn serialize_api_key_entry(key: &str, label: Option<&str>) -> String {
    let trimmed_key = key.trim();
    let trimmed_label = label.map(str::trim).filter(|s| !s.is_empty());
    match trimmed_label {
        Some(l) => format!("{trimmed_key} {l}"),
        None => trimmed_key.to_owned(),
    }
}

/// Mirror `resolveApiKey` (`key-manager.ts:330-332`).
///
/// Used by services that only need a single key (embeddings, image
/// gen) — returns the first key from the entry list (or `None`).
#[cfg(test)]
pub fn resolve_api_key(api_key: ApiKeyValue<'_>) -> Option<String> {
    get_api_key_entries(api_key)
        .into_iter()
        .next()
        .map(|e| e.key)
}

/// Mirror `hasApiKey` (`key-manager.ts:338-340`).
///
/// `true` iff the value resolves to at least one usable entry (after
/// drops for empty / `"none"`).
pub fn has_api_key(api_key: ApiKeyValue<'_>) -> bool {
    !get_api_key_entries(api_key).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_api_key_entry ─────────────────────────────────────────────

    #[test]
    fn parse_empty_input_yields_empty_key_and_none_label() {
        let p = parse_api_key_entry("");
        assert_eq!(p.key, "");
        assert!(p.label.is_none());
        assert_eq!(p.serialized, "");
    }

    #[test]
    fn parse_whitespace_only_input_yields_empty_key() {
        // TS trims the serialized first; if it's empty after trim, the
        // function returns the empty-key/empty-label early branch.
        let p = parse_api_key_entry("   \t  ");
        assert_eq!(p.key, "");
        assert!(p.label.is_none());
        assert_eq!(p.serialized, "");
    }

    #[test]
    fn parse_key_only_yields_key_and_no_label() {
        let p = parse_api_key_entry("sk-abc123");
        assert_eq!(p.key, "sk-abc123");
        assert!(p.label.is_none());
        assert_eq!(p.serialized, "sk-abc123");
    }

    #[test]
    fn parse_key_and_single_label_word() {
        let p = parse_api_key_entry("sk-abc123 work");
        assert_eq!(p.key, "sk-abc123");
        assert_eq!(p.label.as_deref(), Some("work"));
        assert_eq!(p.serialized, "sk-abc123 work");
    }

    #[test]
    fn parse_key_and_multi_word_label_joined_with_single_space() {
        let p = parse_api_key_entry("sk-abc123 my  personal   key");
        assert_eq!(p.key, "sk-abc123");
        // TS `labelParts.join(" ")` collapses inner-run whitespace into
        // a single space (because `split(/\s+/)` already splits on the
        // run, the labelParts array has no empty strings).
        assert_eq!(p.label.as_deref(), Some("my personal key"));
    }

    #[test]
    fn parse_serializes_post_outer_trim() {
        // Outer trim happens; inner whitespace runs are split.
        let p = parse_api_key_entry("  sk-abc123  work  ");
        assert_eq!(p.serialized, "sk-abc123  work");
        assert_eq!(p.key, "sk-abc123");
        assert_eq!(p.label.as_deref(), Some("work"));
    }

    // ── get_api_key_entries ─────────────────────────────────────────────

    #[test]
    fn get_entries_none_returns_empty_vec() {
        assert!(get_api_key_entries(ApiKeyValue::None).is_empty());
    }

    #[test]
    fn get_entries_one_string_yields_single_parsed_entry() {
        let entries = get_api_key_entries(ApiKeyValue::One("sk-abc work"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "sk-abc");
        assert_eq!(entries[0].label.as_deref(), Some("work"));
    }

    #[test]
    fn get_entries_array_yields_each_entry_in_order() {
        let arr: Vec<String> = vec!["sk-a work".into(), "sk-b home".into()];
        let entries = get_api_key_entries(ApiKeyValue::Many(&arr));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "sk-a");
        assert_eq!(entries[1].key, "sk-b");
    }

    #[test]
    fn get_entries_drops_empty_keys() {
        let arr: Vec<String> = vec!["".into(), "sk-real".into(), "   ".into()];
        let entries = get_api_key_entries(ApiKeyValue::Many(&arr));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "sk-real");
    }

    #[test]
    fn get_entries_drops_the_literal_none_sentinel() {
        // `"none"` is reserved for providers that don't take a real key
        // (claude-code in particular). It's a configured-but-keyless
        // marker, NOT a usable key.
        let arr: Vec<String> = vec!["none".into(), "sk-real".into()];
        let entries = get_api_key_entries(ApiKeyValue::Many(&arr));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "sk-real");
    }

    // ── serialize_api_key_entry ─────────────────────────────────────────

    #[test]
    fn serialize_key_only() {
        assert_eq!(serialize_api_key_entry("sk-abc", None), "sk-abc");
    }

    #[test]
    fn serialize_key_and_label_joined_with_single_space() {
        assert_eq!(
            serialize_api_key_entry("sk-abc", Some("work")),
            "sk-abc work"
        );
    }

    #[test]
    fn serialize_collapses_empty_label_to_just_key() {
        // TS guard: `if (!trimmedLabel)` treats both `""` and `undefined`
        // as falsy. Mirror with the `.filter(|s| !s.is_empty())` chain.
        assert_eq!(serialize_api_key_entry("sk-abc", Some("")), "sk-abc");
        assert_eq!(serialize_api_key_entry("sk-abc", Some("   ")), "sk-abc");
        assert_eq!(serialize_api_key_entry("sk-abc", None), "sk-abc");
    }

    #[test]
    fn serialize_trims_both_key_and_label() {
        assert_eq!(
            serialize_api_key_entry("  sk-abc  ", Some("  work  ")),
            "sk-abc work"
        );
    }

    // ── resolve_api_key ─────────────────────────────────────────────────

    #[test]
    fn resolve_returns_first_entry_key() {
        let arr: Vec<String> = vec!["sk-first".into(), "sk-second".into()];
        assert_eq!(
            resolve_api_key(ApiKeyValue::Many(&arr)),
            Some("sk-first".into())
        );
    }

    #[test]
    fn resolve_skips_empty_and_none_to_find_first_real() {
        let arr: Vec<String> = vec!["".into(), "none".into(), "sk-real".into()];
        assert_eq!(
            resolve_api_key(ApiKeyValue::Many(&arr)),
            Some("sk-real".into())
        );
    }

    #[test]
    fn resolve_returns_none_when_no_usable_key() {
        let arr: Vec<String> = vec!["".into(), "none".into()];
        assert_eq!(resolve_api_key(ApiKeyValue::Many(&arr)), None);
        assert_eq!(resolve_api_key(ApiKeyValue::None), None);
    }

    // ── has_api_key ─────────────────────────────────────────────────────

    #[test]
    fn has_api_key_true_when_at_least_one_real_key() {
        assert!(has_api_key(ApiKeyValue::One("sk-abc")));
        let arr: Vec<String> = vec!["sk-a".into()];
        assert!(has_api_key(ApiKeyValue::Many(&arr)));
    }

    #[test]
    fn has_api_key_false_for_none_or_empty_or_none_sentinel() {
        assert!(!has_api_key(ApiKeyValue::None));
        assert!(!has_api_key(ApiKeyValue::One("")));
        assert!(!has_api_key(ApiKeyValue::One("none")));
        let arr: Vec<String> = vec!["".into(), "none".into()];
        assert!(!has_api_key(ApiKeyValue::Many(&arr)));
    }
}

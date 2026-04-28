//! Pure-data types + helpers for the `models.dev` cache.
//!
//! Mirrors the type definitions and pure helpers from
//! `src/llm/utils/models-dev-cache.ts:13-80, 134-143`. The actual HTTP
//! fetch (`fetchFromApi`), the in-memory cache lifecycle
//! (`ensureCacheLoaded`, `refreshInBackground`), and the disk
//! read/write paths are gated until a Rust HTTP-client substrate
//! lands. Everything in this module is parse / shape / configuration
//! that doesn't depend on networking.
//!
//! When the HTTP substrate lands, the consumer is:
//!
//! ```ignore
//! 1. read cache file → `CacheData` via `parse_cache_data`
//! 2. check `is_stale(cache.fetched_at, now())` → fetch in background
//! 3. on fresh data: serialise via `to_cache_bytes` and write to disk
//! 4. lookup model: `cache.data[provider].models[model_id]` → `ModelsDevModel`
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// `MODELS_DEV_API_URL` — `models-dev-cache.ts:13`. Pinned for parity
/// when the HTTP fetcher lands.
pub const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";

/// `CACHE_FILE_NAME` — `models-dev-cache.ts:14`. The full path is
/// `<config-cache-dir>/models-dev.json` (computed by the caller).
pub const CACHE_FILE_NAME: &str = "models-dev.json";

/// `STALE_THRESHOLD_MS = 24h` — `models-dev-cache.ts:15`.
pub const STALE_THRESHOLD_MS: u64 = 24 * 60 * 60 * 1000;

/// Mirror of `ModelLimits` (`models-dev-cache.ts:20-25`):
/// context window + max output tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelLimits {
    pub context: u64,
    pub output: u64,
}

/// Mirror of `ModelsDevModel` (`models-dev-cache.ts:30-36`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelsDevModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<ModelLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
}

/// One provider's models. Mirrors the inner shape of the TS
/// `ModelsDevResponse[provider]` type.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderModels {
    /// Keyed by model ID; values use the same `ModelsDevModel` shape but
    /// the API response permits `id` to be implicit (matching the map key).
    pub models: BTreeMap<String, ModelsDevModel>,
}

/// Top-level `models.dev` API response. Mirrors `ModelsDevResponse`
/// (`models-dev-cache.ts:41-56`).
pub type ModelsDevResponse = BTreeMap<String, ProviderModels>;

/// Disk cache wrapper. Mirrors `CacheData` (`models-dev-cache.ts:61-64`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheData {
    /// Unix timestamp in milliseconds (TS `Date.now()`).
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
    pub data: ModelsDevResponse,
}

/// `PROVIDER_MAPPING` (`models-dev-cache.ts:73-80`). Maps TENEX provider
/// IDs to the equivalent `models.dev` provider name. `None` means the
/// provider is not in models.dev (local/custom: `ollama`, `codex`).
pub fn provider_mapping() -> [(&'static str, Option<&'static str>); 5] {
    [
        ("anthropic", Some("anthropic")),
        ("openai", Some("openai")),
        ("openrouter", Some("openrouter")),
        ("ollama", None),
        ("codex", None),
    ]
}

/// Look up a TENEX provider ID in [`provider_mapping`]. Returns `None`
/// for unknown TENEX providers (no entry) AND for known providers that
/// have no models.dev mapping (`ollama`, `codex`). Callers usually want
/// to distinguish those — use [`is_known_local_provider`] for that.
pub fn map_to_models_dev_provider(tenex_provider: &str) -> Option<&'static str> {
    provider_mapping()
        .iter()
        .find(|(k, _)| *k == tenex_provider)
        .and_then(|(_, v)| *v)
}

/// `true` iff `tenex_provider` is in the mapping table but maps to
/// `None` (i.e. local/custom — not in models.dev).
pub fn is_known_local_provider(tenex_provider: &str) -> bool {
    provider_mapping()
        .iter()
        .any(|(k, v)| *k == tenex_provider && v.is_none())
}

/// Mirror `isCacheStale` (`models-dev-cache.ts:134-143`).
///
/// Returns `true` when the cache should be refreshed: when no fetched
/// timestamp exists, OR when the difference between `now_ms` and the
/// fetch timestamp exceeds [`STALE_THRESHOLD_MS`]. Pure function — no
/// I/O.
pub fn is_stale(fetched_at_ms: Option<u64>, now_ms: u64) -> bool {
    let Some(fetched) = fetched_at_ms else {
        return true;
    };
    now_ms.saturating_sub(fetched) > STALE_THRESHOLD_MS
}

/// Parse a `CacheData` from the on-disk JSON bytes. Mirrors the
/// `readJsonFile<CacheData>` call in `loadFromDisk`
/// (`models-dev-cache.ts:117`). Returns `Err` for missing /
/// malformed JSON.
pub fn parse_cache_bytes(bytes: &[u8]) -> serde_json::Result<CacheData> {
    serde_json::from_slice(bytes)
}

/// Serialise a `CacheData` for disk writing. Mirrors `writeJsonFile` —
/// pretty-printed with no trailing newline (matches the TS
/// `JSON.stringify(data, null, 2)` shape used elsewhere in the port).
pub fn to_cache_bytes(cache: &CacheData) -> serde_json::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(cache, &mut ser)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── constants ───────────────────────────────────────────────────────

    #[test]
    fn constants_match_spec_verbatim() {
        assert_eq!(MODELS_DEV_API_URL, "https://models.dev/api.json");
        assert_eq!(CACHE_FILE_NAME, "models-dev.json");
        // 24 hours in ms.
        assert_eq!(STALE_THRESHOLD_MS, 86_400_000);
    }

    // ── provider_mapping ────────────────────────────────────────────────

    #[test]
    fn provider_mapping_in_canonical_order() {
        let map = provider_mapping();
        let ids: Vec<&str> = map.iter().map(|(k, _)| *k).collect();
        // Source order at TS `:73-80`.
        assert_eq!(
            ids,
            vec!["anthropic", "openai", "openrouter", "ollama", "codex"]
        );
    }

    #[test]
    fn anthropic_openai_openrouter_map_to_models_dev() {
        assert_eq!(map_to_models_dev_provider("anthropic"), Some("anthropic"));
        assert_eq!(map_to_models_dev_provider("openai"), Some("openai"));
        assert_eq!(map_to_models_dev_provider("openrouter"), Some("openrouter"));
    }

    #[test]
    fn local_providers_map_to_none() {
        assert_eq!(map_to_models_dev_provider("ollama"), None);
        assert_eq!(map_to_models_dev_provider("codex"), None);
    }

    #[test]
    fn unknown_provider_maps_to_none() {
        assert_eq!(map_to_models_dev_provider("does-not-exist"), None);
    }

    #[test]
    fn is_known_local_distinguishes_unknown_from_local() {
        assert!(is_known_local_provider("ollama"));
        assert!(is_known_local_provider("codex"));
        assert!(!is_known_local_provider("anthropic"));
        assert!(!is_known_local_provider("openai"));
        assert!(!is_known_local_provider("openrouter"));
        // Unknown ≠ local — important: caller distinguishes "user typed
        // a provider we don't know about" from "user picked ollama".
        assert!(!is_known_local_provider("does-not-exist"));
    }

    // ── is_stale ────────────────────────────────────────────────────────

    #[test]
    fn is_stale_when_no_timestamp_recorded() {
        assert!(is_stale(None, 0));
        assert!(is_stale(None, u64::MAX));
    }

    #[test]
    fn is_stale_when_age_exceeds_24h() {
        let day_ms = 24 * 60 * 60 * 1000;
        // Exactly 24h is the boundary — TS uses `>`, not `>=`.
        assert!(!is_stale(Some(0), day_ms));
        assert!(is_stale(Some(0), day_ms + 1));
    }

    #[test]
    fn is_stale_fresh_cache_is_not_stale() {
        // 1h old.
        assert!(!is_stale(Some(0), 3_600_000));
    }

    #[test]
    fn is_stale_negative_drift_does_not_panic() {
        // Clock skew → fetched_at is in the future. saturating_sub
        // returns 0; not stale.
        assert!(!is_stale(Some(1_000_000), 500_000));
    }

    // ── parse / serialise round-trip ────────────────────────────────────

    #[test]
    fn parse_cache_bytes_round_trip() {
        let mut response: ModelsDevResponse = BTreeMap::new();
        let mut anthropic_models = BTreeMap::new();
        anthropic_models.insert(
            "claude-sonnet-4".to_string(),
            ModelsDevModel {
                id: "claude-sonnet-4".into(),
                name: "Claude Sonnet 4".into(),
                cost: Some(ModelCost {
                    input: 3.0,
                    output: 15.0,
                }),
                limit: Some(ModelLimits {
                    context: 200_000,
                    output: 8_192,
                }),
                last_updated: Some("2024-06-01".into()),
            },
        );
        response.insert(
            "anthropic".to_string(),
            ProviderModels {
                models: anthropic_models,
            },
        );

        let cache = CacheData {
            fetched_at: 1_700_000_000_000,
            data: response,
        };

        let bytes = to_cache_bytes(&cache).unwrap();
        let parsed = parse_cache_bytes(&bytes).unwrap();
        assert_eq!(parsed.fetched_at, 1_700_000_000_000);
        let model = parsed
            .data
            .get("anthropic")
            .unwrap()
            .models
            .get("claude-sonnet-4")
            .unwrap();
        assert_eq!(model.name, "Claude Sonnet 4");
        assert_eq!(
            model.limit,
            Some(ModelLimits {
                context: 200_000,
                output: 8_192
            })
        );
    }

    #[test]
    fn parse_cache_bytes_uses_camel_case_fetched_at() {
        // The TS source serialises `fetchedAt` (camelCase). Pin it so
        // disk-cache files written by either implementation are
        // mutually readable.
        let bytes = br#"{"fetchedAt":12345,"data":{}}"#;
        let parsed = parse_cache_bytes(bytes).unwrap();
        assert_eq!(parsed.fetched_at, 12345);
        assert!(parsed.data.is_empty());
    }

    #[test]
    fn parse_cache_bytes_rejects_malformed_input() {
        assert!(parse_cache_bytes(b"not-json").is_err());
        assert!(parse_cache_bytes(b"{}").is_err()); // missing fetchedAt
    }

    #[test]
    fn omits_optional_fields_in_serialised_form() {
        let model = ModelsDevModel {
            id: "alpha".into(),
            name: "Alpha".into(),
            cost: None,
            limit: None,
            last_updated: None,
        };
        let bytes = serde_json::to_vec(&model).unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(!s.contains("cost"));
        assert!(!s.contains("limit"));
        assert!(!s.contains("last_updated"));
    }
}

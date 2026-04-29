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

/// Mirror `getCacheFilePath` (`models-dev-cache.ts:85-87`).
///
/// Returns `<base_dir>/cache/models-dev.json`. The TS source resolves
/// the `cache` subdirectory via `config.getConfigPath("cache")` —
/// equivalent to joining `cache` onto the TENEX base dir
/// (`ConfigService.ts:96-99`).
pub fn cache_file_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("cache").join(CACHE_FILE_NAME)
}

/// Mirror `loadFromDisk` (`models-dev-cache.ts:112-118`).
///
/// Reads `<base_dir>/cache/models-dev.json` and parses it. Three return
/// shapes:
///
/// - `Ok(Some(cache))` — file exists and parsed cleanly
/// - `Ok(None)` — file does not exist (TS `fileExists` false branch)
/// - `Err(_)` — file exists but read or parse failed
///
/// Note the TS source returns `null` for both "missing" and "malformed"
/// cases (the `readJsonFile` helper logs and returns `null`). The Rust
/// port distinguishes them so the caller can surface a parse error
/// loudly instead of silently fetching from the network.
pub fn load_from_disk(
    base_dir: &std::path::Path,
) -> std::io::Result<Option<CacheData>> {
    let path = cache_file_path(base_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    parse_cache_bytes(&bytes)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Mirror `resolveModelData` (`models-dev-cache.ts:240-271`).
///
/// Three-step lookup against a parsed [`ModelsDevResponse`]:
///
/// 1. **Direct lookup** — map TENEX provider via [`map_to_models_dev_provider`]
///    and look up the model under that provider's section.
/// 2. **Vendor-prefix split** — when `model` contains `/`, treat the
///    prefix as a vendor and look up the bare model under that vendor.
///    (Used by OpenRouter-style IDs like `anthropic/claude-3.5-sonnet`.)
/// 3. **Global scan** — last-resort linear scan across every provider
///    in the cache for an exact model-ID match.
///
/// Returns `(resolved_model_id, model_data)`. The resolved ID may differ
/// from the input — when step 2 fires it's the bare model after the
/// vendor prefix.
pub fn resolve_model_data<'a>(
    cache: &'a ModelsDevResponse,
    provider: &str,
    model: &str,
) -> Option<(String, &'a ModelsDevModel)> {
    // 1. Direct lookup in the mapped provider section.
    if let Some(models_dev_provider) = map_to_models_dev_provider(provider) {
        if let Some(provider_data) = cache.get(models_dev_provider) {
            if let Some(data) = provider_data.models.get(model) {
                return Some((model.to_owned(), data));
            }
        }
    }

    // 2. Vendor-prefix split (`vendor/bare`).
    if let Some(slash_idx) = model.find('/') {
        let vendor = &model[..slash_idx];
        let bare_model = &model[slash_idx + 1..];
        if let Some(vendor_data) = cache.get(vendor) {
            if let Some(data) = vendor_data.models.get(bare_model) {
                return Some((bare_model.to_owned(), data));
            }
        }
    }

    // 3. Global scan: search every provider for a matching model ID.
    for section in cache.values() {
        if let Some(data) = section.models.get(model) {
            return Some((model.to_owned(), data));
        }
    }

    None
}

/// Mirror `getModelInfo` (`models-dev-cache.ts:294-306`).
///
/// Wraps [`resolve_model_data`] and assembles a `ModelsDevModel` whose
/// `id` and `name` fall back to the resolved model ID when the
/// underlying data has empty values (TS uses `data.id ?? modelId` /
/// `data.name ?? modelId` — `??` matches `None`-or-empty for `String`
/// here since serde gives us `String::new()` for missing strings).
pub fn get_model_info(
    cache: &ModelsDevResponse,
    provider: &str,
    model: &str,
) -> Option<ModelsDevModel> {
    let (resolved_id, data) = resolve_model_data(cache, provider, model)?;
    let id = if data.id.is_empty() { resolved_id.clone() } else { data.id.clone() };
    let name = if data.name.is_empty() { resolved_id } else { data.name.clone() };
    Some(ModelsDevModel {
        id,
        name,
        cost: data.cost.clone(),
        limit: data.limit.clone(),
        last_updated: data.last_updated.clone(),
    })
}

/// Mirror `getContextWindowFromModelsdev` (`models-dev-cache.ts:311-314`).
/// Convenience getter for the context limit when present.
pub fn context_window(
    cache: &ModelsDevResponse,
    provider: &str,
    model: &str,
) -> Option<u64> {
    let (_, data) = resolve_model_data(cache, provider, model)?;
    data.limit.as_ref().map(|l| l.context)
}

/// Mirror the inline label builder in `selectModelsDevModel`
/// (`src/llm/utils/ModelSelector.ts:188-203`).
///
/// Builds the visible label shown for one row in the model picker:
///
/// ```text
/// {name} ({id}) - {ctx}k ctx, ${input}/${output}/M
/// ```
///
/// The `(id)` and trailing `- {meta}` segments render in `chalk.gray`
/// in the TS source. This function returns the **raw** strings (no ANSI
/// styling) — callers wrap individual segments with the muted-gray
/// style at render time. Splitting it this way keeps the formatter
/// pure / testable while letting the renderer apply the right palette
/// (`crate::tui::theme::muted_gray`).
///
/// Returned tuple shape:
/// `(human_name, id_segment, meta_segment_or_empty)`
///
/// where `meta_segment` is `"<ctx>k ctx, $<input>/$<output>/M"` (joined
/// with `", "` only when both sides are present); empty when neither
/// `limit.context` nor `cost` is available. The TS source filters
/// empty strings before joining, so absence of one collapses the
/// separator.
pub fn picker_label_segments(model: &ModelsDevModel) -> (String, String, String) {
    let id_segment = format!("({})", model.id);
    let ctx_str = model
        .limit
        .as_ref()
        .map(|l| format!("{}k ctx", (l.context as f64 / 1000.0).round() as u64));
    let pricing_str = model
        .cost
        .as_ref()
        .map(|c| format!("${}/${}/M", c.input, c.output));
    let meta_pieces: Vec<String> = [ctx_str, pricing_str].into_iter().flatten().collect();
    let meta_segment = if meta_pieces.is_empty() {
        String::new()
    } else {
        format!("- {}", meta_pieces.join(", "))
    };
    (model.name.clone(), id_segment, meta_segment)
}

/// Mirror `getDefaultModelForProvider` (`ConfigurationManager.ts:260-270`).
///
/// Returns the canned default model ID for each TENEX provider. Used by
/// the add-configuration flow as the initial `default` value of the
/// model picker. Returns `""` for unknown providers and for
/// `claude-code` (which has no concept of a model in the TS source —
/// the `defaults` table maps it to the empty string).
pub fn default_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "openrouter" => "openai/gpt-4",
        "anthropic" => "claude-3-5-sonnet-latest",
        "openai" => "gpt-4",
        "ollama" => "llama3.1:8b",
        "codex" => "gpt-5.1-codex-max",
        "claude-code" => "",
        _ => "",
    }
}

/// Mirror `getProviderModels` (`models-dev-cache.ts:319-337`).
///
/// Returns every model under the mapped provider's section, sorted by
/// `last_updated` descending (newest first). Empty for unmapped or
/// local-only providers (`ollama`, `codex`) and for providers absent
/// from the cache.
///
/// The id/name fallback to the map key matches TS `data.id ?? modelId`
/// — empty strings collapse to the map key (the BTreeMap key is the
/// authoritative model ID for each entry).
///
/// Sort: TS uses `localeCompare(b.last_updated ?? "", a.last_updated ?? "")`
/// for descending order. We emulate the JS `??` semantics on `Option<String>`
/// by treating `None` as `""`. Entries with a real `last_updated` sort
/// before entries without (since `"2024-..." > ""` lexicographically),
/// and ties fall back to insertion order via Rust's stable sort.
pub fn get_provider_models(
    cache: &ModelsDevResponse,
    provider: &str,
) -> Vec<ModelsDevModel> {
    let Some(models_dev_provider) = map_to_models_dev_provider(provider) else {
        return Vec::new();
    };
    let Some(provider_data) = cache.get(models_dev_provider) else {
        return Vec::new();
    };

    let mut out: Vec<ModelsDevModel> = provider_data
        .models
        .iter()
        .map(|(model_id, data)| ModelsDevModel {
            id: if data.id.is_empty() {
                model_id.clone()
            } else {
                data.id.clone()
            },
            name: if data.name.is_empty() {
                model_id.clone()
            } else {
                data.name.clone()
            },
            cost: data.cost.clone(),
            limit: data.limit.clone(),
            last_updated: data.last_updated.clone(),
        })
        .collect();
    out.sort_by(|a, b| {
        let a_key = a.last_updated.as_deref().unwrap_or("");
        let b_key = b.last_updated.as_deref().unwrap_or("");
        b_key.cmp(a_key)
    });
    out
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

    // ── resolve_model_data + get_model_info ─────────────────────────────

    fn build_cache(entries: &[(&str, &str, ModelsDevModel)]) -> ModelsDevResponse {
        let mut out: ModelsDevResponse = BTreeMap::new();
        for (provider, model_id, data) in entries {
            let entry = out
                .entry((*provider).to_owned())
                .or_default();
            entry.models.insert((*model_id).to_owned(), data.clone());
        }
        out
    }

    fn model(id: &str, ctx: u64, input_cost: f64) -> ModelsDevModel {
        ModelsDevModel {
            id: id.into(),
            name: id.into(),
            cost: Some(ModelCost {
                input: input_cost,
                output: input_cost * 5.0,
            }),
            limit: Some(ModelLimits {
                context: ctx,
                output: 4096,
            }),
            last_updated: None,
        }
    }

    #[test]
    fn resolve_direct_lookup_via_provider_mapping() {
        // anthropic → models.dev "anthropic" section.
        let cache = build_cache(&[("anthropic", "claude-sonnet-4-6", model("claude-sonnet-4-6", 200_000, 3.0))]);
        let resolved = resolve_model_data(&cache, "anthropic", "claude-sonnet-4-6").unwrap();
        assert_eq!(resolved.0, "claude-sonnet-4-6");
        assert_eq!(resolved.1.limit.as_ref().unwrap().context, 200_000);
    }

    #[test]
    fn resolve_vendor_slash_split_for_openrouter_style_ids() {
        // Model ID "anthropic/claude-3.5-sonnet" — first lookup misses
        // because the ID isn't in openrouter's section, then vendor
        // split finds it under "anthropic".
        let cache = build_cache(&[(
            "anthropic",
            "claude-3.5-sonnet",
            model("claude-3.5-sonnet", 200_000, 3.0),
        )]);
        let resolved =
            resolve_model_data(&cache, "openrouter", "anthropic/claude-3.5-sonnet").unwrap();
        // The resolved id is the *bare* model after the slash strip.
        assert_eq!(resolved.0, "claude-3.5-sonnet");
    }

    #[test]
    fn resolve_global_scan_when_provider_section_missing() {
        // Cache has only "openai" but caller looks up via an unknown
        // provider — global scan finds the model under "openai".
        let cache = build_cache(&[("openai", "gpt-4o", model("gpt-4o", 128_000, 2.5))]);
        let resolved = resolve_model_data(&cache, "totally-unknown", "gpt-4o").unwrap();
        assert_eq!(resolved.0, "gpt-4o");
    }

    #[test]
    fn resolve_returns_none_for_truly_missing_model() {
        let cache = build_cache(&[("anthropic", "claude-sonnet-4-6", model("claude-sonnet-4-6", 200_000, 3.0))]);
        assert!(resolve_model_data(&cache, "openai", "gpt-4o").is_none());
        assert!(resolve_model_data(&cache, "anthropic", "missing-model").is_none());
    }

    #[test]
    fn resolve_local_provider_falls_through_to_global_scan() {
        // ollama maps to None in the provider mapping → step 1 skipped.
        // The model ID also has no slash → step 2 skipped. Step 3
        // global-scans and may find a match.
        let cache = build_cache(&[("anthropic", "claude-sonnet-4-6", model("claude-sonnet-4-6", 200_000, 3.0))]);
        let resolved = resolve_model_data(&cache, "ollama", "claude-sonnet-4-6").unwrap();
        assert_eq!(resolved.0, "claude-sonnet-4-6");
    }

    #[test]
    fn get_model_info_falls_back_to_resolved_id_when_data_id_empty() {
        // Construct a model with an empty `id` field — get_model_info
        // should populate id+name from the resolved key.
        let mut empty_id_model = model("ignored", 100_000, 1.0);
        empty_id_model.id = String::new();
        empty_id_model.name = String::new();
        let cache = build_cache(&[("anthropic", "claude-x", empty_id_model)]);
        let info = get_model_info(&cache, "anthropic", "claude-x").unwrap();
        assert_eq!(info.id, "claude-x");
        assert_eq!(info.name, "claude-x");
    }

    #[test]
    fn context_window_returns_limit_context_when_present() {
        let cache = build_cache(&[("anthropic", "claude-x", model("claude-x", 200_000, 3.0))]);
        assert_eq!(context_window(&cache, "anthropic", "claude-x"), Some(200_000));
    }

    #[test]
    fn context_window_returns_none_when_model_missing() {
        let cache = ModelsDevResponse::new();
        assert_eq!(context_window(&cache, "anthropic", "claude-x"), None);
    }

    #[test]
    fn context_window_returns_none_when_limit_field_absent() {
        let mut no_limit = model("claude-x", 0, 3.0);
        no_limit.limit = None;
        let cache = build_cache(&[("anthropic", "claude-x", no_limit)]);
        assert_eq!(context_window(&cache, "anthropic", "claude-x"), None);
    }

    // ── cache_file_path + load_from_disk ────────────────────────────────

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-models-dev-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn cache_file_path_joins_base_with_cache_subdir() {
        let base = std::path::Path::new("/tmp/whatever");
        assert_eq!(
            cache_file_path(base),
            std::path::PathBuf::from("/tmp/whatever/cache/models-dev.json")
        );
    }

    #[test]
    fn load_from_disk_returns_none_when_cache_dir_missing() {
        let base = unique_temp();
        // No cache subdir created; load returns Ok(None).
        let result = load_from_disk(&base).unwrap();
        assert!(result.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_from_disk_returns_none_when_cache_file_missing_but_dir_exists() {
        let base = unique_temp();
        std::fs::create_dir_all(base.join("cache")).unwrap();
        let result = load_from_disk(&base).unwrap();
        assert!(result.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_from_disk_returns_some_when_cache_file_parses() {
        let base = unique_temp();
        std::fs::create_dir_all(base.join("cache")).unwrap();
        let payload = br#"{"fetchedAt":1234567,"data":{"anthropic":{"models":{"claude-x":{"id":"claude-x","name":"Claude X"}}}}}"#;
        std::fs::write(base.join("cache").join(CACHE_FILE_NAME), payload).unwrap();

        let cache = load_from_disk(&base).unwrap().unwrap();
        assert_eq!(cache.fetched_at, 1_234_567);
        assert_eq!(
            cache.data.get("anthropic")
                .and_then(|p| p.models.get("claude-x"))
                .map(|m| m.name.as_str()),
            Some("Claude X"),
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ── get_provider_models ─────────────────────────────────────────────

    #[test]
    fn get_provider_models_returns_empty_for_unmapped_provider() {
        let cache = build_cache(&[("anthropic", "claude-x", model("claude-x", 100_000, 3.0))]);
        // ollama maps to None in PROVIDER_MAPPING.
        assert!(get_provider_models(&cache, "ollama").is_empty());
        // Unknown provider — also empty.
        assert!(get_provider_models(&cache, "totally-unknown").is_empty());
    }

    #[test]
    fn get_provider_models_returns_empty_when_provider_section_missing() {
        let cache = build_cache(&[("openai", "gpt-4o", model("gpt-4o", 128_000, 2.5))]);
        // anthropic maps to "anthropic" but the cache only has openai.
        assert!(get_provider_models(&cache, "anthropic").is_empty());
    }

    #[test]
    fn get_provider_models_lists_every_model_under_the_mapped_provider() {
        let cache = build_cache(&[
            ("anthropic", "a", model("a", 100, 1.0)),
            ("anthropic", "b", model("b", 200, 2.0)),
            ("anthropic", "c", model("c", 300, 3.0)),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        assert_eq!(models.len(), 3);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        // BTreeMap preserves alphabetic key order; with no last_updated
        // fields the secondary sort is stable and we get a, b, c.
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn get_provider_models_sorts_by_last_updated_descending() {
        let mut older = model("old", 100, 1.0);
        older.last_updated = Some("2023-06-01".into());
        let mut newer = model("new", 100, 1.0);
        newer.last_updated = Some("2024-12-01".into());
        let mut middle = model("mid", 100, 1.0);
        middle.last_updated = Some("2024-01-01".into());

        let cache = build_cache(&[
            ("anthropic", "old", older),
            ("anthropic", "new", newer),
            ("anthropic", "mid", middle),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn get_provider_models_entries_with_last_updated_sort_before_those_without() {
        // TS: `(b.last_updated ?? "")` → entries with a real timestamp
        // beat entries without (since any non-empty string > "" in
        // ascending; descending puts non-empty first).
        let mut dated = model("dated", 100, 1.0);
        dated.last_updated = Some("2024-01-01".into());
        let undated = model("undated", 100, 1.0); // last_updated: None
        let cache = build_cache(&[
            ("anthropic", "dated", dated),
            ("anthropic", "undated", undated),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["dated", "undated"]);
    }

    #[test]
    fn get_provider_models_id_falls_back_to_map_key_when_empty() {
        let mut empty_id = model("ignored", 100, 1.0);
        empty_id.id = String::new();
        empty_id.name = String::new();
        let cache = build_cache(&[("anthropic", "the-key", empty_id)]);
        let models = get_provider_models(&cache, "anthropic");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "the-key");
        assert_eq!(models[0].name, "the-key");
    }

    // ── picker_label_segments ──────────────────────────────────────────

    #[test]
    fn picker_label_segments_full_with_ctx_and_cost() {
        let m = ModelsDevModel {
            id: "claude-sonnet-4-6".into(),
            name: "Claude Sonnet 4.6".into(),
            cost: Some(ModelCost {
                input: 3.0,
                output: 15.0,
            }),
            limit: Some(ModelLimits {
                context: 200_000,
                output: 8192,
            }),
            last_updated: None,
        };
        let (name, id_seg, meta) = picker_label_segments(&m);
        assert_eq!(name, "Claude Sonnet 4.6");
        assert_eq!(id_seg, "(claude-sonnet-4-6)");
        // 200_000 / 1000 = 200; "200k ctx, $3/$15/M".
        assert_eq!(meta, "- 200k ctx, $3/$15/M");
    }

    #[test]
    fn picker_label_segments_rounds_ctx_to_nearest_thousand() {
        // The TS uses `Math.round(context / 1000)` — 199_999 rounds to
        // 200, not 199.
        let mut m = model("x", 199_999, 1.0);
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "- 200k ctx");
    }

    #[test]
    fn picker_label_segments_no_meta_when_both_fields_absent() {
        let mut m = model("x", 0, 1.0);
        m.limit = None;
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "");
    }

    #[test]
    fn picker_label_segments_only_ctx_when_cost_absent() {
        let mut m = model("x", 100_000, 1.0);
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "- 100k ctx");
    }

    #[test]
    fn picker_label_segments_only_cost_when_limit_absent() {
        let mut m = model("x", 0, 2.5);
        m.limit = None;
        let (_, _, meta) = picker_label_segments(&m);
        // input 2.5, output computed as 2.5 * 5 = 12.5
        assert_eq!(meta, "- $2.5/$12.5/M");
    }

    // ── default_model_for_provider ─────────────────────────────────────

    #[test]
    fn default_model_for_each_canonical_provider_matches_ts_table() {
        // Mirror the `defaults` table at ConfigurationManager.ts:261-268.
        assert_eq!(default_model_for_provider("openrouter"), "openai/gpt-4");
        assert_eq!(default_model_for_provider("anthropic"), "claude-3-5-sonnet-latest");
        assert_eq!(default_model_for_provider("openai"), "gpt-4");
        assert_eq!(default_model_for_provider("ollama"), "llama3.1:8b");
        assert_eq!(default_model_for_provider("codex"), "gpt-5.1-codex-max");
        assert_eq!(default_model_for_provider("claude-code"), "");
    }

    #[test]
    fn default_model_for_unknown_provider_is_empty_string() {
        // TS uses `defaults[provider] || ""` — falsy lookup falls
        // through to "". Matches the unknown-provider branch.
        assert_eq!(default_model_for_provider("totally-made-up"), "");
        assert_eq!(default_model_for_provider(""), "");
    }

    #[test]
    fn get_provider_models_handles_openrouter_section() {
        // openrouter maps to "openrouter" (1:1).
        let cache = build_cache(&[(
            "openrouter",
            "anthropic/claude-3.5-sonnet",
            model("anthropic/claude-3.5-sonnet", 200_000, 3.0),
        )]);
        let models = get_provider_models(&cache, "openrouter");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "anthropic/claude-3.5-sonnet");
    }

    #[test]
    fn load_from_disk_returns_err_when_cache_file_is_malformed() {
        // TS's `readJsonFile` logs+returns null on malformed input; the
        // Rust port surfaces the parse error loudly so callers don't
        // silently miss the cache and hit the network.
        let base = unique_temp();
        std::fs::create_dir_all(base.join("cache")).unwrap();
        std::fs::write(base.join("cache").join(CACHE_FILE_NAME), b"{ not json").unwrap();

        let err = load_from_disk(&base).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        std::fs::remove_dir_all(&base).ok();
    }
}

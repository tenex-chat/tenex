//! Pure-data types + on-disk cache parsing for the `models.dev` catalog.
//!
//! The supervisor (`tenex/`) owns refresh/fetch/write of the cache; this
//! crate is the shared substrate that exposes the cached data to agent
//! runtimes so they can derive model capabilities (vision support,
//! context window, …) without duplicating the parsing.
//!
//! Cache file layout: `<base_dir>/cache/models-dev.json`, JSON of shape
//! `{ "fetchedAt": <ms>, "data": { "<provider>": { "models": { "<id>": {…} } } } }`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Disk filename of the on-disk cache, inside `<base_dir>/cache/`.
pub const CACHE_FILE_NAME: &str = "models-dev.json";

/// Context window (`limit.context`) and per-response output cap
/// (`limit.output`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelLimits {
    pub context: u64,
    pub output: u64,
}

/// Input/output modalities supported by the model. The models.dev schema
/// uses string lists such as `["text", "image", "video", "audio"]`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelModalities {
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub output: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
}

/// One model entry. `id`/`name` may be empty in the source data; callers
/// that need a display string should fall back to the map key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelsDevModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<ModelLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModelModalities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
}

/// Models grouped by provider. Inner shape of `ModelsDevResponse[provider]`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderModels {
    pub models: BTreeMap<String, ModelsDevModel>,
}

/// Top-level cache map: provider → its models.
pub type ModelsDevResponse = BTreeMap<String, ProviderModels>;

/// On-disk cache wrapper with a fetched-at timestamp.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheData {
    /// Unix timestamp in milliseconds (JS `Date.now()`).
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
    pub data: ModelsDevResponse,
}

/// Mapping from TENEX provider IDs to `models.dev` provider names.
/// `None` means the provider has no models.dev catalog entry (local
/// providers `ollama`, `codex`).
pub fn provider_mapping() -> [(&'static str, Option<&'static str>); 5] {
    [
        ("anthropic", Some("anthropic")),
        ("openai", Some("openai")),
        ("openrouter", Some("openrouter")),
        ("ollama", None),
        ("codex", None),
    ]
}

/// Resolve a TENEX provider ID to its `models.dev` provider name, if any.
pub fn map_to_models_dev_provider(tenex_provider: &str) -> Option<&'static str> {
    provider_mapping()
        .iter()
        .find(|(k, _)| *k == tenex_provider)
        .and_then(|(_, v)| *v)
}

/// Path of the on-disk cache file: `<base_dir>/cache/models-dev.json`.
pub fn cache_file_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("cache").join(CACHE_FILE_NAME)
}

/// Parse cache bytes into a `CacheData`. Returns `Err` for missing or
/// malformed JSON.
pub fn parse_cache_bytes(bytes: &[u8]) -> serde_json::Result<CacheData> {
    serde_json::from_slice(bytes)
}

/// Read `<base_dir>/cache/models-dev.json` from disk.
///
/// - `Ok(Some(cache))` — file exists and parsed cleanly
/// - `Ok(None)` — file does not exist
/// - `Err(_)` — file exists but read or parse failed
pub fn load_from_disk(base_dir: &std::path::Path) -> std::io::Result<Option<CacheData>> {
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

/// Three-step lookup for a `(provider, model)` pair.
///
/// 1. **Direct** — translate the TENEX provider via
///    [`map_to_models_dev_provider`] and look up `model` under that
///    provider's section.
/// 2. **Vendor-prefix split** — when `model` contains `/`, treat the
///    prefix as a vendor and look up the bare model under that vendor.
/// 3. **Global scan** — last-resort linear scan across every provider
///    for an exact model-ID match.
///
/// Returns `(resolved_model_id, model_data)` — the resolved ID equals the
/// input except in step 2, where it's the bare ID after the vendor prefix.
pub fn resolve_model_data<'a>(
    cache: &'a ModelsDevResponse,
    provider: &str,
    model: &str,
) -> Option<(String, &'a ModelsDevModel)> {
    if let Some(models_dev_provider) = map_to_models_dev_provider(provider) {
        if let Some(provider_data) = cache.get(models_dev_provider) {
            if let Some(data) = provider_data.models.get(model) {
                return Some((model.to_owned(), data));
            }
        }
    }

    if let Some(slash_idx) = model.find('/') {
        let vendor = &model[..slash_idx];
        let bare_model = &model[slash_idx + 1..];
        if let Some(vendor_data) = cache.get(vendor) {
            if let Some(data) = vendor_data.models.get(bare_model) {
                return Some((bare_model.to_owned(), data));
            }
        }
    }

    for section in cache.values() {
        if let Some(data) = section.models.get(model) {
            return Some((model.to_owned(), data));
        }
    }

    None
}

/// Whether the model accepts image input, per its `modalities.input`
/// list. Returns `false` when the model is not in the cache, has no
/// declared modalities, or only lists `text`.
pub fn image_support_for(cache: &ModelsDevResponse, provider: &str, model: &str) -> bool {
    let Some((_, data)) = resolve_model_data(cache, provider, model) else {
        return false;
    };
    data.modalities
        .as_ref()
        .is_some_and(|m| m.input.iter().any(|s| s == "image"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_cache(entries: &[(&str, &str, ModelsDevModel)]) -> ModelsDevResponse {
        let mut out: ModelsDevResponse = BTreeMap::new();
        for (provider, model_id, data) in entries {
            let entry = out.entry((*provider).to_owned()).or_default();
            entry.models.insert((*model_id).to_owned(), data.clone());
        }
        out
    }

    fn vision_model(id: &str) -> ModelsDevModel {
        ModelsDevModel {
            id: id.into(),
            name: id.into(),
            modalities: Some(ModelModalities {
                input: vec!["text".into(), "image".into()],
                output: vec!["text".into()],
            }),
            ..Default::default()
        }
    }

    fn text_only_model(id: &str) -> ModelsDevModel {
        ModelsDevModel {
            id: id.into(),
            name: id.into(),
            modalities: Some(ModelModalities {
                input: vec!["text".into()],
                output: vec!["text".into()],
            }),
            ..Default::default()
        }
    }

    #[test]
    fn maps_known_providers() {
        assert_eq!(map_to_models_dev_provider("anthropic"), Some("anthropic"));
        assert_eq!(map_to_models_dev_provider("openai"), Some("openai"));
        assert_eq!(map_to_models_dev_provider("openrouter"), Some("openrouter"));
        assert_eq!(map_to_models_dev_provider("ollama"), None);
        assert_eq!(map_to_models_dev_provider("codex"), None);
        assert_eq!(map_to_models_dev_provider("does-not-exist"), None);
    }

    #[test]
    fn resolve_direct_lookup() {
        let cache = build_cache(&[("anthropic", "claude-sonnet-4-6", vision_model("claude-sonnet-4-6"))]);
        let (id, data) = resolve_model_data(&cache, "anthropic", "claude-sonnet-4-6").unwrap();
        assert_eq!(id, "claude-sonnet-4-6");
        assert_eq!(data.id, "claude-sonnet-4-6");
    }

    #[test]
    fn resolve_vendor_prefix_split() {
        let cache = build_cache(&[("alibaba", "qwen3.5-397b-a17b", vision_model("qwen3.5-397b-a17b"))]);
        // Caller passes `openrouter` + `alibaba/qwen3.5-397b-a17b`: step
        // 1 misses (openrouter section absent), step 2 splits on `/` and
        // finds the model under `alibaba`.
        let (id, _) = resolve_model_data(&cache, "openrouter", "alibaba/qwen3.5-397b-a17b").unwrap();
        assert_eq!(id, "qwen3.5-397b-a17b");
    }

    #[test]
    fn resolve_global_scan_finds_model_under_any_provider() {
        let cache = build_cache(&[("alibaba", "qwen3.5-397b-a17b", vision_model("qwen3.5-397b-a17b"))]);
        // `ollama` doesn't map to a models.dev provider; vendor split
        // doesn't match either. Step 3 (global scan) finds it.
        let (id, _) = resolve_model_data(&cache, "ollama", "qwen3.5-397b-a17b").unwrap();
        assert_eq!(id, "qwen3.5-397b-a17b");
    }

    #[test]
    fn image_support_true_when_modalities_include_image() {
        let cache = build_cache(&[("anthropic", "claude-3-5-sonnet", vision_model("claude-3-5-sonnet"))]);
        assert!(image_support_for(&cache, "anthropic", "claude-3-5-sonnet"));
    }

    #[test]
    fn image_support_false_for_text_only_model() {
        let cache = build_cache(&[("openai", "o1-mini", text_only_model("o1-mini"))]);
        assert!(!image_support_for(&cache, "openai", "o1-mini"));
    }

    #[test]
    fn image_support_false_when_modalities_missing() {
        let mut m = vision_model("foo");
        m.modalities = None;
        let cache = build_cache(&[("anthropic", "foo", m)]);
        assert!(!image_support_for(&cache, "anthropic", "foo"));
    }

    #[test]
    fn image_support_false_when_model_absent_from_cache() {
        let cache: ModelsDevResponse = BTreeMap::new();
        assert!(!image_support_for(&cache, "anthropic", "claude-3-5-sonnet"));
    }

    #[test]
    fn parse_cache_bytes_round_trip_preserves_modalities() {
        let cache = CacheData {
            fetched_at: 1_700_000_000_000,
            data: build_cache(&[("alibaba", "qwen3.5-397b-a17b", vision_model("qwen3.5-397b-a17b"))]),
        };
        let bytes = serde_json::to_vec(&cache).unwrap();
        let parsed = parse_cache_bytes(&bytes).unwrap();
        assert!(image_support_for(&parsed.data, "alibaba", "qwen3.5-397b-a17b"));
    }

    #[test]
    fn parse_tolerates_missing_modalities_field() {
        // Older cache files written before this field existed must still
        // round-trip cleanly — modalities defaults to `None`.
        let bytes = br#"{"fetchedAt":1,"data":{"anthropic":{"models":{"x":{"id":"x","name":"x"}}}}}"#;
        let parsed = parse_cache_bytes(bytes).unwrap();
        let model = parsed.data["anthropic"].models.get("x").unwrap();
        assert!(model.modalities.is_none());
    }

    #[test]
    fn parse_accepts_modalities_with_extra_inputs() {
        // qwen3.5 lists `["text", "image", "video", "audio"]` — extra
        // modalities beyond `image` must not trip image-support detection.
        let bytes = br#"{
            "fetchedAt": 1,
            "data": {
                "alibaba": {
                    "models": {
                        "qwen3.5-397b-a17b": {
                            "id": "qwen3.5-397b-a17b",
                            "name": "Qwen 3.5",
                            "modalities": { "input": ["text","image","video","audio"], "output": ["text"] }
                        }
                    }
                }
            }
        }"#;
        let parsed = parse_cache_bytes(bytes).unwrap();
        assert!(image_support_for(&parsed.data, "alibaba", "qwen3.5-397b-a17b"));
    }
}

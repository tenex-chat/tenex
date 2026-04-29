//! `~/.tenex/providers.json` reader/writer.
//!
//! Schema source: `TenexProvidersSchema` at `src/services/config/types.ts:435-437`
//! (`providers: Record<string, ProviderCredentials>`), where
//! `ProviderCredentials = { apiKey: string | string[], baseUrl?, timeout?,
//! options? }` (`:414-419`).
//!
//! Multi-key duality (spec doc 04 §1, "Multiple-keys model"):
//!
//! - 1 key  → `apiKey` persists as a bare JSON string.
//! - ≥2 keys → `apiKey` persists as a JSON array of strings.
//! - Removing entries shrinks back to a bare string at length 1.
//!
//! The collapse rule is enforced at the [`set_api_keys`] boundary so the
//! on-disk shape always matches the TS writer
//! (`KeyManager.serializeApiKeyEntry` + `setProviderKeys`).
//!
//! Storage uses `IndexMap`-backed `serde_json::Value` (with
//! `serde_json/preserve_order`) so untouched fields, top-level provider
//! ordering, and nested `options` ordering all round-trip byte-identically.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::atomic;

const FILE_NAME: &str = "providers.json";
const TOP_KEY: &str = "providers";

/// On-disk representation of `providers.json`. Lossless round-trip.
#[derive(Debug, Clone, Default)]
pub struct ProvidersDoc {
    raw: IndexMap<String, Value>,
}

impl ProvidersDoc {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Load `<base_dir>/providers.json`. Returns an empty document when the
    /// file does not exist (matches TS default-on-ENOENT at
    /// `src/services/ConfigService.ts:911-940`).
    pub fn load(base_dir: &Path) -> Result<Self> {
        let path = base_dir.join(FILE_NAME);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let raw: IndexMap<String, Value> = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing {}", path.display()))?;
                Ok(Self { raw })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(anyhow!(e)).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, base_dir: &Path) -> Result<()> {
        let path = base_dir.join(FILE_NAME);
        let bytes = serialize(&self.raw)?;
        atomic::write(&path, &bytes)
    }

    #[cfg(test)]
    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    // ---- typed accessors (provider map) ---------------------------------

    /// Iterate provider IDs in the order they appear on disk.
    pub fn provider_ids(&self) -> Vec<String> {
        self.providers_obj()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Iterate provider IDs that are *configured*: either have at least
    /// one usable API key, or carry the literal `"none"` string sentinel.
    ///
    /// Mirrors the filter at `src/llm/utils/ConfigurationManager.ts:22-27`:
    ///
    /// ```ts
    /// Object.keys(llmsConfig.providers).filter((p) => {
    ///     const key = llmsConfig.providers[p]?.apiKey;
    ///     return hasApiKey(key) || key === "none";
    /// })
    /// ```
    ///
    /// The `key === "none"` branch covers `claude-code` (and other
    /// providers that don't take an API key but should still appear
    /// configured). It uses *strict equality* on the scalar — the
    /// `"none"` sentinel is only honoured when `apiKey` is the bare
    /// string, never when it appears inside an array.
    pub fn configured_provider_ids(&self) -> Vec<String> {
        use crate::store::api_keys::{has_api_key, ApiKeyValue};
        self.provider_ids()
            .into_iter()
            .filter(|id| {
                let Some(entry) = self.get(id) else {
                    return false;
                };
                match entry.raw_api_key_value() {
                    Some(Value::String(s)) => {
                        // Bare string: include if it's a real key OR the
                        // literal `"none"` sentinel. `has_api_key` already
                        // filters `"none"` out of its "real" branch.
                        s == "none" || has_api_key(ApiKeyValue::One(s.as_str()))
                    }
                    Some(Value::Array(arr)) => {
                        let owned: Vec<String> = arr
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        has_api_key(ApiKeyValue::Many(&owned))
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Read provider credentials. Returns None when the provider is absent.
    pub fn get(&self, provider_id: &str) -> Option<ProviderEntry<'_>> {
        let obj = self.providers_obj()?.get(provider_id)?.as_object()?;
        Some(ProviderEntry { obj })
    }

    /// Replace (or insert) the API key list for a provider.
    ///
    /// Collapse rule (per spec 04): exactly 1 key persists as a bare string;
    /// 2+ keys persist as an array. Empty `keys` removes the provider.
    pub fn set_api_keys(&mut self, provider_id: &str, keys: Vec<String>) {
        if keys.is_empty() {
            self.remove(provider_id);
            return;
        }

        let providers = self.ensure_providers_obj_mut();

        // Look up existing entry to preserve baseUrl/timeout/options ordering.
        let existing = providers
            .get(provider_id)
            .and_then(Value::as_object)
            .cloned();

        let mut entry = existing.unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("apiKey".into(), Value::Null);
            m
        });

        let api_value = if keys.len() == 1 {
            Value::String(keys.into_iter().next().expect("len==1"))
        } else {
            Value::Array(keys.into_iter().map(Value::String).collect())
        };

        // Insert preserves existing key position (Map<String,Value> is
        // serde_json's preserve-order map); shift_insert + remove keeps
        // apiKey at the head when this is a fresh entry.
        if entry.contains_key("apiKey") {
            entry.insert("apiKey".into(), api_value);
        } else {
            // Fresh entry: apiKey must come first.
            let mut fresh = Map::new();
            fresh.insert("apiKey".into(), api_value);
            for (k, v) in entry {
                fresh.insert(k, v);
            }
            entry = fresh;
        }

        providers.insert(provider_id.to_owned(), Value::Object(entry));
    }

    /// Set or clear `baseUrl` for a provider. The provider must exist (set
    /// API keys first).
    #[cfg(test)]
    pub fn set_base_url(&mut self, provider_id: &str, base_url: Option<String>) -> Result<()> {
        let entry = self
            .ensure_providers_obj_mut()
            .get_mut(provider_id)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("provider {provider_id} not found; set api keys first"))?;
        match base_url {
            Some(u) => {
                entry.insert("baseUrl".into(), Value::String(u));
            }
            None => {
                entry.shift_remove("baseUrl");
            }
        }
        Ok(())
    }

    /// Remove a provider entirely.
    pub fn remove(&mut self, provider_id: &str) {
        if let Some(providers) = self.providers_obj_mut() {
            providers.shift_remove(provider_id);
        }
    }

    // ---- internal helpers ------------------------------------------------

    fn providers_obj(&self) -> Option<&Map<String, Value>> {
        self.raw.get(TOP_KEY).and_then(Value::as_object)
    }

    fn providers_obj_mut(&mut self) -> Option<&mut Map<String, Value>> {
        self.raw.get_mut(TOP_KEY).and_then(Value::as_object_mut)
    }

    fn ensure_providers_obj_mut(&mut self) -> &mut Map<String, Value> {
        if !self.raw.contains_key(TOP_KEY) {
            self.raw.insert(TOP_KEY.into(), json!({}));
        }
        self.raw
            .get_mut(TOP_KEY)
            .and_then(Value::as_object_mut)
            .expect("providers key just inserted as object")
    }
}

/// Borrowed view of one provider's credentials object. Lifetime tied to the
/// owning [`ProvidersDoc`].
pub struct ProviderEntry<'a> {
    obj: &'a Map<String, Value>,
}

impl ProviderEntry<'_> {
    /// Always-normalised list of keys. A bare-string `apiKey` is returned as
    /// a single-element vec; an array is returned in order; any other shape
    /// (or missing) returns empty.
    pub fn api_keys(&self) -> Vec<String> {
        match self.obj.get("apiKey") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Raw `apiKey` field from disk, before any normalisation. Lets
    /// callers distinguish a bare-string `"none"` from an array
    /// containing `"none"` — the TS source treats them differently in
    /// the `configured_provider_ids` filter (only the bare string
    /// counts as the keyless-but-configured sentinel).
    pub fn raw_api_key_value(&self) -> Option<&Value> {
        self.obj.get("apiKey")
    }

    #[cfg(test)]
    fn base_url(&self) -> Option<&str> {
        self.obj.get("baseUrl").and_then(Value::as_str)
    }

    #[cfg(test)]
    fn timeout(&self) -> Option<u64> {
        self.obj.get("timeout").and_then(Value::as_u64)
    }

    /// Raw access for fields the typed view doesn't expose.
    pub fn raw(&self) -> &Map<String, Value> {
        self.obj
    }
}

fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize providers.json")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> ProvidersDoc {
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        ProvidersDoc { raw }
    }

    #[test]
    fn reads_single_string_apikey() {
        let doc = parse(br#"{"providers":{"openrouter":{"apiKey":"sk-or-1"}}}"#);
        let entry = doc.get("openrouter").unwrap();
        assert_eq!(entry.api_keys(), vec!["sk-or-1"]);
    }

    #[test]
    fn reads_array_apikey() {
        let doc = parse(br#"{"providers":{"anthropic":{"apiKey":["k1","k2","k3"]}}}"#);
        let entry = doc.get("anthropic").unwrap();
        assert_eq!(entry.api_keys(), vec!["k1", "k2", "k3"]);
    }

    #[test]
    fn reads_baseurl_timeout_options() {
        let doc = parse(
            br#"{"providers":{"ollama":{"apiKey":"local","baseUrl":"http://localhost:11434","timeout":30000}}}"#,
        );
        let entry = doc.get("ollama").unwrap();
        assert_eq!(entry.base_url(), Some("http://localhost:11434"));
        assert_eq!(entry.timeout(), Some(30000));
    }

    #[test]
    fn provider_ids_preserve_disk_order() {
        let doc = parse(
            br#"{"providers":{"openrouter":{"apiKey":"a"},"ollama":{"apiKey":"b"},"anthropic":{"apiKey":"c"}}}"#,
        );
        assert_eq!(
            doc.provider_ids(),
            vec!["openrouter", "ollama", "anthropic"]
        );
    }

    #[test]
    fn set_one_key_writes_bare_string() {
        let mut doc = ProvidersDoc::new();
        doc.set_api_keys("openrouter", vec!["sk-1".into()]);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(s.contains(r#""apiKey": "sk-1""#), "got: {s}");
    }

    #[test]
    fn set_two_keys_writes_array() {
        let mut doc = ProvidersDoc::new();
        doc.set_api_keys("anthropic", vec!["k1".into(), "k2".into()]);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(s.contains(r#""apiKey": ["#), "got: {s}");
        assert!(s.contains("\"k1\""));
        assert!(s.contains("\"k2\""));
    }

    #[test]
    fn collapsing_array_to_one_key_writes_bare_string() {
        let mut doc = parse(br#"{"providers":{"x":{"apiKey":["k1","k2"]}}}"#);
        doc.set_api_keys("x", vec!["k1".into()]);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(s.contains(r#""apiKey": "k1""#), "got: {s}");
        assert!(!s.contains("["));
    }

    #[test]
    fn empty_keys_removes_provider() {
        let mut doc = parse(br#"{"providers":{"x":{"apiKey":"k"},"y":{"apiKey":"k2"}}}"#);
        doc.set_api_keys("x", vec![]);
        assert_eq!(doc.provider_ids(), vec!["y"]);
    }

    #[test]
    fn set_base_url_preserves_position_when_existing() {
        let mut doc =
            parse(br#"{"providers":{"o":{"apiKey":"k","baseUrl":"http://a","timeout":1}}}"#);
        doc.set_base_url("o", Some("http://b".into())).unwrap();
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        let api_pos = s.find("apiKey").unwrap();
        let url_pos = s.find("baseUrl").unwrap();
        let t_pos = s.find("timeout").unwrap();
        assert!(api_pos < url_pos && url_pos < t_pos);
        assert!(s.contains("http://b"));
    }

    #[test]
    fn set_keys_preserves_other_fields_and_their_order() {
        let mut doc = parse(
            br#"{"providers":{"o":{"apiKey":"old","baseUrl":"http://a","timeout":99,"options":{"x":1,"y":2}}}}"#,
        );
        doc.set_api_keys("o", vec!["new1".into(), "new2".into()]);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        // Order: apiKey, baseUrl, timeout, options
        let positions = ["apiKey", "baseUrl", "timeout", "options"]
            .map(|k| s.find(k).unwrap_or_else(|| panic!("missing {k}")));
        assert!(positions[0] < positions[1]);
        assert!(positions[1] < positions[2]);
        assert!(positions[2] < positions[3]);
        // options inner order preserved.
        let x_pos = s.find("\"x\"").unwrap();
        let y_pos = s.find("\"y\"").unwrap();
        assert!(x_pos < y_pos);
    }

    #[test]
    fn missing_providers_key_is_empty() {
        let doc = parse(b"{}");
        assert!(doc.provider_ids().is_empty());
        assert!(doc.get("anything").is_none());
    }

    #[test]
    fn round_trip_preserves_unknown_top_level_fields() {
        let input = br#"{
  "providers": {
    "x": {
      "apiKey": "k"
    }
  },
  "futureField": {
    "nested": [1, 2]
  }
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let bytes = serialize(&raw).unwrap();
        let raw2: IndexMap<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let bytes2 = serialize(&raw2).unwrap();
        assert_eq!(bytes, bytes2);
        assert!(String::from_utf8_lossy(&bytes).contains("futureField"));
    }

    #[test]
    fn roundtrip_real_user_providers_byte_identical() {
        // Brutal verification against the real ~/.tenex/providers.json.
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => return,
        };
        let path = std::path::PathBuf::from(home).join(".tenex/providers.json");
        let Ok(original) = std::fs::read(&path) else {
            return;
        };

        let raw: IndexMap<String, Value> = serde_json::from_slice(&original)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));
        let serialized = serialize(&raw).unwrap();

        if original != serialized {
            let orig_s = String::from_utf8_lossy(&original);
            let new_s = String::from_utf8_lossy(&serialized);
            for (i, (o, n)) in orig_s.lines().zip(new_s.lines()).enumerate() {
                if o != n {
                    panic!(
                        "byte-diff at line {i}:\n  orig: {o:?}\n  ours: {n:?}\n  (orig {} bytes, ours {} bytes)",
                        original.len(),
                        serialized.len(),
                    );
                }
            }
            panic!(
                "byte-diff past common-prefix: orig={} bytes ours={} bytes",
                original.len(),
                serialized.len()
            );
        }
    }

    // ── configured_provider_ids ────────────────────────────────────────

    fn build_doc(json: &str) -> ProvidersDoc {
        parse(json.as_bytes())
    }

    #[test]
    fn configured_includes_provider_with_real_bare_string_key() {
        let doc = build_doc(r#"{"providers":{"anthropic":{"apiKey":"sk-real"}}}"#);
        assert_eq!(doc.configured_provider_ids(), vec!["anthropic"]);
    }

    #[test]
    fn configured_includes_provider_with_real_array_key() {
        let doc = build_doc(r#"{"providers":{"openai":{"apiKey":["sk-a","sk-b"]}}}"#);
        assert_eq!(doc.configured_provider_ids(), vec!["openai"]);
    }

    #[test]
    fn configured_includes_provider_with_none_sentinel() {
        // `claude-code` doesn't take a real key — TS uses the literal
        // string "none" as a configured-but-keyless marker.
        let doc = build_doc(r#"{"providers":{"claude-code":{"apiKey":"none"}}}"#);
        assert_eq!(doc.configured_provider_ids(), vec!["claude-code"]);
    }

    #[test]
    fn configured_excludes_provider_with_empty_string_key() {
        let doc = build_doc(r#"{"providers":{"openai":{"apiKey":""}}}"#);
        assert!(doc.configured_provider_ids().is_empty());
    }

    #[test]
    fn configured_excludes_provider_with_empty_array_key() {
        let doc = build_doc(r#"{"providers":{"openai":{"apiKey":[]}}}"#);
        assert!(doc.configured_provider_ids().is_empty());
    }

    #[test]
    fn configured_excludes_provider_with_only_none_inside_array() {
        // TS strict-equals `key === "none"` only matches the bare
        // string. `["none"]` is an array — has_api_key drops "none"
        // from the entries, so the array contributes zero usable keys
        // and the provider is excluded.
        let doc = build_doc(r#"{"providers":{"x":{"apiKey":["none"]}}}"#);
        assert!(doc.configured_provider_ids().is_empty());
    }

    #[test]
    fn configured_includes_provider_with_mixed_array_having_one_real_key() {
        let doc = build_doc(r#"{"providers":{"x":{"apiKey":["","none","sk-real"]}}}"#);
        assert_eq!(doc.configured_provider_ids(), vec!["x"]);
    }

    #[test]
    fn configured_preserves_disk_order() {
        let doc = build_doc(
            r#"{"providers":{"third":{"apiKey":"k3"},"first":{"apiKey":"k1"},"second":{"apiKey":"k2"}}}"#,
        );
        // IndexMap preserves insertion order — the filter must keep it.
        assert_eq!(
            doc.configured_provider_ids(),
            vec!["third", "first", "second"],
        );
    }

    #[test]
    fn configured_filters_out_unconfigured_amongst_mixed_set() {
        let doc = build_doc(
            r#"{"providers":{"a":{"apiKey":"sk-a"},"b":{"apiKey":""},"c":{"apiKey":"none"}}}"#,
        );
        // a (real key) and c (none sentinel) included, b excluded.
        assert_eq!(doc.configured_provider_ids(), vec!["a", "c"]);
    }
}

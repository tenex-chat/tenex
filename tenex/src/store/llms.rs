//! `~/.tenex/llms.json` reader/writer.
//!
//! Schema source: `TenexLLMsSchema` at `src/services/config/types.ts:396-404`.
//!
//! Configurations are a discriminated union:
//!
//! - **Standard** ([`LLMConfigKind::Standard`]) — a real provider+model entry.
//!   Schema: `StandardLLMConfigurationSchema` (`:368-386`), with `.passthrough()`
//!   allowing arbitrary provider-specific extras (e.g. `effort`, `summary`).
//! - **Meta-model** ([`LLMConfigKind::Meta`]) — `{provider: "meta", variants:
//!   {...}, default: "..."}`. Schema: `MetaModelConfigurationSchema` (`:359-363`).
//!
//! Discriminator (matches `isMetaModelConfiguration` at `:324-326`):
//! `provider == "meta" && contains "variants"`.
//!
//! Top-level keys (TS field order): `configurations, default, summarization,
//! supervision, promptCompilation, categorization, contextDiscovery`.
//!
//! Storage uses `IndexMap`-backed `serde_json::Value` (`preserve_order` is
//! enabled in `Cargo.toml`) so untouched fields, configuration ordering, and
//! per-config field ordering all round-trip byte-identically.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::atomic;

const FILE_NAME: &str = "llms.json";
const CONFIGURATIONS: &str = "configurations";

const ROLE_KEYS: &[&str] = &[
    "default",
    "summarization",
    "supervision",
    "promptCompilation",
    "categorization",
    "contextDiscovery",
];

#[derive(Debug, Clone, Default)]
pub struct LlmsDoc {
    raw: IndexMap<String, Value>,
}

impl LlmsDoc {
    pub fn new() -> Self {
        Self::default()
    }

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

    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    pub fn raw_mut(&mut self) -> &mut IndexMap<String, Value> {
        &mut self.raw
    }

    // ---- role accessors -------------------------------------------------

    /// Configuration name used as the default. Distinct from any meta-model
    /// variant's own `default` (which is internal to the variant map).
    pub fn default_config(&self) -> Option<&str> {
        self.role("default")
    }

    pub fn set_default_config(&mut self, name: Option<String>) {
        self.set_role("default", name);
    }

    pub fn summarization(&self) -> Option<&str> {
        self.role("summarization")
    }

    pub fn set_summarization(&mut self, name: Option<String>) {
        self.set_role("summarization", name);
    }

    pub fn supervision(&self) -> Option<&str> {
        self.role("supervision")
    }

    pub fn set_supervision(&mut self, name: Option<String>) {
        self.set_role("supervision", name);
    }

    pub fn prompt_compilation(&self) -> Option<&str> {
        self.role("promptCompilation")
    }

    pub fn set_prompt_compilation(&mut self, name: Option<String>) {
        self.set_role("promptCompilation", name);
    }

    pub fn categorization(&self) -> Option<&str> {
        self.role("categorization")
    }

    pub fn set_categorization(&mut self, name: Option<String>) {
        self.set_role("categorization", name);
    }

    pub fn context_discovery(&self) -> Option<&str> {
        self.role("contextDiscovery")
    }

    pub fn set_context_discovery(&mut self, name: Option<String>) {
        self.set_role("contextDiscovery", name);
    }

    fn role(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str)
    }

    fn set_role(&mut self, key: &str, value: Option<String>) {
        match value {
            Some(s) => {
                self.raw.insert(key.to_owned(), Value::String(s));
            }
            None => {
                self.raw.shift_remove(key);
            }
        }
    }

    // ---- configurations map --------------------------------------------

    /// Configuration names in disk order.
    pub fn config_names(&self) -> Vec<String> {
        self.configurations_obj()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Borrowed view of one configuration. The view exposes the
    /// standard-vs-meta-model discriminator and typed accessors per kind.
    pub fn get(&self, name: &str) -> Option<LlmConfigEntry<'_>> {
        let obj = self.configurations_obj()?.get(name)?.as_object()?;
        Some(LlmConfigEntry { obj })
    }

    /// Insert or replace a standard (provider+model) configuration. Existing
    /// extras (e.g. `effort` on a Codex config the user manually set) are
    /// preserved when their key is not explicitly cleared by [`StandardConfig`].
    pub fn set_standard_config(&mut self, name: &str, config: StandardConfig) {
        let configs = self.ensure_configurations_obj_mut();
        let existing = configs.get(name).and_then(Value::as_object).cloned();

        let mut entry = existing.unwrap_or_default();
        entry.insert("provider".into(), Value::String(config.provider));
        entry.insert("model".into(), Value::String(config.model));

        // Apply explicit overrides; None entries clear the slot.
        for (key, value) in config.overrides {
            match value {
                Some(v) => {
                    entry.insert(key, v);
                }
                None => {
                    entry.shift_remove(&key);
                }
            }
        }

        // Reorder so provider/model come first; then preserve any other keys
        // in their existing order.
        let mut out = Map::new();
        out.insert(
            "provider".into(),
            entry.shift_remove("provider").unwrap_or(Value::Null),
        );
        out.insert(
            "model".into(),
            entry.shift_remove("model").unwrap_or(Value::Null),
        );
        for (k, v) in entry {
            out.insert(k, v);
        }

        configs.insert(name.to_owned(), Value::Object(out));
    }

    /// Insert or replace a meta-model configuration.
    pub fn set_meta_config(&mut self, name: &str, config: MetaConfig) {
        let configs = self.ensure_configurations_obj_mut();
        let mut out = Map::new();
        out.insert("provider".into(), Value::String("meta".into()));

        let mut variants = Map::new();
        for variant in config.variants {
            let mut v_obj = Map::new();
            v_obj.insert("model".into(), Value::String(variant.model));
            if let Some(kw) = variant.keywords {
                v_obj.insert(
                    "keywords".into(),
                    Value::Array(kw.into_iter().map(Value::String).collect()),
                );
            }
            if let Some(d) = variant.description {
                v_obj.insert("description".into(), Value::String(d));
            }
            if let Some(sp) = variant.system_prompt {
                v_obj.insert("systemPrompt".into(), Value::String(sp));
            }
            variants.insert(variant.name, Value::Object(v_obj));
        }
        out.insert("variants".into(), Value::Object(variants));
        out.insert("default".into(), Value::String(config.default));

        configs.insert(name.to_owned(), Value::Object(out));
    }

    pub fn remove_config(&mut self, name: &str) {
        if let Some(configs) = self.configurations_obj_mut() {
            configs.shift_remove(name);
        }

        // If a role pointed at this config, clear it (matches TS
        // `LLMConfigEditor.deleteConfiguration`).
        for &role in ROLE_KEYS {
            if self.role(role) == Some(name) {
                self.raw.shift_remove(role);
            }
        }
    }

    // ---- internals -----------------------------------------------------

    fn configurations_obj(&self) -> Option<&Map<String, Value>> {
        self.raw.get(CONFIGURATIONS).and_then(Value::as_object)
    }

    fn configurations_obj_mut(&mut self) -> Option<&mut Map<String, Value>> {
        self.raw
            .get_mut(CONFIGURATIONS)
            .and_then(Value::as_object_mut)
    }

    fn ensure_configurations_obj_mut(&mut self) -> &mut Map<String, Value> {
        if !self.raw.contains_key(CONFIGURATIONS) {
            // configurations is the schema-defined first key; insert at index 0.
            self.raw
                .shift_insert(0, CONFIGURATIONS.into(), json!({}));
        }
        self.raw
            .get_mut(CONFIGURATIONS)
            .and_then(Value::as_object_mut)
            .expect("configurations key just inserted as object")
    }
}

/// Discriminator for a configuration entry.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum LlmConfigKind {
    Standard,
    Meta,
}

/// Borrowed view of one configuration. Use [`Self::kind`] to discriminate
/// before reaching for `provider()`/`model()` (standard) or
/// [`Self::variant_names`]/[`Self::variant`] (meta).
pub struct LlmConfigEntry<'a> {
    obj: &'a Map<String, Value>,
}

impl<'a> LlmConfigEntry<'a> {
    pub fn kind(&self) -> LlmConfigKind {
        let provider = self.obj.get("provider").and_then(Value::as_str);
        if provider == Some("meta") && self.obj.contains_key("variants") {
            LlmConfigKind::Meta
        } else {
            LlmConfigKind::Standard
        }
    }

    pub fn provider(&self) -> Option<&str> {
        self.obj.get("provider").and_then(Value::as_str)
    }

    /// `model` for standard configs; meta configs return None (use
    /// [`Self::variant`] for meta).
    pub fn model(&self) -> Option<&str> {
        if self.kind() == LlmConfigKind::Meta {
            return None;
        }
        self.obj.get("model").and_then(Value::as_str)
    }

    /// Generic field access for the `.passthrough()` standard-config extras.
    pub fn field(&self, key: &str) -> Option<&'a Value> {
        self.obj.get(key)
    }

    pub fn raw(&self) -> &'a Map<String, Value> {
        self.obj
    }

    // ---- meta-model accessors ---------------------------------------

    /// For meta configs: variant names in disk order. Empty for standard.
    pub fn variant_names(&self) -> Vec<String> {
        if self.kind() != LlmConfigKind::Meta {
            return Vec::new();
        }
        self.obj
            .get("variants")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// For meta configs: borrowed view of one variant.
    pub fn variant(&self, name: &str) -> Option<MetaVariantEntry<'a>> {
        if self.kind() != LlmConfigKind::Meta {
            return None;
        }
        let v = self
            .obj
            .get("variants")
            .and_then(Value::as_object)?
            .get(name)?
            .as_object()?;
        Some(MetaVariantEntry { obj: v })
    }

    /// For meta configs: the `default` variant name (required by schema).
    pub fn meta_default_variant(&self) -> Option<&str> {
        if self.kind() != LlmConfigKind::Meta {
            return None;
        }
        self.obj.get("default").and_then(Value::as_str)
    }
}

/// Borrowed view of one meta-model variant.
pub struct MetaVariantEntry<'a> {
    obj: &'a Map<String, Value>,
}

impl<'a> MetaVariantEntry<'a> {
    pub fn model(&self) -> Option<&'a str> {
        self.obj.get("model").and_then(Value::as_str)
    }

    pub fn keywords(&self) -> Vec<String> {
        self.obj
            .get("keywords")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    }

    pub fn description(&self) -> Option<&'a str> {
        self.obj.get("description").and_then(Value::as_str)
    }

    pub fn system_prompt(&self) -> Option<&'a str> {
        self.obj.get("systemPrompt").and_then(Value::as_str)
    }
}

/// Owned construction shape for [`LlmsDoc::set_standard_config`].
///
/// `provider` and `model` are required (matches `StandardLLMConfigurationSchema`
/// at `:368-371`). `overrides` is `Vec<(key, Option<Value>)>` to preserve
/// caller-supplied insertion order while distinguishing "set this key" (Some)
/// from "clear this key" (None).
#[derive(Debug, Clone)]
pub struct StandardConfig {
    pub provider: String,
    pub model: String,
    pub overrides: Vec<(String, Option<Value>)>,
}

impl StandardConfig {
    pub fn new<P: Into<String>, M: Into<String>>(provider: P, model: M) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            overrides: Vec::new(),
        }
    }

    pub fn with<K: Into<String>>(mut self, key: K, value: Value) -> Self {
        self.overrides.push((key.into(), Some(value)));
        self
    }

    pub fn clearing<K: Into<String>>(mut self, key: K) -> Self {
        self.overrides.push((key.into(), None));
        self
    }
}

/// Owned construction shape for [`LlmsDoc::set_meta_config`].
#[derive(Debug, Clone)]
pub struct MetaConfig {
    pub variants: Vec<MetaVariant>,
    pub default: String,
}

#[derive(Debug, Clone)]
pub struct MetaVariant {
    pub name: String,
    pub model: String,
    pub keywords: Option<Vec<String>>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
}

fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize llms.json")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> LlmsDoc {
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        LlmsDoc { raw }
    }

    #[test]
    fn config_names_preserve_disk_order() {
        let doc = parse(
            br#"{"configurations":{"a":{"provider":"openrouter","model":"x"},"b":{"provider":"anthropic","model":"y"}}}"#,
        );
        assert_eq!(doc.config_names(), vec!["a", "b"]);
    }

    #[test]
    fn standard_config_kind_and_fields() {
        let doc = parse(
            br#"{"configurations":{"a":{"provider":"codex","model":"gpt-5.4","effort":"xhigh"}}}"#,
        );
        let entry = doc.get("a").unwrap();
        assert_eq!(entry.kind(), LlmConfigKind::Standard);
        assert_eq!(entry.provider(), Some("codex"));
        assert_eq!(entry.model(), Some("gpt-5.4"));
        assert_eq!(entry.field("effort").and_then(Value::as_str), Some("xhigh"));
    }

    #[test]
    fn meta_config_kind_and_variants() {
        let doc = parse(
            br#"{"configurations":{"Auto":{"provider":"meta","variants":{"v1":{"model":"m1","keywords":["fast"],"description":"d","systemPrompt":"sp"}},"default":"v1"}}}"#,
        );
        let entry = doc.get("Auto").unwrap();
        assert_eq!(entry.kind(), LlmConfigKind::Meta);
        assert_eq!(entry.provider(), Some("meta"));
        assert_eq!(entry.model(), None); // meta has no top-level model
        assert_eq!(entry.meta_default_variant(), Some("v1"));
        assert_eq!(entry.variant_names(), vec!["v1"]);

        let v = entry.variant("v1").unwrap();
        assert_eq!(v.model(), Some("m1"));
        assert_eq!(v.keywords(), vec!["fast"]);
        assert_eq!(v.description(), Some("d"));
        assert_eq!(v.system_prompt(), Some("sp"));
    }

    #[test]
    fn meta_discriminator_requires_both_provider_and_variants() {
        // provider:"meta" without variants → not meta, treat as standard
        let doc = parse(br#"{"configurations":{"x":{"provider":"meta","model":"m"}}}"#);
        assert_eq!(doc.get("x").unwrap().kind(), LlmConfigKind::Standard);
    }

    #[test]
    fn role_accessors_round_trip() {
        let doc = parse(
            br#"{"configurations":{},"default":"a","summarization":"b","supervision":"c","promptCompilation":"d","categorization":"e","contextDiscovery":"f"}"#,
        );
        assert_eq!(doc.default_config(), Some("a"));
        assert_eq!(doc.summarization(), Some("b"));
        assert_eq!(doc.supervision(), Some("c"));
        assert_eq!(doc.prompt_compilation(), Some("d"));
        assert_eq!(doc.categorization(), Some("e"));
        assert_eq!(doc.context_discovery(), Some("f"));
    }

    #[test]
    fn set_role_appends_when_absent_and_overwrites_when_present() {
        let mut doc = parse(br#"{"configurations":{}}"#);
        doc.set_default_config(Some("first".into()));
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(s.contains(r#""default": "first""#));

        doc.set_default_config(Some("second".into()));
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(s.contains(r#""default": "second""#));
        assert!(!s.contains("first"));
    }

    #[test]
    fn set_role_to_none_removes_the_key() {
        let mut doc = parse(br#"{"configurations":{},"default":"x"}"#);
        doc.set_default_config(None);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(!s.contains("\"default\""));
    }

    #[test]
    fn standard_config_writes_provider_and_model_first() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config(
            "a",
            StandardConfig::new("anthropic", "claude-haiku-4-5"),
        );
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        let p_pos = s.find("\"provider\"").unwrap();
        let m_pos = s.find("\"model\"").unwrap();
        assert!(p_pos < m_pos);
    }

    #[test]
    fn standard_config_with_extras_preserves_them() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config(
            "a",
            StandardConfig::new("codex", "gpt-5.4")
                .with("effort", json!("xhigh"))
                .with("personality", json!("pragmatic")),
        );
        let entry = doc.get("a").unwrap();
        assert_eq!(entry.field("effort").and_then(Value::as_str), Some("xhigh"));
        assert_eq!(
            entry.field("personality").and_then(Value::as_str),
            Some("pragmatic")
        );
    }

    #[test]
    fn standard_config_clearing_removes_existing_field() {
        let mut doc = parse(br#"{"configurations":{"a":{"provider":"codex","model":"gpt-5.4","effort":"xhigh"}}}"#);
        doc.set_standard_config(
            "a",
            StandardConfig::new("codex", "gpt-5.4").clearing("effort"),
        );
        let entry = doc.get("a").unwrap();
        assert_eq!(entry.field("effort"), None);
    }

    #[test]
    fn set_meta_config_writes_canonical_shape() {
        let mut doc = LlmsDoc::new();
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![
                    MetaVariant {
                        name: "fast".into(),
                        model: "m-fast".into(),
                        keywords: Some(vec!["quick".into()]),
                        description: Some("the fast one".into()),
                        system_prompt: None,
                    },
                    MetaVariant {
                        name: "deep".into(),
                        model: "m-deep".into(),
                        keywords: None,
                        description: None,
                        system_prompt: Some("Think hard".into()),
                    },
                ],
                default: "fast".into(),
            },
        );
        let entry = doc.get("Auto").unwrap();
        assert_eq!(entry.kind(), LlmConfigKind::Meta);
        assert_eq!(entry.meta_default_variant(), Some("fast"));
        assert_eq!(entry.variant_names(), vec!["fast", "deep"]);
        let fast = entry.variant("fast").unwrap();
        assert_eq!(fast.keywords(), vec!["quick"]);
        assert_eq!(fast.description(), Some("the fast one"));
        assert_eq!(fast.system_prompt(), None);
        let deep = entry.variant("deep").unwrap();
        assert_eq!(deep.keywords().len(), 0);
        assert_eq!(deep.system_prompt(), Some("Think hard"));
    }

    #[test]
    fn remove_config_clears_role_pointers() {
        let mut doc = parse(
            br#"{"configurations":{"a":{"provider":"x","model":"y"},"b":{"provider":"x","model":"z"}},"default":"a","summarization":"a","categorization":"b"}"#,
        );
        doc.remove_config("a");
        assert_eq!(doc.config_names(), vec!["b"]);
        assert_eq!(doc.default_config(), None);
        assert_eq!(doc.summarization(), None);
        assert_eq!(doc.categorization(), Some("b"));
    }

    #[test]
    fn round_trip_preserves_unknown_top_level_fields() {
        let input = br#"{
  "configurations": {
    "x": {
      "provider": "a",
      "model": "b"
    }
  },
  "default": "x",
  "futureRole": "x"
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let bytes = serialize(&raw).unwrap();
        assert_eq!(bytes.as_slice(), input.as_slice());
    }

    #[test]
    fn save_and_reload_roundtrips() {
        let tmp = std::env::temp_dir().join(format!("tenex-llms-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("a", StandardConfig::new("anthropic", "claude-x"));
        doc.set_default_config(Some("a".into()));
        doc.save(&tmp).unwrap();
        let reloaded = LlmsDoc::load(&tmp).unwrap();
        assert_eq!(reloaded.config_names(), vec!["a"]);
        assert_eq!(reloaded.default_config(), Some("a"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn roundtrip_real_user_llms_byte_identical() {
        // Brutal verification against the real ~/.tenex/llms.json (skipped on
        // CI / fresh installs where the file is absent).
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => return,
        };
        let path = std::path::PathBuf::from(home).join(".tenex/llms.json");
        let Ok(original) = std::fs::read(&path) else { return };

        let raw: IndexMap<String, Value> = serde_json::from_slice(&original)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));
        let serialized = serialize(&raw).unwrap();

        // TS `JSON.stringify(_, null, 2)` emits no trailing whitespace. Some
        // editors append a final newline on save; that's not a writer bug, so
        // we compare against `original` with trailing ASCII whitespace stripped.
        let trimmed_original: &[u8] = {
            let mut end = original.len();
            while end > 0 && matches!(original[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
                end -= 1;
            }
            &original[..end]
        };

        if trimmed_original != serialized {
            let orig_s = String::from_utf8_lossy(trimmed_original);
            let new_s = String::from_utf8_lossy(&serialized);
            for (i, (o, n)) in orig_s.lines().zip(new_s.lines()).enumerate() {
                if o != n {
                    panic!(
                        "byte-diff at line {i}:\n  orig: {o:?}\n  ours: {n:?}\n  (trimmed orig {} bytes, ours {} bytes)",
                        trimmed_original.len(),
                        serialized.len(),
                    );
                }
            }
            panic!(
                "byte-diff past common prefix: trimmed orig={} ours={}",
                trimmed_original.len(),
                serialized.len()
            );
        }
    }
}

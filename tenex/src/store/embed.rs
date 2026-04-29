//! `~/.tenex/embed.json` reader/writer.
//!
//! Schema source: `EmbeddingProviderFactory.ts:84-88` (`EMBED_CONFIG_FILE`,
//! `DEFAULT_CONFIG`) + `:283-296` (save shape).
//!
//! Persisted shape (verbatim — order matters for round-trip):
//!
//! ```json
//! {
//!   "provider": "openai",
//!   "model": "text-embedding-3-small",
//!   "baseUrl": "https://custom.host"
//! }
//! ```
//!
//! `apiKey` is **never** persisted — credentials live in `providers.json`
//! (`:283-287` in the TS save path enforces this). `baseUrl` is only saved
//! when it differs from the provider's default base URL (`:289-293`).

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::Value;

use super::atomic;

const FILE_NAME: &str = "embed.json";

pub const DEFAULT_PROVIDER: &str = "local";
pub const DEFAULT_MODEL: &str = "Xenova/all-MiniLM-L6-v2";

/// On-disk representation of `embed.json`. Lossless round-trip.
#[derive(Debug, Clone, Default)]
pub struct EmbedDoc {
    raw: IndexMap<String, Value>,
}

impl EmbedDoc {
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

    /// Provider name. `None` when no `embed.json` exists; the runtime
    /// resolves to [`DEFAULT_PROVIDER`].
    pub fn provider(&self) -> Option<&str> {
        self.raw.get("provider").and_then(Value::as_str)
    }

    pub fn set_provider(&mut self, provider: &str) {
        self.raw
            .insert("provider".into(), Value::String(provider.to_owned()));
    }

    /// Model identifier. `None` when no `embed.json` exists; the runtime
    /// resolves to [`DEFAULT_MODEL`].
    pub fn model(&self) -> Option<&str> {
        self.raw.get("model").and_then(Value::as_str)
    }

    pub fn set_model(&mut self, model: &str) {
        self.raw
            .insert("model".into(), Value::String(model.to_owned()));
    }

    pub fn base_url(&self) -> Option<&str> {
        self.raw.get("baseUrl").and_then(Value::as_str)
    }

    pub fn set_base_url(&mut self, base_url: Option<&str>) {
        match base_url {
            Some(u) if !u.is_empty() => {
                self.raw.insert("baseUrl".into(), Value::String(u.to_owned()));
            }
            _ => {
                self.raw.shift_remove("baseUrl");
            }
        }
    }

    /// Provider with default fallback (matches `EmbeddingProviderFactory`'s
    /// runtime default at `:85-88`).
    pub fn provider_or_default(&self) -> &str {
        self.provider().unwrap_or(DEFAULT_PROVIDER)
    }

    pub fn model_or_default(&self) -> &str {
        self.model().unwrap_or(DEFAULT_MODEL)
    }
}

fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize embed.json")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> EmbedDoc {
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        EmbedDoc { raw }
    }

    #[test]
    fn empty_doc_returns_default_provider_and_model() {
        let doc = EmbedDoc::new();
        assert_eq!(doc.provider_or_default(), "local");
        assert_eq!(doc.model_or_default(), "Xenova/all-MiniLM-L6-v2");
        assert!(doc.provider().is_none());
        assert!(doc.model().is_none());
    }

    #[test]
    fn reads_provider_model_baseurl() {
        let doc = parse(
            br#"{"provider":"openai","model":"text-embedding-3-small","baseUrl":"https://custom"}"#,
        );
        assert_eq!(doc.provider(), Some("openai"));
        assert_eq!(doc.model(), Some("text-embedding-3-small"));
        assert_eq!(doc.base_url(), Some("https://custom"));
    }

    #[test]
    fn set_provider_and_model_roundtrip() {
        let mut doc = EmbedDoc::new();
        doc.set_provider("openrouter");
        doc.set_model("openai/text-embedding-3-large");
        assert_eq!(doc.provider(), Some("openrouter"));
        assert_eq!(doc.model(), Some("openai/text-embedding-3-large"));
    }

    #[test]
    fn set_base_url_some_writes_field() {
        let mut doc = EmbedDoc::new();
        doc.set_provider("openai");
        doc.set_model("x");
        doc.set_base_url(Some("https://api.example"));
        let s = String::from_utf8(serialize(&doc.raw).unwrap()).unwrap();
        assert!(s.contains("\"baseUrl\""));
        assert!(s.contains("https://api.example"));
    }

    #[test]
    fn set_base_url_none_removes_field() {
        let mut doc = parse(br#"{"provider":"openai","model":"x","baseUrl":"https://a"}"#);
        doc.set_base_url(None);
        assert!(doc.base_url().is_none());
        let s = String::from_utf8(serialize(&doc.raw).unwrap()).unwrap();
        assert!(!s.contains("baseUrl"));
    }

    #[test]
    fn set_base_url_empty_string_removes_field() {
        let mut doc = parse(br#"{"provider":"openai","model":"x","baseUrl":"https://a"}"#);
        doc.set_base_url(Some(""));
        assert!(doc.base_url().is_none());
    }

    #[test]
    fn round_trip_preserves_field_order() {
        let input = br#"{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "baseUrl": "https://custom.host"
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let bytes = serialize(&raw).unwrap();
        assert_eq!(bytes.as_slice(), input.as_slice());
    }

    #[test]
    fn save_and_reload_roundtrips() {
        let tmp = std::env::temp_dir().join(format!(
            "tenex-embed-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut doc = EmbedDoc::new();
        doc.set_provider("openai");
        doc.set_model("text-embedding-3-small");
        doc.save(&tmp).unwrap();
        let reloaded = EmbedDoc::load(&tmp).unwrap();
        assert_eq!(reloaded.provider(), Some("openai"));
        assert_eq!(reloaded.model(), Some("text-embedding-3-small"));
        assert!(reloaded.base_url().is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }
}

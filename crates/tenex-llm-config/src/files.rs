use std::path::Path;

use anyhow::{Context, Result};
use indexmap::IndexMap;
use serde_json::{Map, Value};

#[derive(Debug, Default)]
pub struct LlmDocs {
    /// Named configurations from `llms.json`. Value is the raw JSON object.
    pub configurations: IndexMap<String, Value>,
    /// Role-to-config-name mappings (default, summarization, supervision, ...).
    pub roles: IndexMap<String, String>,
}

#[derive(Debug, Default)]
pub struct ProviderDocs {
    pub providers: IndexMap<String, ProviderEntry>,
}

/// A single API key parsed from the on-disk string.
///
/// Any key string may carry a trailing alias after the first space:
/// `"sk-or-v1-... alice@example.com"` or `"sk-or-v1-... work-key"`.
/// The alias is informational and is stripped before the key is handed to an
/// LLM provider SDK.
#[derive(Debug, Clone)]
pub struct ParsedKey {
    pub key: String,
    pub alias: Option<String>,
}

impl ParsedKey {
    fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        raw.find(' ').map_or_else(
            || Self {
                key: raw.to_string(),
                alias: None,
            },
            |idx| {
                let alias = raw[idx + 1..].trim();
                Self {
                    key: raw[..idx].to_string(),
                    alias: if alias.is_empty() {
                        None
                    } else {
                        Some(alias.to_string())
                    },
                }
            },
        )
    }
}

#[derive(Debug)]
pub struct ProviderEntry {
    pub api_keys: Vec<ParsedKey>,
    pub base_url: Option<String>,
    pub timeout: Option<u64>,
}

pub fn load_llms(base_dir: &Path) -> Result<LlmDocs> {
    let path = base_dir.join("llms.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LlmDocs::default()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let raw: IndexMap<String, Value> =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;

    let configurations: IndexMap<String, Value> = raw
        .get("configurations")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    const ROLE_KEYS: &[&str] = &[
        "default",
        "summarization",
        "supervision",
        "promptCompilation",
        "categorization",
        "contextDiscovery",
        "firewall",
    ];
    let mut roles = IndexMap::new();
    for &key in ROLE_KEYS {
        if let Some(Value::String(s)) = raw.get(key) {
            roles.insert(key.to_string(), s.clone());
        }
    }

    Ok(LlmDocs {
        configurations,
        roles,
    })
}

pub fn load_providers(base_dir: &Path) -> Result<ProviderDocs> {
    let path = base_dir.join("providers.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ProviderDocs::default()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let raw: Map<String, Value> =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;

    let mut providers = IndexMap::new();
    if let Some(Value::Object(pmap)) = raw.get("providers") {
        for (id, creds) in pmap {
            let Some(obj) = creds.as_object() else {
                continue;
            };
            let api_keys = match obj.get("apiKey") {
                Some(Value::String(s)) => vec![ParsedKey::parse(s)],
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ParsedKey::parse)
                    .collect(),
                _ => vec![],
            };
            let base_url = obj
                .get("baseUrl")
                .and_then(Value::as_str)
                .map(str::to_string);
            let timeout = obj.get("timeout").and_then(Value::as_u64);
            providers.insert(
                id.clone(),
                ProviderEntry {
                    api_keys,
                    base_url,
                    timeout,
                },
            );
        }
    }

    Ok(ProviderDocs { providers })
}

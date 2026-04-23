use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use secp256k1::SecretKey;
use serde::Deserialize;
use serde_json::{Map, Value};
use thiserror::Error;
use url::Url;

use crate::backend_signer::{BackendSignerError, HexBackendSigner};

pub const TENEX_CONFIG_FILE_NAME: &str = "config.json";
pub const DEFAULT_RELAY_URLS: &[&str] = &["wss://relay.tenex.chat"];
pub const DEFAULT_IDENTITY_RELAY_URLS: &[&str] = &["wss://purplepag.es"];
pub const DEFAULT_BACKEND_NAME: &str = "tenex backend";
pub const DEFAULT_INTERVENTION_TIMEOUT_SECONDS: u32 = 300;

#[derive(Debug, Error)]
pub enum BackendConfigError {
    #[error("backend config io error while reading {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("backend config json error while reading {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("backend config io error while writing {path}: {source}")]
    WriteIo { path: PathBuf, source: io::Error },
    #[error("backend config json error while writing {path}: {source}")]
    WriteJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("backend private key generation failed: {0}")]
    KeyGeneration(String),
    #[error("backend config tenexPrivateKey is missing")]
    MissingPrivateKey,
    #[error("backend signer error: {0}")]
    Signer(#[from] BackendSignerError),
}

pub type BackendConfigResult<T> = Result<T, BackendConfigError>;

#[derive(Clone, PartialEq, Eq)]
pub struct BackendConfigSnapshot {
    pub config_path: PathBuf,
    pub whitelisted_pubkeys: Vec<String>,
    pub whitelisted_identities: Vec<String>,
    pub tenex_private_key: Option<String>,
    pub backend_name: Option<String>,
    pub projects_base: Option<String>,
    pub relays: Vec<String>,
    pub identity_relays: Vec<String>,
    pub blossom_server_url: Option<String>,
    pub generated_tenex_private_key: bool,
    pub nip46: Nip46Config,
    pub intervention: InterventionConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterventionConfig {
    pub enabled: bool,
    pub agent_slug: Option<String>,
    pub timeout_seconds: u32,
}

impl Default for InterventionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            agent_slug: None,
            timeout_seconds: DEFAULT_INTERVENTION_TIMEOUT_SECONDS,
        }
    }
}

impl InterventionConfig {
    pub fn is_active(&self) -> bool {
        self.enabled && self.agent_slug.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nip46Config {
    pub signing_timeout_ms: u64,
    pub max_retries: u8,
    pub owners: HashMap<String, OwnerNip46Config>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerNip46Config {
    pub bunker_uri: Option<String>,
}

impl Default for Nip46Config {
    fn default() -> Self {
        Self {
            signing_timeout_ms: 30_000,
            max_retries: 2,
            owners: HashMap::new(),
        }
    }
}

impl fmt::Debug for BackendConfigSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendConfigSnapshot")
            .field("config_path", &self.config_path)
            .field("whitelisted_pubkeys", &self.whitelisted_pubkeys)
            .field("whitelisted_identities", &self.whitelisted_identities)
            .field(
                "tenex_private_key",
                &self.tenex_private_key.as_ref().map(|_| "<redacted>"),
            )
            .field("backend_name", &self.backend_name)
            .field("projects_base", &self.projects_base)
            .field("relays", &self.relays)
            .field("identity_relays", &self.identity_relays)
            .field("blossom_server_url", &self.blossom_server_url)
            .field(
                "generated_tenex_private_key",
                &self.generated_tenex_private_key,
            )
            .field("nip46", &self.nip46)
            .field("intervention", &self.intervention)
            .finish()
    }
}

impl BackendConfigSnapshot {
    pub fn backend_name_or_default(&self) -> &str {
        self.backend_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(DEFAULT_BACKEND_NAME)
    }

    pub fn backend_signer(&self) -> BackendConfigResult<HexBackendSigner> {
        let private_key = self
            .tenex_private_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .ok_or(BackendConfigError::MissingPrivateKey)?;

        Ok(HexBackendSigner::from_private_key_hex(private_key)?)
    }

    pub fn effective_relay_urls(&self) -> Vec<String> {
        valid_websocket_urls_or_default(&self.relays, DEFAULT_RELAY_URLS)
    }

    pub fn effective_identity_relay_urls(&self) -> Vec<String> {
        valid_websocket_urls_or_default(&self.identity_relays, DEFAULT_IDENTITY_RELAY_URLS)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTenexConfig {
    #[serde(default)]
    whitelisted_pubkeys: Vec<String>,
    #[serde(default)]
    whitelisted_identities: Vec<String>,
    #[serde(default)]
    tenex_private_key: Option<String>,
    #[serde(default)]
    backend_name: Option<String>,
    #[serde(default)]
    projects_base: Option<String>,
    #[serde(default)]
    relays: Vec<String>,
    #[serde(default)]
    identity_relays: Vec<String>,
    #[serde(default)]
    blossom_server_url: Option<String>,
    #[serde(default)]
    nip46: Option<RawNip46Config>,
    #[serde(default)]
    intervention: Option<RawInterventionConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInterventionConfig {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u32>,
}

impl RawInterventionConfig {
    fn into_config(self) -> InterventionConfig {
        let defaults = InterventionConfig::default();
        let agent_slug = self.agent.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        InterventionConfig {
            enabled: self.enabled.unwrap_or(defaults.enabled),
            agent_slug,
            timeout_seconds: self.timeout_seconds.unwrap_or(defaults.timeout_seconds),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNip46Config {
    #[serde(default)]
    signing_timeout_ms: Option<u64>,
    #[serde(default)]
    max_retries: Option<u8>,
    #[serde(default)]
    owners: HashMap<String, RawOwnerNip46Config>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOwnerNip46Config {
    #[serde(default)]
    bunker_uri: Option<String>,
}

impl RawNip46Config {
    fn into_config(self) -> Nip46Config {
        let defaults = Nip46Config::default();
        Nip46Config {
            signing_timeout_ms: self
                .signing_timeout_ms
                .unwrap_or(defaults.signing_timeout_ms),
            max_retries: self.max_retries.unwrap_or(defaults.max_retries),
            owners: self
                .owners
                .into_iter()
                .map(|(owner, entry)| {
                    (
                        owner,
                        OwnerNip46Config {
                            bunker_uri: entry.bunker_uri,
                        },
                    )
                })
                .collect(),
        }
    }
}

pub fn backend_config_path(base_dir: impl AsRef<Path>) -> PathBuf {
    base_dir.as_ref().join(TENEX_CONFIG_FILE_NAME)
}

pub fn read_backend_config(
    base_dir: impl AsRef<Path>,
) -> BackendConfigResult<BackendConfigSnapshot> {
    let config_path = backend_config_path(base_dir);
    let content = fs::read_to_string(&config_path).map_err(|source| BackendConfigError::Io {
        path: config_path.clone(),
        source,
    })?;
    let mut value: Value =
        serde_json::from_str(&content).map_err(|source| BackendConfigError::Json {
            path: config_path.clone(),
            source,
        })?;
    let generated_tenex_private_key = ensure_config_private_key(&config_path, &mut value)?;
    let raw: RawTenexConfig =
        serde_json::from_value(value).map_err(|source| BackendConfigError::Json {
            path: config_path.clone(),
            source,
        })?;

    Ok(BackendConfigSnapshot {
        config_path,
        whitelisted_pubkeys: retain_nonempty(raw.whitelisted_pubkeys),
        whitelisted_identities: retain_nonempty_trimmed(raw.whitelisted_identities),
        tenex_private_key: raw.tenex_private_key,
        backend_name: raw.backend_name,
        projects_base: raw.projects_base,
        relays: raw.relays,
        identity_relays: raw.identity_relays,
        blossom_server_url: raw.blossom_server_url,
        generated_tenex_private_key,
        nip46: raw
            .nip46
            .map(RawNip46Config::into_config)
            .unwrap_or_default(),
        intervention: raw
            .intervention
            .map(RawInterventionConfig::into_config)
            .unwrap_or_default(),
    })
}

/// Merge `fields` into config.json, preserving all existing keys not in `fields`.
/// Creates the file with `{}` as the base if it doesn't exist yet.
pub fn write_backend_config_fields(
    base_dir: impl AsRef<Path>,
    fields: &Map<String, Value>,
) -> BackendConfigResult<()> {
    let config_path = backend_config_path(base_dir);
    let mut value: Value = if config_path.exists() {
        let content =
            fs::read_to_string(&config_path).map_err(|source| BackendConfigError::Io {
                path: config_path.clone(),
                source,
            })?;
        serde_json::from_str(&content).map_err(|source| BackendConfigError::Json {
            path: config_path.clone(),
            source,
        })?
    } else {
        Value::Object(Map::new())
    };

    let object = value
        .as_object_mut()
        .ok_or_else(|| BackendConfigError::Json {
            path: config_path.clone(),
            source: serde_json::from_str::<Map<String, Value>>("[]")
                .expect_err("array must not parse as object"),
        })?;
    for (key, val) in fields {
        object.insert(key.clone(), val.clone());
    }

    let updated =
        serde_json::to_string_pretty(&value).map_err(|source| BackendConfigError::WriteJson {
            path: config_path.clone(),
            source,
        })?;
    fs::write(&config_path, format!("{updated}\n")).map_err(|source| BackendConfigError::WriteIo {
        path: config_path,
        source,
    })
}

fn ensure_config_private_key(config_path: &Path, value: &mut Value) -> BackendConfigResult<bool> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| BackendConfigError::Json {
            path: config_path.to_path_buf(),
            source: serde_json::from_str::<Map<String, Value>>("[]")
                .expect_err("array must not parse as object"),
        })?;
    let has_key = object
        .get("tenexPrivateKey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    if has_key {
        return Ok(false);
    }

    object.insert(
        "tenexPrivateKey".to_string(),
        Value::String(generate_backend_private_key_hex()?),
    );
    let updated =
        serde_json::to_string_pretty(value).map_err(|source| BackendConfigError::WriteJson {
            path: config_path.to_path_buf(),
            source,
        })?;
    fs::write(config_path, format!("{updated}\n")).map_err(|source| {
        BackendConfigError::WriteIo {
            path: config_path.to_path_buf(),
            source,
        }
    })?;
    Ok(true)
}

fn generate_backend_private_key_hex() -> BackendConfigResult<String> {
    loop {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| BackendConfigError::KeyGeneration(error.to_string()))?;
        if SecretKey::from_byte_array(bytes).is_ok() {
            return Ok(hex::encode(bytes));
        }
    }
}

fn retain_nonempty(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect()
}

fn retain_nonempty_trimmed(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn valid_websocket_urls_or_default(values: &[String], defaults: &[&str]) -> Vec<String> {
    let urls: Vec<String> = values
        .iter()
        .filter(|value| is_valid_websocket_url(value))
        .cloned()
        .collect();

    if urls.is_empty() {
        defaults.iter().map(|value| (*value).to_string()).collect()
    } else {
        urls
    }
}

fn is_valid_websocket_url(value: &str) -> bool {
    Url::parse(value)
        .map(|url| matches!(url.scheme(), "ws" | "wss"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    #[test]
    fn reads_typescript_global_config_fields() {
        let base_dir = temp_dir("reads_typescript_global_config_fields");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(
            backend_config_path(&base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["owner-a", "", "owner-b"],
                    "whitelistedIdentities": ["telegram:1", "  ", "nostr:owner-a"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "backendName": "backend one",
                    "projectsBase": "/workspace/projects",
                    "relays": ["wss://relay.one", "https://not-a-relay", "ws://relay.two"],
                    "identityRelays": ["wss://identity.one"],
                    "blossomServerUrl": "https://blossom.example"
                }}"#
            ),
        )
        .expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert_eq!(snapshot.config_path, backend_config_path(&base_dir));
        assert_eq!(
            snapshot.whitelisted_pubkeys,
            vec!["owner-a".to_string(), "owner-b".to_string()]
        );
        assert_eq!(
            snapshot.whitelisted_identities,
            vec!["telegram:1".to_string(), "nostr:owner-a".to_string()]
        );
        assert_eq!(
            snapshot.tenex_private_key.as_deref(),
            Some(TEST_SECRET_KEY_HEX)
        );
        assert_eq!(snapshot.backend_name.as_deref(), Some("backend one"));
        assert_eq!(snapshot.backend_name_or_default(), "backend one");
        assert_eq!(
            snapshot.projects_base.as_deref(),
            Some("/workspace/projects")
        );
        assert_eq!(
            snapshot.effective_relay_urls(),
            vec!["wss://relay.one".to_string(), "ws://relay.two".to_string()]
        );
        assert_eq!(
            snapshot.effective_identity_relay_urls(),
            vec!["wss://identity.one".to_string()]
        );
        assert_eq!(
            snapshot.blossom_server_url.as_deref(),
            Some("https://blossom.example")
        );
    }

    #[test]
    fn defaults_missing_optional_fields_and_generates_backend_key() {
        let base_dir = temp_dir("defaults_missing_optional_fields");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(backend_config_path(&base_dir), "{}").expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert!(snapshot.whitelisted_pubkeys.is_empty());
        assert!(snapshot.whitelisted_identities.is_empty());
        assert_eq!(snapshot.backend_name_or_default(), DEFAULT_BACKEND_NAME);
        assert_eq!(
            snapshot.effective_relay_urls(),
            vec!["wss://relay.tenex.chat".to_string()]
        );
        assert_eq!(
            snapshot.effective_identity_relay_urls(),
            vec!["wss://purplepag.es".to_string()]
        );
        let generated_key = snapshot
            .tenex_private_key
            .as_ref()
            .expect("missing backend key must be generated");
        assert_eq!(generated_key.len(), 64);
        assert!(snapshot.generated_tenex_private_key);
        assert!(snapshot.projects_base.is_none());

        let persisted = fs::read_to_string(backend_config_path(&base_dir)).expect("read config");
        assert!(persisted.contains("tenexPrivateKey"));
    }

    #[test]
    fn creates_backend_signer_from_config_private_key() {
        let base_dir = temp_dir("creates_backend_signer_from_config_private_key");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(
            backend_config_path(&base_dir),
            format!(r#"{{"tenexPrivateKey":"  {TEST_SECRET_KEY_HEX}\n"}}"#),
        )
        .expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");
        let signer = snapshot.backend_signer().expect("create signer");

        assert_eq!(signer.pubkey_hex(), TEST_PUBKEY_HEX);
    }

    #[test]
    fn missing_private_key_does_not_create_signer() {
        let snapshot = BackendConfigSnapshot {
            config_path: PathBuf::from("/tmp/config.json"),
            whitelisted_pubkeys: Vec::new(),
            whitelisted_identities: Vec::new(),
            tenex_private_key: None,
            backend_name: None,
            projects_base: None,
            relays: Vec::new(),
            identity_relays: Vec::new(),
            blossom_server_url: None,
            generated_tenex_private_key: false,
            nip46: Nip46Config::default(),
            intervention: InterventionConfig::default(),
        };

        assert!(matches!(
            snapshot
                .backend_signer()
                .expect_err("missing key must fail"),
            BackendConfigError::MissingPrivateKey
        ));
    }

    #[test]
    fn read_errors_include_config_path() {
        let base_dir = temp_dir("read_errors_include_config_path");
        let error = read_backend_config(&base_dir).expect_err("missing file must fail");

        assert!(matches!(
            error,
            BackendConfigError::Io {
                ref path,
                source: _
            } if *path == backend_config_path(&base_dir)
        ));
    }

    #[test]
    fn json_errors_include_config_path() {
        let base_dir = temp_dir("json_errors_include_config_path");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(backend_config_path(&base_dir), "{not-json").expect("write config");

        let error = read_backend_config(&base_dir).expect_err("invalid json must fail");

        assert!(matches!(
            error,
            BackendConfigError::Json {
                ref path,
                source: _
            } if *path == backend_config_path(&base_dir)
        ));
    }

    #[test]
    fn debug_output_redacts_private_key() {
        let snapshot = BackendConfigSnapshot {
            config_path: PathBuf::from("/tmp/config.json"),
            whitelisted_pubkeys: Vec::new(),
            whitelisted_identities: Vec::new(),
            tenex_private_key: Some(TEST_SECRET_KEY_HEX.to_string()),
            backend_name: None,
            projects_base: None,
            relays: Vec::new(),
            identity_relays: Vec::new(),
            blossom_server_url: None,
            generated_tenex_private_key: false,
            nip46: Nip46Config::default(),
            intervention: InterventionConfig::default(),
        };

        let debug = format!("{snapshot:?}");

        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(TEST_SECRET_KEY_HEX));
    }

    #[test]
    fn nip46_defaults_apply_when_block_is_missing() {
        let base_dir = temp_dir("nip46_defaults_apply_when_block_is_missing");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(backend_config_path(&base_dir), "{}").expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert_eq!(snapshot.nip46, Nip46Config::default());
        assert_eq!(snapshot.nip46.signing_timeout_ms, 30_000);
        assert_eq!(snapshot.nip46.max_retries, 2);
        assert!(snapshot.nip46.owners.is_empty());
    }

    #[test]
    fn nip46_partial_overrides_fill_remaining_defaults() {
        let base_dir = temp_dir("nip46_partial_overrides_fill_remaining_defaults");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(
            backend_config_path(&base_dir),
            r#"{ "nip46": { "signingTimeoutMs": 12345 } }"#,
        )
        .expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert_eq!(snapshot.nip46.signing_timeout_ms, 12_345);
        assert_eq!(snapshot.nip46.max_retries, 2);
        assert!(snapshot.nip46.owners.is_empty());
    }

    #[test]
    fn nip46_owners_map_is_preserved_as_parsed() {
        let base_dir = temp_dir("nip46_owners_map_is_preserved_as_parsed");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(
            backend_config_path(&base_dir),
            r#"{
                "nip46": {
                    "maxRetries": 5,
                    "owners": {
                        "owner-a": { "bunkerUri": "bunker://pk-a?relay=wss://a/" },
                        "owner-b": {}
                    }
                }
            }"#,
        )
        .expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert_eq!(snapshot.nip46.signing_timeout_ms, 30_000);
        assert_eq!(snapshot.nip46.max_retries, 5);
        assert_eq!(snapshot.nip46.owners.len(), 2);
        assert_eq!(
            snapshot.nip46.owners.get("owner-a"),
            Some(&OwnerNip46Config {
                bunker_uri: Some("bunker://pk-a?relay=wss://a/".to_string()),
            })
        );
        assert_eq!(
            snapshot.nip46.owners.get("owner-b"),
            Some(&OwnerNip46Config { bunker_uri: None })
        );
    }

    #[test]
    fn nip46_unknown_keys_inside_block_are_tolerated() {
        let base_dir = temp_dir("nip46_unknown_keys_inside_block_are_tolerated");
        fs::create_dir_all(&base_dir).expect("create temp config dir");
        fs::write(
            backend_config_path(&base_dir),
            r#"{
                "nip46": {
                    "signingTimeoutMs": 40000,
                    "someFutureOption": true,
                    "owners": {
                        "owner-a": {
                            "bunkerUri": "bunker://pk-a?relay=wss://a/",
                            "somethingElse": 7
                        }
                    }
                }
            }"#,
        )
        .expect("write config");

        let snapshot = read_backend_config(&base_dir).expect("read config");

        assert_eq!(snapshot.nip46.signing_timeout_ms, 40_000);
        assert_eq!(snapshot.nip46.max_retries, 2);
        assert_eq!(
            snapshot.nip46.owners.get("owner-a"),
            Some(&OwnerNip46Config {
                bunker_uri: Some("bunker://pk-a?relay=wss://a/".to_string()),
            })
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tenex-daemon-backend-config-{name}-{}-{nanos}",
            std::process::id()
        ))
    }
}

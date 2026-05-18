//! Integration tests against a representative local config fixture.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tenex_llm_config::{
    key_health::KeyHealthTracker,
    resolver::{load_llms, load_providers, resolve_config, ConfigStore},
    ResolvedConfig, StandardConfig,
};

struct FixtureDir {
    path: PathBuf,
}

impl FixtureDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "tenex-llm-config-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create fixture dir");
        std::fs::write(
            path.join("llms.json"),
            r#"{
  "configurations": {
    "opus": {
      "provider": "anthropic",
      "model": "claude-opus-4-6"
    },
    "codex/gpt-5.4": {
      "provider": "codex",
      "model": "gpt-5.4",
      "effort": "xhigh"
    },
    "claude-code/sonnet": {
      "provider": "claude-code",
      "model": "sonnet"
    },
    "codex-acp": {
      "provider": "acp",
      "backend": "codex",
      "command": "codex",
      "args": ["--json"],
      "env": {"TENEX_ACP": "1"},
      "model": "gpt-5.4",
      "permissionPolicy": "allow"
    }
  },
  "default": "opus",
  "summarization": "codex/gpt-5.4"
}
"#,
        )
        .expect("write llms fixture");
        std::fs::write(
            path.join("providers.json"),
            r#"{
  "providers": {
    "anthropic": {
      "apiKey": [
        "sk-ant-primary pfer@example.com",
        "sk-ant-secondary backup@example.com"
      ]
    },
    "codex": {},
    "claude-code": {}
  }
}
"#,
        )
        .expect("write providers fixture");
        Self { path }
    }
}

impl Drop for FixtureDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).ok();
    }
}

fn base_dir() -> FixtureDir {
    FixtureDir::new()
}

fn standard(config: ResolvedConfig) -> StandardConfig {
    match config {
        ResolvedConfig::Standard(config) => config,
        other => panic!("expected standard config, got {other:?}"),
    }
}

#[test]
fn loads_llms_and_providers() {
    let dir = base_dir();

    let llms = load_llms(&dir.path).expect("load llms.json");
    let providers = load_providers(&dir.path).expect("load providers.json");

    assert!(
        !llms.configurations.is_empty(),
        "expected at least one config"
    );
    assert!(llms.roles.contains_key("default"));
    assert!(providers.providers.contains_key("anthropic"));
}

#[test]
fn resolves_standard_config() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = standard(resolve_config("opus", &llms, &providers, &kh).unwrap());

    assert_eq!(resp.provider, "anthropic");
    assert_eq!(resp.model, "claude-opus-4-6");

    assert!(
        !resp.api_keys.is_empty(),
        "anthropic apiKeys should be non-empty"
    );

    // The trailing alias must be split off; key must not contain a space.
    let first = &resp.api_keys[0];
    let key_str = &first.key;
    assert!(
        !key_str.contains(' '),
        "key must not contain the alias: {key_str:?}"
    );
    assert!(
        key_str.starts_with("sk-"),
        "key should start with sk-: {key_str:?}"
    );

    assert_eq!(first.alias.as_deref(), Some("pfer@example.com"));
    assert_eq!(
        first.original_index, 0,
        "first key should carry its original-array index"
    );
}

#[test]
fn resolves_extras_passthrough() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = standard(resolve_config("codex/gpt-5.4", &llms, &providers, &kh).unwrap());

    assert_eq!(
        resp.extras["effort"], "xhigh",
        "effort extra must be preserved"
    );
}

#[test]
fn resolves_role_default() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let role_target = llms.roles.get("default").cloned();

    let name = role_target.expect("default role should be configured");
    resolve_config(&name, &llms, &providers, &kh).expect("default role config must resolve");
}

#[test]
fn resolves_role_summarization() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let name = llms
        .roles
        .get("summarization")
        .expect("summarization role should be configured");
    resolve_config(name, &llms, &providers, &kh).expect("summarization role should resolve");
}

#[test]
fn resolve_role_or_default_uses_assigned_role_when_set() {
    let dir = base_dir();
    let store = ConfigStore::load(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = standard(store.resolve_role_or_default("summarization", &kh).unwrap());
    assert_eq!(resp.provider, "codex");
    assert_eq!(resp.model, "gpt-5.4");
}

#[test]
fn resolve_role_or_default_falls_back_to_default_when_unset() {
    let dir = base_dir();
    let store = ConfigStore::load(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    // `supervision` isn't set in the fixture; expect the `default` config.
    let resp = standard(store.resolve_role_or_default("supervision", &kh).unwrap());
    assert_eq!(resp.provider, "anthropic");
    assert_eq!(resp.model, "claude-opus-4-6");
}

#[test]
fn resolve_role_or_default_errors_when_neither_role_nor_default_set() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "tenex-llm-config-empty-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join("llms.json"),
        r#"{"configurations":{"opus":{"provider":"anthropic","model":"claude-opus-4-6"}}}"#,
    )
    .unwrap();
    std::fs::write(path.join("providers.json"), r#"{"providers":{}}"#).unwrap();

    let store = ConfigStore::load(&path).unwrap();
    let err = store
        .resolve_role_or_default("supervision", &KeyHealthTracker::new())
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("supervision") && msg.contains("default"),
        "unexpected error: {msg}"
    );

    std::fs::remove_dir_all(&path).ok();
}

#[test]
fn unknown_config_returns_error() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let err = resolve_config("__no_such_config__", &llms, &providers, &kh).unwrap_err();
    assert!(err.to_string().contains("unknown config"));
}

#[test]
fn key_health_cooldown_excludes_key() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    kh.mark_failed("anthropic", 0);
    kh.mark_failed("anthropic", 1);

    let err = resolve_config("opus", &llms, &providers, &kh).unwrap_err();

    assert!(
        err.to_string().contains("cooldown"),
        "expected cooldown error, got: {err}"
    );
}

#[test]
fn agent_provider_no_keys_is_ok() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = standard(resolve_config("claude-code/sonnet", &llms, &providers, &kh).unwrap());

    // apiKeys may be empty or contain "none" depending on what's in providers.json.
    // Either way the resolve itself must succeed.
    assert_eq!(resp.provider, "claude-code");
}

#[test]
fn resolves_acp_config() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = resolve_config("codex-acp", &llms, &providers, &kh).unwrap();
    let ResolvedConfig::Acp(config) = resp else {
        panic!("expected ACP config");
    };

    assert_eq!(config.backend, "codex");
    assert_eq!(config.command, "codex");
    assert_eq!(config.args, vec!["--json"]);
    assert_eq!(config.env.get("TENEX_ACP").map(String::as_str), Some("1"));
    assert_eq!(config.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(config.permission_policy.as_deref(), Some("allow"));
}

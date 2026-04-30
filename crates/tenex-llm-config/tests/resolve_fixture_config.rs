//! Integration tests against a representative local config fixture.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tenex_llm_config::{
    key_health::KeyHealthTracker,
    resolver::{load_llms, load_providers, resolve_config},
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

    let resp = resolve_config("opus", &llms, &providers, &kh);

    assert_eq!(resp["ok"], true, "resolve should succeed");
    assert_eq!(resp["kind"], "standard");
    assert_eq!(resp["provider"], "anthropic");
    assert_eq!(resp["model"], "claude-opus-4-6");

    let keys = resp["apiKeys"]
        .as_array()
        .expect("apiKeys should be an array");
    assert!(!keys.is_empty(), "anthropic apiKeys should be non-empty");

    // The trailing alias must be split off; key must not contain a space.
    let first = &keys[0];
    let key_str = first["key"]
        .as_str()
        .expect("apiKeys[0].key should be a string");
    assert!(
        !key_str.contains(' '),
        "key must not contain the alias: {key_str:?}"
    );
    assert!(
        key_str.starts_with("sk-"),
        "key should start with sk-: {key_str:?}"
    );

    let alias = first["alias"]
        .as_str()
        .expect("apiKeys[0].alias should be present");
    assert_eq!(alias, "pfer@example.com");
}

#[test]
fn resolves_extras_passthrough() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = resolve_config("codex/gpt-5.4", &llms, &providers, &kh);

    assert_eq!(resp["ok"], true);
    assert_eq!(resp["effort"], "xhigh", "effort extra must be preserved");
}

#[test]
fn resolves_role_default() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let role_target = llms.roles.get("default").cloned();

    let name = role_target.expect("default role should be configured");
    let resp = resolve_config(&name, &llms, &providers, &kh);
    assert_eq!(resp["ok"], true, "default role config must resolve");
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
    let resp = resolve_config(name, &llms, &providers, &kh);
    assert_eq!(resp["ok"], true);
}

#[test]
fn unknown_config_returns_error() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = resolve_config("__no_such_config__", &llms, &providers, &kh);
    assert_eq!(resp["ok"], false);
    assert!(resp["error"].as_str().unwrap().contains("unknown config"));
}

#[test]
fn key_health_cooldown_excludes_key() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    kh.mark_failed("anthropic", 0);
    kh.mark_failed("anthropic", 1);

    let resp = resolve_config("opus", &llms, &providers, &kh);

    assert_eq!(resp["ok"], false);
    assert!(
        resp["error"].as_str().unwrap().contains("cooldown"),
        "expected cooldown error, got: {}",
        resp["error"]
    );
}

#[test]
fn agent_provider_no_keys_is_ok() {
    let dir = base_dir();
    let llms = load_llms(&dir.path).unwrap();
    let providers = load_providers(&dir.path).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = resolve_config("claude-code/sonnet", &llms, &providers, &kh);

    assert_eq!(resp["ok"], true);
    assert_eq!(resp["kind"], "standard");
    // apiKeys may be empty or contain "none" depending on what's in providers.json.
    // Either way the resolve itself must succeed.
}

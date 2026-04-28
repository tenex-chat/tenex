/// Integration tests against the real ~/.tenex config files.
///
/// These tests are skipped when neither TENEX_BASE_DIR nor ~/.tenex exist, so
/// CI (which has no config) stays green.

use std::path::PathBuf;

use tenex_llm_config::{
    key_health::KeyHealthTracker,
    resolver::{load_llms, load_providers, resolve_config},
};

fn base_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("TENEX_BASE_DIR") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join(".tenex");
    if p.exists() { Some(p) } else { None }
}

#[test]
fn loads_llms_and_providers() {
    let Some(dir) = base_dir() else { return };

    let llms = load_llms(&dir).expect("load llms.json");
    let providers = load_providers(&dir).expect("load providers.json");

    println!("configs   : {:?}", llms.configurations.keys().collect::<Vec<_>>());
    println!("roles     : {:?}", llms.roles);
    println!("providers : {:?}", providers.providers.keys().collect::<Vec<_>>());

    assert!(!llms.configurations.is_empty(), "expected at least one config");
}

#[test]
fn resolves_standard_config() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    // "opus" -> anthropic provider
    let resp = resolve_config("opus", &llms, &providers, &kh);
    println!("opus: {}", serde_json::to_string_pretty(&resp).unwrap());

    assert_eq!(resp["ok"], true, "resolve should succeed");
    assert_eq!(resp["kind"], "standard");
    assert_eq!(resp["provider"], "anthropic");
    assert_eq!(resp["model"], "claude-opus-4-6");

    let keys = resp["apiKeys"].as_array().expect("apiKeys should be an array");
    assert!(!keys.is_empty(), "anthropic apiKeys should be non-empty");

    // The trailing alias " pfer@me.com" must be split off; key must not contain a space.
    let first = &keys[0];
    let key_str = first["key"].as_str().expect("apiKeys[0].key should be a string");
    assert!(!key_str.contains(' '), "key must not contain the alias: {key_str:?}");
    assert!(key_str.starts_with("sk-"), "key should start with sk-: {key_str:?}");

    // Alias must be present and match the email from providers.json.
    let alias = first["alias"].as_str().expect("apiKeys[0].alias should be present");
    assert!(alias.contains('@'), "alias should be an email: {alias:?}");
}

#[test]
fn resolves_extras_passthrough() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    // "codex/gpt-5.4" has effort="xhigh" — must appear in extras
    let resp = resolve_config("codex/gpt-5.4", &llms, &providers, &kh);
    println!("codex/gpt-5.4: {}", serde_json::to_string_pretty(&resp).unwrap());

    assert_eq!(resp["ok"], true);
    assert_eq!(resp["effort"], "xhigh", "effort extra must be preserved");
}

#[test]
fn resolves_role_default() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    // The "default" role points to a config; resolve it indirectly.
    let role_target = llms.roles.get("default").cloned();
    println!("default role -> {:?}", role_target);

    let Some(name) = role_target else {
        println!("no default role configured; skipping");
        return;
    };
    let resp = resolve_config(&name, &llms, &providers, &kh);
    assert_eq!(resp["ok"], true, "default role config must resolve");
}

#[test]
fn resolves_role_summarization() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    let Some(name) = llms.roles.get("summarization").cloned() else {
        return;
    };
    let resp = resolve_config(&name, &llms, &providers, &kh);
    println!("summarization ({}): {}", name, serde_json::to_string_pretty(&resp).unwrap());
    assert_eq!(resp["ok"], true);
}

#[test]
fn unknown_config_returns_error() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    let resp = resolve_config("__no_such_config__", &llms, &providers, &kh);
    assert_eq!(resp["ok"], false);
    assert!(resp["error"].as_str().unwrap().contains("unknown config"));
}

#[test]
fn key_health_cooldown_excludes_key() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    // anthropic only has one key — mark it failed and expect an error.
    kh.mark_failed("anthropic", 0);

    let resp = resolve_config("opus", &llms, &providers, &kh);
    println!("opus after key[0] failure: {}", serde_json::to_string_pretty(&resp).unwrap());

    assert_eq!(resp["ok"], false);
    assert!(
        resp["error"].as_str().unwrap().contains("cooldown"),
        "expected cooldown error, got: {}",
        resp["error"]
    );
}

#[test]
fn agent_provider_no_keys_is_ok() {
    let Some(dir) = base_dir() else { return };
    let llms = load_llms(&dir).unwrap();
    let providers = load_providers(&dir).unwrap();
    let kh = KeyHealthTracker::new();

    // "claude-code/sonnet" uses the claude-code agent provider which has no real API key.
    let resp = resolve_config("claude-code/sonnet", &llms, &providers, &kh);
    println!("claude-code/sonnet: {}", serde_json::to_string_pretty(&resp).unwrap());

    assert_eq!(resp["ok"], true);
    assert_eq!(resp["kind"], "standard");
    // apiKeys may be empty or contain "none" depending on what's in providers.json.
    // Either way the resolve itself must succeed.
}

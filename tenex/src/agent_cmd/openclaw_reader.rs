//! Read state from a local OpenClaw installation.
//!
//! Mirrors `src/commands/agent/import/openclaw-reader.ts` verbatim.
//! All operations are local file reads — no Nostr, no LLM. The
//! `tenex agent import openclaw` command consumes this module to enumerate
//! candidate agents before handing off to the distillation step.
//!
//! OpenClaw's state directory is one of `~/.openclaw`, `~/.clawdbot`,
//! `~/.moldbot`, `~/.moltbot`, or `$OPENCLAW_STATE_DIR`. Each contains
//! one of `openclaw.json` / `clawdbot.json` / `moldbot.json` /
//! `moltbot.json` plus optionally a `workspace/` directory and an
//! `agents/main/agent/auth-profiles.json` file.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

const CONFIG_FILE_NAMES: &[&str] = &[
    "openclaw.json",
    "clawdbot.json",
    "moldbot.json",
    "moltbot.json",
];

const DEFAULT_AGENT_MODEL: &str = "anthropic/claude-sonnet-4-6";

/// Mirror `OpenClawWorkspaceFiles` (`openclaw-reader.ts:5-10`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClawWorkspaceFiles {
    pub soul: Option<String>,
    pub identity: Option<String>,
    pub agents: Option<String>,
    pub user: Option<String>,
}

/// Mirror `OpenClawAgent` (`openclaw-reader.ts:12-17`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClawAgent {
    pub id: String,
    pub model_primary: String,
    pub workspace_path: PathBuf,
    pub workspace_files: OpenClawWorkspaceFiles,
}

/// Mirror `OpenClawCredential` (`openclaw-reader.ts:133-136`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClawCredential {
    pub provider: String,
    pub api_key: String,
}

fn read_file_or_none(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn config_exists(dir: &Path) -> bool {
    CONFIG_FILE_NAMES
        .iter()
        .any(|name| dir.join(name).exists())
}

/// Mirror `findOpenClawStateDir` (`openclaw-reader.ts:41-56`):
/// 1. Honour `OPENCLAW_STATE_DIR` env var if it exists and contains a
///    recognized config json.
/// 2. Otherwise scan `candidate_paths` in order, returning the first
///    that contains one.
pub fn find_openclaw_state_dir(candidate_paths: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("OPENCLAW_STATE_DIR") {
        let p = PathBuf::from(env_dir);
        if config_exists(&p) {
            return Some(p);
        }
    }
    for dir in candidate_paths {
        if config_exists(dir) {
            return Some(dir.clone());
        }
    }
    None
}

/// `detectOpenClawStateDir` (`openclaw-reader.ts:58-66`): default
/// candidate list rooted at `$HOME`.
pub fn detect_openclaw_state_dir() -> Option<PathBuf> {
    let home = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => return None,
    };
    let candidates = vec![
        home.join(".openclaw"),
        home.join(".clawdbot"),
        home.join(".moldbot"),
        home.join(".moltbot"),
    ];
    find_openclaw_state_dir(&candidates)
}

fn read_config_json(state_dir: &Path) -> Result<Value> {
    for name in CONFIG_FILE_NAMES {
        let path = state_dir.join(name);
        if let Ok(bytes) = std::fs::read(&path) {
            return serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", path.display()));
        }
    }
    Err(anyhow!("No config file found in {}", state_dir.display()))
}

fn read_workspace_files(workspace_path: &Path) -> OpenClawWorkspaceFiles {
    OpenClawWorkspaceFiles {
        soul: read_file_or_none(&workspace_path.join("SOUL.md")),
        identity: read_file_or_none(&workspace_path.join("IDENTITY.md")),
        agents: read_file_or_none(&workspace_path.join("AGENTS.md")),
        user: read_file_or_none(&workspace_path.join("USER.md")),
    }
}

/// Mirror `readOpenClawAgents` (`openclaw-reader.ts:90-131`).
///
/// Parses the OpenClaw config json, extracts the agent list (or
/// synthesises a single `"main"` entry when absent), reads each agent's
/// workspace files, and returns the result.
pub fn read_openclaw_agents(state_dir: &Path) -> Result<Vec<OpenClawAgent>> {
    let config = read_config_json(state_dir)?;
    let agents_config = config
        .get("agents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let defaults = agents_config
        .get("defaults")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let default_model: Option<String> = defaults
        .get("model")
        .and_then(Value::as_object)
        .and_then(|m| m.get("primary"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let default_workspace: PathBuf = defaults
        .get("workspace")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| state_dir.join("workspace"));

    let list = agents_config.get("list").and_then(Value::as_array);

    let synth_main = || -> Vec<OpenClawAgent> {
        let workspace_files = read_workspace_files(&default_workspace);
        vec![OpenClawAgent {
            id: "main".to_owned(),
            model_primary: default_model
                .clone()
                .unwrap_or_else(|| DEFAULT_AGENT_MODEL.to_owned()),
            workspace_path: default_workspace.clone(),
            workspace_files,
        }]
    };

    match list {
        None => Ok(synth_main()),
        Some(arr) if arr.is_empty() => Ok(synth_main()),
        Some(arr) => Ok(arr
            .iter()
            .map(|entry| {
                let id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("main")
                    .to_owned();
                let agent_model = entry
                    .get("model")
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("primary"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let workspace_path = entry
                    .get("workspace")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| default_workspace.clone());
                let workspace_files = read_workspace_files(&workspace_path);
                OpenClawAgent {
                    id,
                    model_primary: agent_model
                        .or_else(|| default_model.clone())
                        .unwrap_or_else(|| DEFAULT_AGENT_MODEL.to_owned()),
                    workspace_path,
                    workspace_files,
                }
            })
            .collect()),
    }
}

/// Mirror `readOpenClawCredentials` (`openclaw-reader.ts:143-185`).
///
/// Reads `<state_dir>/agents/main/agent/auth-profiles.json` and extracts
/// `(provider, api_key)` pairs from `profiles[*]`. Profiles are sorted
/// `:default` first, then alphabetically; the first occurrence per
/// provider wins.
pub fn read_openclaw_credentials(state_dir: &Path) -> Result<Vec<OpenClawCredential>> {
    let profile_path = state_dir
        .join("agents")
        .join("main")
        .join("agent")
        .join("auth-profiles.json");
    let Some(content) = read_file_or_none(&profile_path) else {
        return Ok(Vec::new());
    };
    let parsed: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()), // TS swallows parse errors
    };
    let Some(profiles) = parsed.get("profiles").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };

    let mut sorted_keys: Vec<&String> = profiles.keys().collect();
    sorted_keys.sort_by(|a, b| {
        let a_default = if a.contains(":default") { 0 } else { 1 };
        let b_default = if b.contains(":default") { 0 } else { 1 };
        match a_default.cmp(&b_default) {
            std::cmp::Ordering::Equal => a.cmp(b),
            other => other,
        }
    });

    let mut credentials = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for key in sorted_keys {
        let Some(profile) = profiles.get(key).and_then(Value::as_object) else {
            continue;
        };
        let provider = match profile.get("provider").and_then(Value::as_str) {
            Some(p) => p.to_owned(),
            None => continue,
        };
        if seen.contains(&provider) {
            continue;
        }
        let profile_type = profile.get("type").and_then(Value::as_str);
        let api_key = match profile_type {
            Some("token") => profile.get("token").and_then(Value::as_str),
            Some("api_key") => profile.get("key").and_then(Value::as_str),
            Some("oauth") => profile.get("access").and_then(Value::as_str),
            _ => None,
        };
        if let Some(k) = api_key {
            seen.insert(provider.clone());
            credentials.push(OpenClawCredential {
                provider,
                api_key: k.to_owned(),
            });
        }
    }
    Ok(credentials)
}

/// Mirror `convertModelFormat` (`openclaw-reader.ts:191-195`):
/// replace the **first** `/` with `:`. Strings without `/` pass through.
pub fn convert_model_format(model: &str) -> String {
    match model.find('/') {
        Some(i) => format!("{}:{}", &model[..i], &model[i + 1..]),
        None => model.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-openclaw-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_config(dir: &Path, body: &str) {
        std::fs::write(dir.join("openclaw.json"), body).unwrap();
    }

    fn write_workspace(workspace: &Path, soul: Option<&str>) {
        std::fs::create_dir_all(workspace).unwrap();
        if let Some(s) = soul {
            std::fs::write(workspace.join("SOUL.md"), s).unwrap();
        }
    }

    // ── convert_model_format ────────────────────────────────────────────

    #[test]
    fn convert_model_format_swaps_first_slash() {
        assert_eq!(
            convert_model_format("anthropic/claude-sonnet-4-6"),
            "anthropic:claude-sonnet-4-6"
        );
    }

    #[test]
    fn convert_model_format_only_swaps_first_slash() {
        // The TS code does `slice(0, firstSlash) + ":" + slice(firstSlash + 1)`
        // so subsequent slashes survive.
        assert_eq!(
            convert_model_format("openrouter/x/y"),
            "openrouter:x/y"
        );
    }

    #[test]
    fn convert_model_format_no_slash_passes_through() {
        assert_eq!(convert_model_format("local"), "local");
    }

    // ── config_exists / find_openclaw_state_dir ─────────────────────────

    #[test]
    fn config_exists_returns_true_when_any_recognized_name_present() {
        let base = unique_temp();
        std::fs::write(base.join("clawdbot.json"), "{}").unwrap();
        assert!(config_exists(&base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn config_exists_returns_false_when_no_recognized_name_present() {
        let base = unique_temp();
        std::fs::write(base.join("not-recognised.json"), "{}").unwrap();
        assert!(!config_exists(&base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_state_dir_picks_first_matching_candidate() {
        let a = unique_temp();
        let b = unique_temp();
        write_config(&b, "{}");
        let result = find_openclaw_state_dir(&[a.clone(), b.clone()]);
        assert_eq!(result, Some(b.clone()));
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn find_state_dir_returns_none_when_no_match() {
        let a = unique_temp();
        let result = find_openclaw_state_dir(std::slice::from_ref(&a));
        assert_eq!(result, None);
        std::fs::remove_dir_all(&a).ok();
    }

    // ── read_openclaw_agents ────────────────────────────────────────────

    #[test]
    fn read_agents_synthesises_main_when_no_list() {
        let base = unique_temp();
        write_config(&base, r#"{"agents": {}}"#);
        let workspace = base.join("workspace");
        write_workspace(&workspace, Some("hello"));
        let agents = read_openclaw_agents(&base).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "main");
        assert_eq!(agents[0].model_primary, DEFAULT_AGENT_MODEL);
        assert_eq!(agents[0].workspace_path, workspace);
        assert_eq!(agents[0].workspace_files.soul.as_deref(), Some("hello"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_agents_synthesises_main_when_list_empty() {
        let base = unique_temp();
        write_config(&base, r#"{"agents": {"list": []}}"#);
        let agents = read_openclaw_agents(&base).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "main");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_agents_uses_defaults_when_entry_omits_fields() {
        let base = unique_temp();
        write_config(
            &base,
            r#"{
                "agents": {
                    "defaults": {
                        "model": {"primary": "openai/gpt-4"},
                        "workspace": "/abs/default-ws"
                    },
                    "list": [{"id": "alpha"}]
                }
            }"#,
        );
        let agents = read_openclaw_agents(&base).unwrap();
        assert_eq!(agents[0].id, "alpha");
        assert_eq!(agents[0].model_primary, "openai/gpt-4");
        assert_eq!(agents[0].workspace_path, PathBuf::from("/abs/default-ws"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_agents_per_entry_overrides_defaults() {
        let base = unique_temp();
        write_config(
            &base,
            r#"{
                "agents": {
                    "defaults": {
                        "model": {"primary": "default/m"},
                        "workspace": "/abs/default"
                    },
                    "list": [
                        {"id": "alpha", "model": {"primary": "alpha/m"}, "workspace": "/abs/a"},
                        {"id": "beta"}
                    ]
                }
            }"#,
        );
        let agents = read_openclaw_agents(&base).unwrap();
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].model_primary, "alpha/m");
        assert_eq!(agents[0].workspace_path, PathBuf::from("/abs/a"));
        assert_eq!(agents[1].model_primary, "default/m");
        assert_eq!(agents[1].workspace_path, PathBuf::from("/abs/default"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_agents_falls_back_to_constant_default_model_when_nothing_set() {
        let base = unique_temp();
        write_config(&base, r#"{"agents": {"list": [{"id": "x"}]}}"#);
        let agents = read_openclaw_agents(&base).unwrap();
        assert_eq!(agents[0].model_primary, DEFAULT_AGENT_MODEL);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_agents_errors_when_no_recognized_config_file() {
        let base = unique_temp();
        std::fs::write(base.join("nope.json"), "{}").unwrap();
        let err = read_openclaw_agents(&base).unwrap_err().to_string();
        assert!(err.starts_with("No config file found in"), "got: {err}");
        std::fs::remove_dir_all(&base).ok();
    }

    // ── read_openclaw_credentials ───────────────────────────────────────

    #[test]
    fn read_credentials_returns_empty_when_profile_file_missing() {
        let base = unique_temp();
        let creds = read_openclaw_credentials(&base).unwrap();
        assert!(creds.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_credentials_returns_empty_on_malformed_json() {
        let base = unique_temp();
        let auth_dir = base.join("agents").join("main").join("agent");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(auth_dir.join("auth-profiles.json"), "not-json").unwrap();
        let creds = read_openclaw_credentials(&base).unwrap();
        assert!(creds.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_credentials_extracts_token_api_key_oauth_types() {
        let base = unique_temp();
        let auth_dir = base.join("agents").join("main").join("agent");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(
            auth_dir.join("auth-profiles.json"),
            r#"{"profiles": {
                "anthropic:default": {"provider": "anthropic", "type": "token", "token": "tok-A"},
                "openai:default": {"provider": "openai", "type": "api_key", "key": "key-O"},
                "google:default": {"provider": "google", "type": "oauth", "access": "oauth-G"}
            }}"#,
        )
        .unwrap();
        let creds = read_openclaw_credentials(&base).unwrap();
        let mut by_provider: Vec<(&str, &str)> = creds
            .iter()
            .map(|c| (c.provider.as_str(), c.api_key.as_str()))
            .collect();
        by_provider.sort();
        assert_eq!(
            by_provider,
            vec![
                ("anthropic", "tok-A"),
                ("google", "oauth-G"),
                ("openai", "key-O")
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_credentials_default_keys_win_over_non_default_for_same_provider() {
        // When both `:default` and a non-default profile exist for the
        // same provider, the `:default` one is sorted first and wins.
        let base = unique_temp();
        let auth_dir = base.join("agents").join("main").join("agent");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(
            auth_dir.join("auth-profiles.json"),
            r#"{"profiles": {
                "anthropic:work": {"provider": "anthropic", "type": "token", "token": "WORK"},
                "anthropic:default": {"provider": "anthropic", "type": "token", "token": "DEFAULT"}
            }}"#,
        )
        .unwrap();
        let creds = read_openclaw_credentials(&base).unwrap();
        assert_eq!(creds.len(), 1);
        assert_eq!(creds[0].provider, "anthropic");
        assert_eq!(creds[0].api_key, "DEFAULT");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_credentials_skips_profiles_with_unknown_type() {
        let base = unique_temp();
        let auth_dir = base.join("agents").join("main").join("agent");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(
            auth_dir.join("auth-profiles.json"),
            r#"{"profiles": {
                "weird:default": {"provider": "weird", "type": "magic", "secret": "x"},
                "valid:default": {"provider": "valid", "type": "token", "token": "ok"}
            }}"#,
        )
        .unwrap();
        let creds = read_openclaw_credentials(&base).unwrap();
        let providers: Vec<&str> =
            creds.iter().map(|c| c.provider.as_str()).collect();
        assert_eq!(providers, vec!["valid"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_credentials_skips_profiles_missing_provider_field() {
        let base = unique_temp();
        let auth_dir = base.join("agents").join("main").join("agent");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(
            auth_dir.join("auth-profiles.json"),
            r#"{"profiles": {
                "anon:default": {"type": "token", "token": "x"},
                "ok:default": {"provider": "ok", "type": "token", "token": "y"}
            }}"#,
        )
        .unwrap();
        let creds = read_openclaw_credentials(&base).unwrap();
        let providers: Vec<&str> =
            creds.iter().map(|c| c.provider.as_str()).collect();
        assert_eq!(providers, vec!["ok"]);
        std::fs::remove_dir_all(&base).ok();
    }
}

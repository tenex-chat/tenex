//! Reader for per-agent Telegram bot configuration.
//!
//! Each agent record under `$TENEX_BASE_DIR/agents/<pubkey>.json` may carry
//! a `telegram` block with shape
//! `{ botToken, apiBaseUrl?, publishReasoningToTelegram?, publishConversationToTelegram?, allowDMs? }`.
//! When present the daemon must start a long-poll gateway thread for that
//! bot. Mirrors the TS `TelegramAgentConfig` shape in
//! `src/agents/types/storage.ts`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::telegram::gateway::GatewayBot;

#[derive(Debug, Error)]
pub enum AgentTelegramConfigError {
    #[error("failed to read agents directory {path:?}: {source}")]
    ReadDirectory { path: PathBuf, source: io::Error },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentRecord {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    telegram: Option<RawTelegramConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTelegramConfig {
    #[serde(default)]
    bot_token: Option<String>,
    #[serde(default)]
    api_base_url: Option<String>,
}

/// Scan `<tenex_base_dir>/agents/` for agent files carrying a `telegram`
/// block with a non-empty `botToken`. Inactive agents and agents without a
/// bot token are skipped.
pub fn read_agent_gateway_bots(
    tenex_base_dir: &Path,
) -> Result<Vec<GatewayBot>, AgentTelegramConfigError> {
    let agents_dir = tenex_base_dir.join("agents");
    let mut bots: Vec<GatewayBot> = Vec::new();

    let entries = match fs::read_dir(&agents_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(bots),
        Err(source) => {
            return Err(AgentTelegramConfigError::ReadDirectory {
                path: agents_dir,
                source,
            });
        }
    };

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !is_agent_file(&path) {
            continue;
        }
        let Some(pubkey) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let Ok(record) = serde_json::from_str::<RawAgentRecord>(&content) else {
            continue;
        };
        if record.status.as_deref() == Some("inactive") {
            continue;
        }
        let Some(telegram) = record.telegram else {
            continue;
        };
        let Some(bot_token) = telegram
            .bot_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let label = record
            .slug
            .clone()
            .or_else(|| Some(pubkey.chars().take(8).collect::<String>()))
            .unwrap_or_else(|| pubkey.to_string());
        let agent_name = record.name.unwrap_or_else(|| {
            record
                .slug
                .clone()
                .unwrap_or_else(|| pubkey.chars().take(8).collect())
        });
        bots.push(GatewayBot {
            label,
            agent_pubkey: pubkey.to_string(),
            agent_name,
            bot_token,
            api_base_url: telegram.api_base_url,
        });
    }

    bots.sort_by(|left, right| left.agent_pubkey.cmp(&right.agent_pubkey));
    Ok(bots)
}

fn is_agent_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if path.file_name().and_then(|name| name.to_str()) == Some("index.json") {
        return false;
    }
    path.extension().and_then(|ext| ext.to_str()) == Some("json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_agents_dir_yields_no_bots() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = read_agent_gateway_bots(tmp.path()).expect("ok");
        assert!(result.is_empty());
    }

    #[test]
    fn missing_agents_dir_yields_no_bots() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Don't create the agents/ subdir.
        let result = read_agent_gateway_bots(tmp.path()).expect("ok");
        assert!(result.is_empty());
    }

    #[test]
    fn picks_up_agent_with_bot_token_and_skips_inactive() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agents = tmp.path().join("agents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(
            agents.join("a".repeat(64) + ".json"),
            serde_json::json!({
                "slug": "alpha",
                "name": "Alpha Agent",
                "telegram": {
                    "botToken": "12345:ABC",
                    "apiBaseUrl": "http://mock"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            agents.join("b".repeat(64) + ".json"),
            serde_json::json!({
                "slug": "beta",
                "name": "Beta Agent",
                "status": "inactive",
                "telegram": { "botToken": "other:TOK" }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            agents.join("c".repeat(64) + ".json"),
            serde_json::json!({ "slug": "no-telegram" }).to_string(),
        )
        .unwrap();
        // Missing bot token shouldn't count.
        fs::write(
            agents.join("d".repeat(64) + ".json"),
            serde_json::json!({
                "slug": "delta",
                "telegram": { "botToken": "" }
            })
            .to_string(),
        )
        .unwrap();

        let bots = read_agent_gateway_bots(tmp.path()).expect("ok");
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].label, "alpha");
        assert_eq!(bots[0].bot_token, "12345:ABC");
        assert_eq!(bots[0].api_base_url.as_deref(), Some("http://mock"));
        assert_eq!(bots[0].agent_pubkey, "a".repeat(64));
        assert_eq!(bots[0].agent_name, "Alpha Agent");
    }

    #[test]
    fn ignores_index_json_and_non_json_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agents = tmp.path().join("agents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(agents.join("index.json"), "[]").unwrap();
        fs::write(agents.join("readme.md"), "ignore").unwrap();
        let bots = read_agent_gateway_bots(tmp.path()).expect("ok");
        assert!(bots.is_empty());
    }
}

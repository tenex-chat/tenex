use anyhow::{Context, Result};
use indexmap::IndexMap;
use serde_json::Value;

use crate::atomic;
use crate::paths::agent_file_path;
use crate::sanitize::{migrate_agent_data, normalize_loaded_agent, sanitize_for_persistence};
use crate::serde_util::serialize;

// ───────────────────────── single-agent file ──────────────────────────────

/// One agent's persisted JSON file.
///
/// Backed by `IndexMap<String, Value>` so unknown / yet-to-be-typed fields
/// round-trip with insertion order preserved — same approach as
/// `tenex_config`, `mcp`, `embed`.
#[derive(Clone)]
pub struct AgentDoc {
    raw: IndexMap<String, Value>,
}

impl AgentDoc {
    /// Read `<base>/agents/<pubkey>.json` and apply load-time normalization
    ///
    /// If the file was migrated, the canonicalized bytes are written back
    /// (matching `loadAgent` at `AgentStorage.ts:459-481`).
    /// Returns `None` if the file does not exist.
    pub fn load(base_dir: &std::path::Path, pubkey: &str) -> Result<Option<Self>> {
        let path = agent_file_path(base_dir, pubkey);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let mut raw: IndexMap<String, Value> =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

        let normalized_changed = normalize_loaded_agent(&mut raw);
        let migrated = migrate_agent_data(&mut raw);

        if normalized_changed || migrated {
            // Persist the canonicalized form. TS writes raw JSON.stringify
            // with no trailing newline; mirror that.
            let canonical = serialize(&raw)?;
            atomic::write(&path, &canonical)?;
        }

        Ok(Some(Self { raw }))
    }

    /// Persist this agent. Applies sanitization (drop legacy fields,
    /// collapse empty blocks) before serializing. Filename is derived from
    /// `pubkey`.
    pub fn save(&self, base_dir: &std::path::Path, pubkey: &str) -> Result<()> {
        let mut raw = self.raw.clone();
        sanitize_for_persistence(&mut raw);
        let bytes = serialize(&raw)?;
        atomic::write(&agent_file_path(base_dir, pubkey), &bytes)?;
        Ok(())
    }

    /// Construct from already-canonical raw form (e.g., after running
    /// `createStoredAgent` equivalent in-memory). Sanitization runs at
    /// `save()` time, so callers can pass in shapes with empty maps.
    pub fn from_raw(raw: IndexMap<String, Value>) -> Self {
        Self { raw }
    }

    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    pub fn raw_mut(&mut self) -> &mut IndexMap<String, Value> {
        &mut self.raw
    }

    pub fn nsec(&self) -> Option<&str> {
        self.raw.get("nsec").and_then(Value::as_str)
    }

    pub fn slug(&self) -> Option<&str> {
        self.raw.get("slug").and_then(Value::as_str)
    }

    pub fn name(&self) -> Option<&str> {
        self.raw.get("name").and_then(Value::as_str)
    }

    pub fn role(&self) -> Option<&str> {
        self.raw.get("role").and_then(Value::as_str)
    }

    pub fn event_id(&self) -> Option<&str> {
        self.raw.get("eventId").and_then(Value::as_str)
    }

    pub fn status(&self) -> Option<&str> {
        self.raw.get("status").and_then(Value::as_str)
    }

    /// `isAgentActive` — `AgentStorage.ts:169-174`. Missing `status` is
    /// treated as active; only the literal `"inactive"` is inactive.
    pub fn is_active(&self) -> bool {
        self.status() != Some("inactive")
    }

    /// Agent category. Resolves through [`crate::category::resolve_category`]
    /// so unknown values silently become `None`. Source field: `category`.
    pub fn category(&self) -> Option<crate::category::AgentCategory> {
        let raw = self.raw.get("category").and_then(Value::as_str);
        crate::category::resolve_category(raw)
    }

    /// Convenience: read `description`, `instructions`, and `useCriteria`.
    pub fn description(&self) -> Option<&str> {
        self.raw.get("description").and_then(Value::as_str)
    }
    pub fn instructions(&self) -> Option<&str> {
        self.raw.get("instructions").and_then(Value::as_str)
    }
    pub fn use_criteria(&self) -> Option<&str> {
        self.raw.get("useCriteria").and_then(Value::as_str)
    }

    /// Read the agent's `telegram` config block as a typed projection.
    /// Returns `None` when the field is absent or has been collapsed-empty
    /// by [`sanitize_telegram_inplace`]. Mirrors
    /// `agent.telegram` accessor at `AgentStorage.ts:74-88` +
    /// `TelegramAgentConfig` (`storage.ts:4-15`).
    pub fn telegram_config(&self) -> Option<TelegramAgentConfig> {
        let obj = self.raw.get("telegram").and_then(Value::as_object)?;
        let bot_token = obj.get("botToken").and_then(Value::as_str)?.to_owned();
        Some(TelegramAgentConfig {
            bot_token,
            allow_dms: obj.get("allowDMs").and_then(Value::as_bool),
            api_base_url: obj
                .get("apiBaseUrl")
                .and_then(Value::as_str)
                .map(str::to_owned),
            publish_reasoning_to_telegram: obj
                .get("publishReasoningToTelegram")
                .and_then(Value::as_bool),
            publish_conversation_to_telegram: obj
                .get("publishConversationToTelegram")
                .and_then(Value::as_bool),
        })
    }
}

/// Mirror of `TelegramAgentConfig` (`storage.ts:4-15`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramAgentConfig {
    pub bot_token: String,
    pub allow_dms: Option<bool>,
    pub api_base_url: Option<String>,
    pub publish_reasoning_to_telegram: Option<bool>,
    pub publish_conversation_to_telegram: Option<bool>,
}

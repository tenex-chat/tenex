//! `~/.tenex/config.json` reader/writer.
//!
//! Schema source: `TenexConfigSchema` at `src/services/config/types.ts:133-385`.
//!
//! Storage model: `IndexMap<String, Value>` preserving on-disk insertion order
//! so round-trip writes are byte-identical when only typed fields change.
//! Typed accessors (`whitelisted_pubkeys`, `relays`, ...) project from the
//! raw map; `set_*` mutations preserve existing position or append at end if
//! absent (matching JS object property semantics).

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Value};

use super::atomic;

/// On-disk representation of `~/.tenex/config.json`. Lossless round-trip:
/// fields the Rust code does not understand are preserved verbatim.
#[derive(Debug, Clone, Default)]
pub struct TenexConfigDoc {
    raw: IndexMap<String, Value>,
}

impl TenexConfigDoc {
    /// Empty config (no file on disk yet).
    pub fn new() -> Self {
        Self::default()
    }

    /// Load `<base_dir>/config.json`. Returns an empty document when the file
    /// does not exist (matches TS `loadConfigFile` default-on-ENOENT behaviour
    /// at `src/services/ConfigService.ts:911-940`).
    pub fn load(base_dir: &Path) -> Result<Self> {
        let path = base_dir.join("config.json");
        match std::fs::read(&path) {
            Ok(bytes) => {
                let raw: IndexMap<String, Value> = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing {}", path.display()))?;
                Ok(Self { raw })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => {
                Err(anyhow!(e)).with_context(|| format!("reading {}", path.display()))
            }
        }
    }

    /// Persist to `<base_dir>/config.json` using 2-space indent and no
    /// trailing newline (matches TS `JSON.stringify(data, null, 2)` at
    /// `src/lib/fs/filesystem.ts:115`).
    pub fn save(&self, base_dir: &Path) -> Result<()> {
        let path = base_dir.join("config.json");
        let bytes = serialize(&self.raw)?;
        atomic::write(&path, &bytes)
    }

    /// Direct access to the underlying ordered map. Use sparingly — prefer
    /// the typed accessors below.
    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    pub fn raw_mut(&mut self) -> &mut IndexMap<String, Value> {
        &mut self.raw
    }

    // ---- typed accessors -------------------------------------------------
    //
    // Mirror `TenexConfig` interface (`src/services/config/types.ts:12-131`).
    // Only the fields actually consumed by Rust code are surfaced. Other
    // fields remain in `raw` and round-trip unchanged.

    pub fn version(&self) -> Option<u64> {
        self.raw.get("version").and_then(Value::as_u64)
    }

    pub fn set_version(&mut self, v: u64) {
        self.raw.insert("version".into(), json!(v));
    }

    pub fn whitelisted_pubkeys(&self) -> Vec<String> {
        string_array(&self.raw, "whitelistedPubkeys")
    }

    pub fn set_whitelisted_pubkeys(&mut self, pubkeys: Vec<String>) {
        set_string_array(&mut self.raw, "whitelistedPubkeys", pubkeys);
    }

    pub fn whitelisted_identities(&self) -> Vec<String> {
        string_array(&self.raw, "whitelistedIdentities")
    }

    pub fn set_whitelisted_identities(&mut self, identities: Vec<String>) {
        set_string_array(&mut self.raw, "whitelistedIdentities", identities);
    }

    pub fn tenex_private_key(&self) -> Option<String> {
        string_field(&self.raw, "tenexPrivateKey")
    }

    pub fn set_tenex_private_key(&mut self, key: String) {
        self.raw.insert("tenexPrivateKey".into(), Value::String(key));
    }

    pub fn backend_name(&self) -> Option<String> {
        string_field(&self.raw, "backendName")
    }

    pub fn set_backend_name(&mut self, name: String) {
        self.raw.insert("backendName".into(), Value::String(name));
    }

    pub fn projects_base(&self) -> Option<String> {
        string_field(&self.raw, "projectsBase")
    }

    pub fn set_projects_base(&mut self, path: String) {
        self.raw.insert("projectsBase".into(), Value::String(path));
    }

    pub fn relays(&self) -> Vec<String> {
        string_array(&self.raw, "relays")
    }

    pub fn set_relays(&mut self, relays: Vec<String>) {
        set_string_array(&mut self.raw, "relays", relays);
    }

    pub fn identity_relays(&self) -> Vec<String> {
        string_array(&self.raw, "identityRelays")
    }

    pub fn set_identity_relays(&mut self, relays: Vec<String>) {
        set_string_array(&mut self.raw, "identityRelays", relays);
    }

    pub fn blossom_server_url(&self) -> Option<String> {
        string_field(&self.raw, "blossomServerUrl")
    }

    pub fn set_blossom_server_url(&mut self, url: String) {
        self.raw.insert("blossomServerUrl".into(), Value::String(url));
    }

    pub fn project_naddr(&self) -> Option<String> {
        string_field(&self.raw, "projectNaddr")
    }

    pub fn set_project_naddr(&mut self, naddr: String) {
        self.raw.insert("projectNaddr".into(), Value::String(naddr));
    }

    /// Read `logging.level`. Source: `TenexConfigSchema:149-153`.
    pub fn logging_level(&self) -> Option<String> {
        self.raw
            .get("logging")
            .and_then(Value::as_object)
            .and_then(|m| m.get("level"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Read `logging.logFile`. Source: `TenexConfigSchema:149-153`.
    pub fn logging_log_file(&self) -> Option<String> {
        self.raw
            .get("logging")
            .and_then(Value::as_object)
            .and_then(|m| m.get("logFile"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Replace the `logging` block with `{level, logFile?}`.
    /// `log_file: None` writes the field absent (matches TS `value || undefined`).
    pub fn set_logging(&mut self, level: &str, log_file: Option<&str>) {
        let mut obj = serde_json::Map::new();
        obj.insert("level".into(), Value::String(level.to_owned()));
        if let Some(p) = log_file {
            if !p.is_empty() {
                obj.insert("logFile".into(), Value::String(p.to_owned()));
            }
        }
        self.raw.insert("logging".into(), Value::Object(obj));
    }

    /// `escalation.agent`. Source: `TenexConfigSchema` line 105-107.
    pub fn escalation_agent(&self) -> Option<String> {
        self.raw
            .get("escalation")
            .and_then(Value::as_object)
            .and_then(|m| m.get("agent"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Set `escalation = { agent }`. `None` clears the field (matches
    /// TS `existingConfig.escalation = undefined` at `escalation.ts:26`).
    pub fn set_escalation_agent(&mut self, agent: Option<&str>) {
        match agent {
            Some(a) if !a.is_empty() => {
                let mut obj = serde_json::Map::new();
                obj.insert("agent".into(), Value::String(a.to_owned()));
                self.raw.insert("escalation".into(), Value::Object(obj));
            }
            _ => {
                self.raw.shift_remove("escalation");
            }
        }
    }

    /// `summarization.inactivityTimeoutSeconds`. Source: `:39-41`.
    pub fn summarization_inactivity_timeout_seconds(&self) -> Option<u64> {
        self.raw
            .get("summarization")
            .and_then(Value::as_object)
            .and_then(|m| m.get("inactivityTimeoutSeconds"))
            .and_then(Value::as_u64)
    }

    /// Set `summarization = { inactivityTimeoutSeconds: N }`. Replaces
    /// the block (matches TS spread-then-set at `summarization.ts:27-29`).
    pub fn set_summarization_inactivity_timeout_seconds(&mut self, seconds: u64) {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "inactivityTimeoutSeconds".into(),
            Value::Number(seconds.into()),
        );
        self.raw.insert("summarization".into(), Value::Object(obj));
    }

    /// `intervention.enabled`. Source: `TenexConfigSchema:111-115`.
    pub fn intervention_enabled(&self) -> Option<bool> {
        self.raw
            .get("intervention")
            .and_then(Value::as_object)
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
    }

    pub fn intervention_agent(&self) -> Option<String> {
        self.raw
            .get("intervention")
            .and_then(Value::as_object)
            .and_then(|m| m.get("agent"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn intervention_timeout_seconds(&self) -> Option<u64> {
        self.raw
            .get("intervention")
            .and_then(Value::as_object)
            .and_then(|m| m.get("timeoutSeconds"))
            .and_then(Value::as_u64)
    }

    // ---- NIP-46 ----------------------------------------------------------
    //
    // The TS source mutates the `nip46` block via spread shape (e.g.
    // `{ ...nip46, enabled }`), so the Rust setters here are granular —
    // each one preserves every other field in the block (including nested
    // `owners`). Source: `TenexConfigSchema:118-125`.

    pub fn nip46_enabled(&self) -> Option<bool> {
        self.raw
            .get("nip46")
            .and_then(Value::as_object)
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
    }

    pub fn set_nip46_enabled(&mut self, enabled: bool) {
        self.nip46_object_mut()
            .insert("enabled".into(), Value::Bool(enabled));
    }

    pub fn nip46_signing_timeout_ms(&self) -> Option<u64> {
        self.raw
            .get("nip46")
            .and_then(Value::as_object)
            .and_then(|m| m.get("signingTimeoutMs"))
            .and_then(Value::as_u64)
    }

    pub fn set_nip46_signing_timeout_ms(&mut self, ms: u64) {
        self.nip46_object_mut()
            .insert("signingTimeoutMs".into(), Value::Number(ms.into()));
    }

    pub fn nip46_max_retries(&self) -> Option<u64> {
        self.raw
            .get("nip46")
            .and_then(Value::as_object)
            .and_then(|m| m.get("maxRetries"))
            .and_then(Value::as_u64)
    }

    pub fn set_nip46_max_retries(&mut self, retries: u64) {
        self.nip46_object_mut()
            .insert("maxRetries".into(), Value::Number(retries.into()));
    }

    pub fn nip46_owner_pubkeys(&self) -> Vec<String> {
        self.raw
            .get("nip46")
            .and_then(Value::as_object)
            .and_then(|m| m.get("owners"))
            .and_then(Value::as_object)
            .map(|owners| owners.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn nip46_owner_bunker_uri(&self, pubkey: &str) -> Option<String> {
        self.raw
            .get("nip46")
            .and_then(Value::as_object)
            .and_then(|m| m.get("owners"))
            .and_then(Value::as_object)
            .and_then(|owners| owners.get(pubkey))
            .and_then(Value::as_object)
            .and_then(|o| o.get("bunkerUri"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn set_nip46_owner(&mut self, pubkey: &str, bunker_uri: &str) {
        let owners = self.nip46_owners_mut();
        let mut entry = serde_json::Map::new();
        entry.insert("bunkerUri".into(), Value::String(bunker_uri.to_owned()));
        owners.insert(pubkey.to_owned(), Value::Object(entry));
    }

    pub fn remove_nip46_owner(&mut self, pubkey: &str) {
        if let Some(owners) = self.nip46_owners_optional_mut() {
            owners.shift_remove(pubkey);
        }
    }

    fn nip46_object_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        if !self.raw.contains_key("nip46") {
            self.raw
                .insert("nip46".into(), Value::Object(serde_json::Map::new()));
        }
        self.raw
            .get_mut("nip46")
            .and_then(Value::as_object_mut)
            .expect("nip46 just inserted as object")
    }

    fn nip46_owners_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        let nip46 = self.nip46_object_mut();
        if !nip46.contains_key("owners") {
            nip46.insert("owners".into(), Value::Object(serde_json::Map::new()));
        }
        nip46
            .get_mut("owners")
            .and_then(Value::as_object_mut)
            .expect("owners just inserted as object")
    }

    fn nip46_owners_optional_mut(
        &mut self,
    ) -> Option<&mut serde_json::Map<String, Value>> {
        self.raw
            .get_mut("nip46")
            .and_then(Value::as_object_mut)
            .and_then(|m| m.get_mut("owners"))
            .and_then(Value::as_object_mut)
    }

    // ---- Telemetry -------------------------------------------------------
    //
    // Source: `TenexConfigSchema:81-94`. Like NIP-46, the TS code mutates
    // the block via spread shape, so the Rust setters here are granular
    // (each preserves every other field). The `analysis` sub-block has
    // its own granular accessors mirroring the TS resolved-defaults shape.

    pub fn telemetry_enabled(&self) -> Option<bool> {
        self.telemetry_object()
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
    }

    pub fn telemetry_service_name(&self) -> Option<String> {
        self.telemetry_object()
            .and_then(|m| m.get("serviceName"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn telemetry_endpoint(&self) -> Option<String> {
        self.telemetry_object()
            .and_then(|m| m.get("endpoint"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn set_telemetry_enabled(&mut self, enabled: bool) {
        self.telemetry_object_mut()
            .insert("enabled".into(), Value::Bool(enabled));
    }

    pub fn set_telemetry_service_name(&mut self, name: &str) {
        self.telemetry_object_mut()
            .insert("serviceName".into(), Value::String(name.to_owned()));
    }

    pub fn set_telemetry_endpoint(&mut self, endpoint: &str) {
        self.telemetry_object_mut()
            .insert("endpoint".into(), Value::String(endpoint.to_owned()));
    }

    pub fn telemetry_analysis_enabled(&self) -> Option<bool> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
    }

    pub fn telemetry_analysis_db_path(&self) -> Option<String> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("dbPath"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn telemetry_analysis_retention_days(&self) -> Option<u64> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("retentionDays"))
            .and_then(Value::as_u64)
    }

    pub fn telemetry_analysis_large_message_threshold_tokens(&self) -> Option<u64> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("largeMessageThresholdTokens"))
            .and_then(Value::as_u64)
    }

    pub fn telemetry_analysis_store_message_previews(&self) -> Option<bool> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("storeMessagePreviews"))
            .and_then(Value::as_bool)
    }

    pub fn telemetry_analysis_max_preview_chars(&self) -> Option<u64> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("maxPreviewChars"))
            .and_then(Value::as_u64)
    }

    pub fn telemetry_analysis_store_full_message_text(&self) -> Option<bool> {
        self.telemetry_analysis_object()
            .and_then(|m| m.get("storeFullMessageText"))
            .and_then(Value::as_bool)
    }

    /// Owned shape used by the telemetry submenu when writing the analysis
    /// sub-block atomically (matches TS object literal at `:163-181`).
    pub fn set_telemetry_analysis(&mut self, fields: TelemetryAnalysisFields) {
        let mut obj = serde_json::Map::new();
        obj.insert("enabled".into(), Value::Bool(fields.enabled));
        if let Some(p) = fields.db_path {
            obj.insert("dbPath".into(), Value::String(p));
        }
        if let Some(d) = fields.retention_days {
            obj.insert("retentionDays".into(), Value::Number(d.into()));
        }
        if let Some(t) = fields.large_message_threshold_tokens {
            obj.insert(
                "largeMessageThresholdTokens".into(),
                Value::Number(t.into()),
            );
        }
        if let Some(b) = fields.store_message_previews {
            obj.insert("storeMessagePreviews".into(), Value::Bool(b));
        }
        if let Some(c) = fields.max_preview_chars {
            obj.insert("maxPreviewChars".into(), Value::Number(c.into()));
        }
        if let Some(b) = fields.store_full_message_text {
            obj.insert("storeFullMessageText".into(), Value::Bool(b));
        }
        self.telemetry_object_mut()
            .insert("analysis".into(), Value::Object(obj));
    }

    /// Remove `telemetry.analysis` entirely (matches the reset path:
    /// `existingConfig.telemetry = { ...telemetry, analysis: undefined }`
    /// at `telemetry.ts:60-64`).
    pub fn clear_telemetry_analysis(&mut self) {
        if let Some(t) = self
            .raw
            .get_mut("telemetry")
            .and_then(Value::as_object_mut)
        {
            t.shift_remove("analysis");
        }
    }

    fn telemetry_object(&self) -> Option<&serde_json::Map<String, Value>> {
        self.raw.get("telemetry").and_then(Value::as_object)
    }

    fn telemetry_object_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        if !self.raw.contains_key("telemetry") {
            self.raw
                .insert("telemetry".into(), Value::Object(serde_json::Map::new()));
        }
        self.raw
            .get_mut("telemetry")
            .and_then(Value::as_object_mut)
            .expect("telemetry just inserted as object")
    }

    fn telemetry_analysis_object(&self) -> Option<&serde_json::Map<String, Value>> {
        self.telemetry_object()
            .and_then(|m| m.get("analysis"))
            .and_then(Value::as_object)
    }

    // ---- Global system prompt -------------------------------------------
    //
    // Source: `TenexConfigSchema:97-101` — `globalSystemPrompt` block with
    // `enabled?: boolean` and `content?: string`.

    pub fn global_system_prompt_enabled(&self) -> Option<bool> {
        self.raw
            .get("globalSystemPrompt")
            .and_then(Value::as_object)
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
    }

    pub fn global_system_prompt_content(&self) -> Option<String> {
        self.raw
            .get("globalSystemPrompt")
            .and_then(Value::as_object)
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Granular setter — flips just the `enabled` flag, preserving any
    /// existing `content` (matches TS spread `{ ...existing.globalSystemPrompt, enabled }`
    /// at `system-prompt.ts:107-109, :121-123`).
    pub fn set_global_system_prompt_enabled(&mut self, enabled: bool) {
        let block = self.global_system_prompt_object_mut();
        block.insert("enabled".into(), Value::Bool(enabled));
    }

    /// Replace the content (and force-enable). Matches the editor-save path
    /// at `system-prompt.ts:194-200`: `{ enabled: true, content }`.
    pub fn set_global_system_prompt_content(&mut self, content: String) {
        let block = self.global_system_prompt_object_mut();
        block.insert("enabled".into(), Value::Bool(true));
        block.insert("content".into(), Value::String(content));
    }

    fn global_system_prompt_object_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        if !self.raw.contains_key("globalSystemPrompt") {
            self.raw.insert(
                "globalSystemPrompt".into(),
                Value::Object(serde_json::Map::new()),
            );
        }
        self.raw
            .get_mut("globalSystemPrompt")
            .and_then(Value::as_object_mut)
            .expect("globalSystemPrompt just inserted as object")
    }

    // ---- Context management (managed-context block) ---------------------
    //
    // Source: `TenexConfigSchema:160-184`.

    /// Borrow the `contextManagement` JSON block read-only.
    pub fn context_management_block(&self) -> Option<&serde_json::Map<String, Value>> {
        self.raw
            .get("contextManagement")
            .and_then(Value::as_object)
    }

    /// Replace the entire `contextManagement` block. Source:
    /// `context-management.ts:289-310` — direct assignment (no spread).
    pub fn set_context_management(&mut self, fields: ContextManagementFields) {
        let mut obj = serde_json::Map::new();
        obj.insert("enabled".into(), Value::Bool(fields.enabled));
        obj.insert(
            "tokenBudget".into(),
            Value::Number(fields.token_budget.into()),
        );
        obj.insert(
            "utilizationWarningThresholdPercent".into(),
            Value::Number(fields.utilization_warning_threshold_percent.into()),
        );
        obj.insert(
            "compactionThresholdPercent".into(),
            Value::Number(fields.compaction_threshold_percent.into()),
        );

        let mut decay = serde_json::Map::new();
        decay.insert(
            "minTotalSavingsTokens".into(),
            Value::Number(fields.tool_decay_min_total_savings_tokens.into()),
        );
        decay.insert(
            "minDepth".into(),
            Value::Number(fields.tool_decay_min_depth.into()),
        );
        decay.insert(
            "minPlaceholderBatchSize".into(),
            Value::Number(fields.tool_decay_min_placeholder_batch_size.into()),
        );
        decay.insert(
            "excludeToolNames".into(),
            Value::Array(
                fields
                    .tool_decay_exclude_tool_names
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        obj.insert("toolResultDecay".into(), Value::Object(decay));

        let mut strategies = serde_json::Map::new();
        strategies.insert(
            "reminders".into(),
            Value::Bool(fields.strategies_reminders),
        );
        strategies.insert(
            "toolResultDecay".into(),
            Value::Bool(fields.strategies_tool_result_decay),
        );
        strategies.insert(
            "compaction".into(),
            Value::Bool(fields.strategies_compaction),
        );
        strategies.insert(
            "contextUtilizationReminder".into(),
            Value::Bool(fields.strategies_context_utilization_reminder),
        );
        strategies.insert(
            "contextWindowStatus".into(),
            Value::Bool(fields.strategies_context_window_status),
        );
        obj.insert("strategies".into(), Value::Object(strategies));

        self.raw
            .insert("contextManagement".into(), Value::Object(obj));
    }

    pub fn clear_context_management(&mut self) {
        self.raw.shift_remove("contextManagement");
    }

    // ---- Context discovery (RAG block) -----------------------------------
    //
    // Source: `TenexConfigSchema:185-200`.

    /// Borrow the `contextDiscovery` JSON block read-only.
    pub fn context_discovery_block(&self) -> Option<&serde_json::Map<String, Value>> {
        self.raw.get("contextDiscovery").and_then(Value::as_object)
    }

    /// Apply the prompted fields to `contextDiscovery`, preserving any
    /// existing fields the prompt does not cover (matches TS spread
    /// `{ ...contextDiscovery, ... }` at `context-management.ts:312-313`).
    pub fn update_context_discovery(&mut self, fields: ContextDiscoveryPromptedFields) {
        if !self.raw.contains_key("contextDiscovery") {
            self.raw.insert(
                "contextDiscovery".into(),
                Value::Object(serde_json::Map::new()),
            );
        }
        let block = self
            .raw
            .get_mut("contextDiscovery")
            .and_then(Value::as_object_mut)
            .expect("contextDiscovery just inserted as object");
        block.insert("enabled".into(), Value::Bool(fields.enabled));
        block.insert("trigger".into(), Value::String(fields.trigger));
        block.insert(
            "timeoutMs".into(),
            Value::Number(fields.timeout_ms.into()),
        );
        block.insert(
            "maxQueries".into(),
            Value::Number(fields.max_queries.into()),
        );
        block.insert(
            "maxHints".into(),
            Value::Number(fields.max_hints.into()),
        );
        block.insert(
            "minScore".into(),
            serde_json::Number::from_f64(fields.min_score)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
        block.insert(
            "sources".into(),
            Value::Array(
                fields
                    .sources
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        block.insert(
            "usePlannerModel".into(),
            Value::Bool(fields.use_planner_model),
        );
        block.insert(
            "useRerankerModel".into(),
            Value::Bool(fields.use_reranker_model),
        );
        block.insert(
            "backgroundCompletionReminders".into(),
            Value::Bool(fields.background_completion_reminders),
        );
    }

    pub fn clear_context_discovery(&mut self) {
        self.raw.shift_remove("contextDiscovery");
    }
}

/// Owned construction shape for [`TenexConfigDoc::set_context_management`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContextManagementFields {
    pub enabled: bool,
    pub token_budget: u64,
    pub utilization_warning_threshold_percent: u64,
    pub compaction_threshold_percent: u64,
    pub tool_decay_min_total_savings_tokens: u64,
    pub tool_decay_min_depth: u64,
    pub tool_decay_min_placeholder_batch_size: u64,
    pub tool_decay_exclude_tool_names: Vec<String>,
    pub strategies_reminders: bool,
    pub strategies_tool_result_decay: bool,
    pub strategies_compaction: bool,
    pub strategies_context_utilization_reminder: bool,
    pub strategies_context_window_status: bool,
}

/// Owned construction shape for [`TenexConfigDoc::update_context_discovery`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContextDiscoveryPromptedFields {
    pub enabled: bool,
    pub trigger: String,
    pub timeout_ms: u64,
    pub max_queries: u64,
    pub max_hints: u64,
    pub min_score: f64,
    pub sources: Vec<String>,
    pub use_planner_model: bool,
    pub use_reranker_model: bool,
    pub background_completion_reminders: bool,
}

/// Owned construction shape for [`TenexConfigDoc::set_telemetry_analysis`].
/// Matches the TS object literal at `telemetry.ts:163-181`. `None` fields
/// are written absent (so a `false` `analysisEnabled` doesn't drag along
/// stale path/retention values).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TelemetryAnalysisFields {
    pub enabled: bool,
    pub db_path: Option<String>,
    pub retention_days: Option<u64>,
    pub large_message_threshold_tokens: Option<u64>,
    pub store_message_previews: Option<bool>,
    pub max_preview_chars: Option<u64>,
    pub store_full_message_text: Option<bool>,
}

impl TenexConfigDoc {

    /// Replace the `intervention` block with `{enabled, agent?, timeoutSeconds?}`.
    /// `agent: None` writes the field absent (matches TS
    /// `agent: answers.agent || undefined`). When the disabled-branch is
    /// taken, the caller passes the previous block's `agent` and
    /// `timeoutSeconds` so the spread-then-overwrite shape at
    /// `intervention.ts:52-55` is preserved.
    pub fn set_intervention(
        &mut self,
        enabled: bool,
        agent: Option<&str>,
        timeout_seconds: Option<u64>,
    ) {
        let mut obj = serde_json::Map::new();
        obj.insert("enabled".into(), Value::Bool(enabled));
        if let Some(a) = agent {
            if !a.is_empty() {
                obj.insert("agent".into(), Value::String(a.to_owned()));
            }
        }
        if let Some(t) = timeout_seconds {
            obj.insert("timeoutSeconds".into(), Value::Number(t.into()));
        }
        self.raw.insert("intervention".into(), Value::Object(obj));
    }
}

// ----- helpers ------------------------------------------------------------

fn string_field(raw: &IndexMap<String, Value>, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_array(raw: &IndexMap<String, Value>, key: &str) -> Vec<String> {
    raw.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn set_string_array(raw: &mut IndexMap<String, Value>, key: &str, values: Vec<String>) {
    let arr = Value::Array(values.into_iter().map(Value::String).collect());
    raw.insert(key.to_owned(), arr);
}

/// Serialize the raw map to bytes matching TS `JSON.stringify(x, null, 2)`:
/// 2-space indent, no trailing newline.
fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize config")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_unknown_fields_and_order() {
        let input = br#"{
  "version": 3,
  "whitelistedPubkeys": [
    "abc"
  ],
  "weirdUnknownField": {
    "nested": true,
    "list": [1, 2, 3]
  },
  "relays": [
    "wss://example.com"
  ]
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let doc = TenexConfigDoc { raw };

        let bytes = serialize(doc.raw()).unwrap();

        // Order preserved
        let s = String::from_utf8(bytes.clone()).unwrap();
        let v_pos = s.find("\"version\"").unwrap();
        let w_pos = s.find("\"whitelistedPubkeys\"").unwrap();
        let u_pos = s.find("\"weirdUnknownField\"").unwrap();
        let r_pos = s.find("\"relays\"").unwrap();
        assert!(v_pos < w_pos && w_pos < u_pos && u_pos < r_pos);

        // Re-parse and re-serialize is a fixed point.
        let raw2: IndexMap<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let bytes2 = serialize(&raw2).unwrap();
        assert_eq!(bytes, bytes2);

        // No trailing newline.
        assert_ne!(bytes.last(), Some(&b'\n'));
    }

    #[test]
    fn typed_accessors_read_existing_keys() {
        let input = br#"{
  "whitelistedPubkeys": ["aa", "bb"],
  "relays": ["wss://r1", "wss://r2"],
  "tenexPrivateKey": "deadbeef",
  "backendName": "tenex backend"
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let doc = TenexConfigDoc { raw };
        assert_eq!(doc.whitelisted_pubkeys(), vec!["aa", "bb"]);
        assert_eq!(doc.relays(), vec!["wss://r1", "wss://r2"]);
        assert_eq!(doc.tenex_private_key().as_deref(), Some("deadbeef"));
        assert_eq!(doc.backend_name().as_deref(), Some("tenex backend"));
    }

    #[test]
    fn set_existing_field_preserves_position() {
        let input = br#"{
  "version": 3,
  "whitelistedPubkeys": ["aa"],
  "relays": ["wss://r1"]
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let mut doc = TenexConfigDoc { raw };
        doc.set_whitelisted_pubkeys(vec!["new".into()]);
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        // Expect: version, whitelistedPubkeys, relays (whitelistedPubkeys still in slot 2)
        let v_pos = s.find("\"version\"").unwrap();
        let w_pos = s.find("\"whitelistedPubkeys\"").unwrap();
        let r_pos = s.find("\"relays\"").unwrap();
        assert!(v_pos < w_pos && w_pos < r_pos);
        assert!(s.contains("\"new\""));
    }

    #[test]
    fn set_new_field_appends_at_end() {
        let input = br#"{
  "version": 3
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let mut doc = TenexConfigDoc { raw };
        doc.set_backend_name("new backend".into());
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        let v_pos = s.find("\"version\"").unwrap();
        let b_pos = s.find("\"backendName\"").unwrap();
        assert!(v_pos < b_pos);
    }

    #[test]
    fn missing_keys_default_sensibly() {
        let doc = TenexConfigDoc::new();
        assert!(doc.whitelisted_pubkeys().is_empty());
        assert!(doc.relays().is_empty());
        assert_eq!(doc.tenex_private_key(), None);
        assert_eq!(doc.version(), None);
    }

    #[test]
    fn roundtrip_real_user_config_byte_identical() {
        // Brutal verification: open the real `~/.tenex/config.json`, round-trip
        // through our reader+serializer, expect byte-identical output. Skipped
        // when the file is missing (CI / fresh checkout).
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => return,
        };
        let path = std::path::PathBuf::from(home).join(".tenex/config.json");
        let Ok(original) = std::fs::read(&path) else { return };

        let raw: IndexMap<String, Value> = match serde_json::from_slice(&original) {
            Ok(r) => r,
            Err(e) => panic!("failed to parse {}: {e}", path.display()),
        };
        let serialized = serialize(&raw).unwrap();

        if original != serialized {
            // Help debugging: print the first diverging line.
            let orig_s = String::from_utf8_lossy(&original);
            let new_s = String::from_utf8_lossy(&serialized);
            for (i, (o, n)) in orig_s.lines().zip(new_s.lines()).enumerate() {
                if o != n {
                    panic!(
                        "byte-diff at line {i}:\n  orig: {o:?}\n  ours: {n:?}\n  (orig {} bytes, ours {} bytes)",
                        original.len(),
                        serialized.len(),
                    );
                }
            }
            panic!(
                "byte-diff somewhere past common-prefix: orig={} bytes, ours={} bytes",
                original.len(),
                serialized.len()
            );
        }
    }

    #[test]
    fn pretty_indent_is_two_spaces() {
        let input = br#"{
  "k": [
    "v"
  ]
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let bytes = serialize(&raw).unwrap();
        let s = String::from_utf8(bytes).unwrap();
        // Lines after the opening brace are indented by exactly 2 spaces (or 4 for nested).
        assert!(s.contains("\n  \"k\""));
        assert!(s.contains("\n    \"v\""));
    }
}

//! `~/.tenex/agents/` — on-disk agent storage substrate.
//!
//! Mirrors `src/agents/AgentStorage.ts` and `src/agents/types/storage.ts`.
//! Layout:
//!
//! ```text
//! <base>/agents/
//! ├── index.json              ← lookup index ({bySlug, byEventId})
//! ├── <pubkey-hex>.json       ← one StoredAgent per file
//! └── …
//! ```
//!
//! Two abstraction layers:
//!
//! 1. [`AgentDoc`] / [`AgentIndexDoc`] — pure I/O over a single file.
//!    Byte-identical round-trip via `IndexMap`, sanitize on persist (drop
//!    `chatBindings`, promote legacy `default.telegram`, drop empty
//!    `default`/`telegram`), migrate on load (drop legacy
//!    `projectOverrides` / `pmOverrides`, migrate flat-string `bySlug` →
//!    `SlugEntry`, drop legacy `byProject`).
//! 2. [`AgentStorage`] — full mutation surface mirroring the TS class:
//!    `save_agent`, `delete_agent`, `add_agent_to_project`,
//!    `remove_agent_from_project`, `cleanup_duplicate_slugs`,
//!    `find_alternative_slug_owner`, `rebuild_index`, plus all the
//!    read-side index lookups.
//!
//! Note: spec doc 10 §7 lists `byProject` as part of the index schema. The
//! TS source (`AgentStorage.ts:192`) only has `bySlug` + `byEventId` —
//! project membership lives inside `bySlug.<slug>.projectIds`. Source code
//! is canonical; the spec lags here.

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use nostr_sdk::nips::nip19::FromBech32;
use nostr_sdk::{Keys, SecretKey};
use serde_json::Value;

use crate::store::atomic;

const AGENTS_DIRNAME: &str = "agents";
const INDEX_FILENAME: &str = "index.json";

// ───────────────────────── single-agent file ──────────────────────────────

/// One agent's persisted JSON file.
///
/// Backed by `IndexMap<String, Value>` so unknown / yet-to-be-typed fields
/// (`projectConfigs`, `inferredCategory`, etc.) round-trip with insertion
/// order preserved — same approach as `tenex_config`, `mcp`, `embed`.
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

    /// Operator-authoritative category. Resolves through
    /// [`crate::store::role_categories::resolve_category`] so unknown /
    /// legacy values silently become `None`. Source field: `category`
    /// (`storage.ts:43`).
    pub fn category(&self) -> Option<crate::store::role_categories::AgentCategory> {
        let raw = self.raw.get("category").and_then(Value::as_str);
        crate::store::role_categories::resolve_category(raw)
    }

    /// Auto-inferred category (set by the categorize backfill). Distinct
    /// from `category` so explicit operator provenance is preserved.
    /// Source field: `inferredCategory` (`storage.ts:48`).
    pub fn inferred_category(&self) -> Option<crate::store::role_categories::AgentCategory> {
        let raw = self.raw.get("inferredCategory").and_then(Value::as_str);
        crate::store::role_categories::resolve_category(raw)
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

// ───────────────────────── index file ─────────────────────────────────────

/// Single slug-index entry. Mirrors `SlugEntry` at `AgentStorage.ts:179-182`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlugEntry {
    pub pubkey: String,
    pub project_ids: Vec<String>,
}

/// Loaded `index.json` — preserves insertion order on round-trip.
#[derive(Clone, Default)]
pub struct AgentIndexDoc {
    /// `bySlug`, in source order.
    by_slug: IndexMap<String, SlugEntry>,
    /// `byEventId`, in source order.
    by_event_id: IndexMap<String, String>,
}

impl AgentIndexDoc {
    /// Load `<base>/agents/index.json`. If absent, returns an empty index.
    /// If the on-disk format is the old flat `bySlug: Record<string,string>`,
    /// migrates in-memory and writes the canonicalized form back to disk —
    /// matching `loadIndex` + `migrateIndexFormat` at
    /// `AgentStorage.ts:291-321, 341-361`. Any legacy `byProject` field is
    /// silently dropped.
    pub fn load(base_dir: &std::path::Path) -> Result<Self> {
        let path = index_file_path(base_dir);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let raw: Value =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

        let (doc, needs_migration) = parse_index(&raw)?;

        if needs_migration {
            let canonical = doc.serialize_bytes()?;
            atomic::write(&path, &canonical)?;
        }
        Ok(doc)
    }

    pub fn save(&self, base_dir: &std::path::Path) -> Result<()> {
        let bytes = self.serialize_bytes()?;
        atomic::write(&index_file_path(base_dir), &bytes)?;
        Ok(())
    }

    pub fn by_slug(&self) -> &IndexMap<String, SlugEntry> {
        &self.by_slug
    }

    pub fn by_event_id(&self) -> &IndexMap<String, String> {
        &self.by_event_id
    }

    pub fn lookup_pubkey_by_slug(&self, slug: &str) -> Option<&str> {
        self.by_slug.get(slug).map(|e| e.pubkey.as_str())
    }

    pub fn lookup_pubkey_by_event_id(&self, event_id: &str) -> Option<&str> {
        self.by_event_id.get(event_id).map(String::as_str)
    }

    fn serialize_bytes(&self) -> Result<Vec<u8>> {
        // Preserve declared shape: { "bySlug": {...}, "byEventId": {...} }.
        let mut out = IndexMap::<String, Value>::new();

        let mut by_slug = IndexMap::<String, Value>::new();
        for (slug, entry) in &self.by_slug {
            let mut e = IndexMap::<String, Value>::new();
            e.insert("pubkey".into(), Value::String(entry.pubkey.clone()));
            e.insert(
                "projectIds".into(),
                Value::Array(
                    entry
                        .project_ids
                        .iter()
                        .map(|p| Value::String(p.clone()))
                        .collect(),
                ),
            );
            by_slug.insert(slug.clone(), serde_json::to_value(e)?);
        }
        out.insert("bySlug".into(), serde_json::to_value(by_slug)?);

        let mut by_event_id = IndexMap::<String, Value>::new();
        for (eid, pk) in &self.by_event_id {
            by_event_id.insert(eid.clone(), Value::String(pk.clone()));
        }
        out.insert("byEventId".into(), serde_json::to_value(by_event_id)?);

        serialize(&out)
    }
}

fn parse_index(raw: &Value) -> Result<(AgentIndexDoc, bool)> {
    let obj = raw
        .as_object()
        .ok_or_else(|| anyhow!("agent index.json: top-level must be an object"))?;

    let mut by_slug: IndexMap<String, SlugEntry> = IndexMap::new();
    let mut needs_migration = false;

    if let Some(by_slug_val) = obj.get("bySlug") {
        let by_slug_obj = by_slug_val
            .as_object()
            .ok_or_else(|| anyhow!("bySlug must be an object"))?;
        for (slug, val) in by_slug_obj {
            match val {
                // Old format: `bySlug[slug] = pubkey` (flat string).
                Value::String(pubkey) => {
                    needs_migration = true;
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                }
                Value::Object(entry) => {
                    let pubkey = entry
                        .get("pubkey")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("bySlug.{slug}.pubkey missing"))?
                        .to_owned();
                    let project_ids = entry
                        .get("projectIds")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey,
                            project_ids,
                        },
                    );
                }
                _ => {
                    return Err(anyhow!("bySlug.{slug} must be string (legacy) or object"));
                }
            }
        }
    }

    let mut by_event_id: IndexMap<String, String> = IndexMap::new();
    if let Some(by_event_id_val) = obj.get("byEventId") {
        let by_event_id_obj = by_event_id_val
            .as_object()
            .ok_or_else(|| anyhow!("byEventId must be an object"))?;
        for (eid, val) in by_event_id_obj {
            let pk = val
                .as_str()
                .ok_or_else(|| anyhow!("byEventId.{eid} must be a string"))?
                .to_owned();
            by_event_id.insert(eid.clone(), pk);
        }
    }

    // Drop legacy `byProject` key — `migrateIndexFormat` ignores it
    // (`AgentStorage.ts:341-361`).
    if obj.contains_key("byProject") {
        needs_migration = true;
    }

    // Detect "extra unknown fields" — TS migration also ignores those, so
    // we treat them as a force-rewrite signal so the on-disk file gets
    // canonicalized to {bySlug, byEventId}.
    for k in obj.keys() {
        if k != "bySlug" && k != "byEventId" && k != "byProject" {
            needs_migration = true;
        }
    }

    Ok((
        AgentIndexDoc {
            by_slug,
            by_event_id,
        },
        needs_migration,
    ))
}

// ───────────────────────── normalization & sanitization ────────────────────

/// `normalizeLoadedAgent` (`AgentStorage.ts:50-61`):
/// - sanitize top-level `telegram` (drop `chatBindings`; collapse to absent
///   if empty)
/// - if absent, fall back to legacy `default.telegram`
/// - sanitize `default` (drop legacy `default.telegram`; collapse to absent
///   if empty)
///
/// Returns `true` if any structural change was made.
fn normalize_loaded_agent(raw: &mut IndexMap<String, Value>) -> bool {
    let mut changed = false;

    // Capture the legacy default.telegram before mutating `default`.
    let legacy_default_telegram = raw
        .get("default")
        .and_then(Value::as_object)
        .and_then(|d| d.get("telegram"))
        .cloned();

    // Sanitize top-level telegram in place.
    let top_was_some = raw.get("telegram").is_some();
    if let Some(t) = raw.get_mut("telegram") {
        if sanitize_telegram_inplace(t) {
            changed = true;
        }
    }
    let top_is_empty = raw
        .get("telegram")
        .map(value_object_is_empty)
        .unwrap_or(false);
    if top_is_empty {
        raw.shift_remove("telegram");
        changed = true;
    }

    // If no top-level telegram (after sanitization), promote the legacy one.
    let has_top = raw.get("telegram").is_some();
    if !has_top {
        if let Some(mut promoted) = legacy_default_telegram.clone() {
            sanitize_telegram_inplace(&mut promoted);
            if !value_object_is_empty(&promoted) {
                raw.insert("telegram".into(), promoted);
                changed = true;
            }
        }
    } else if top_was_some {
        // Top-level was present and survived; legacy default.telegram is
        // dropped below by the default sanitization.
    }

    // Sanitize default block (drop legacy default.telegram).
    let default_changed = if let Some(d) = raw.get_mut("default") {
        sanitize_default_inplace(d)
    } else {
        false
    };
    if default_changed {
        changed = true;
    }
    let default_is_empty = raw
        .get("default")
        .map(value_object_is_empty)
        .unwrap_or(false);
    if default_is_empty {
        raw.shift_remove("default");
        changed = true;
    }

    changed
}

/// `migrateAgentData` (`AgentStorage.ts:253-264`): strip legacy
/// `projectOverrides` and `pmOverrides`. Returns `true` if anything was
/// removed.
fn migrate_agent_data(raw: &mut IndexMap<String, Value>) -> bool {
    let mut mutated = false;
    if raw.shift_remove("projectOverrides").is_some() {
        mutated = true;
    }
    if raw.shift_remove("pmOverrides").is_some() {
        mutated = true;
    }
    mutated
}

/// `sanitizeStoredAgentForPersistence` (`AgentStorage.ts:63-69`).
fn sanitize_for_persistence(raw: &mut IndexMap<String, Value>) {
    if let Some(t) = raw.get_mut("telegram") {
        sanitize_telegram_inplace(t);
    }
    if raw
        .get("telegram")
        .map(value_object_is_empty)
        .unwrap_or(false)
    {
        raw.shift_remove("telegram");
    }

    if let Some(d) = raw.get_mut("default") {
        sanitize_default_inplace(d);
    }
    if raw
        .get("default")
        .map(value_object_is_empty)
        .unwrap_or(false)
    {
        raw.shift_remove("default");
    }
}

/// `sanitizeTelegramConfig` (`AgentStorage.ts:22-34`):
/// - drop `chatBindings` (legacy)
/// - drop keys whose value is JSON `null` (TS `stripUndefinedValues` filters
///   `undefined` — `null` doesn't appear in TS via that path because
///   `JSON.stringify` drops `undefined` before serialization, so on-disk
///   nulls are an edge case we still scrub for safety)
fn sanitize_telegram_inplace(value: &mut Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if obj.shift_remove("chatBindings").is_some() {
        changed = true;
    }
    let null_keys: Vec<String> = obj
        .iter()
        .filter_map(|(k, v)| if v.is_null() { Some(k.clone()) } else { None })
        .collect();
    for k in null_keys {
        obj.shift_remove(&k);
        changed = true;
    }
    changed
}

/// `sanitizeDefaultConfig` (`AgentStorage.ts:36-48`):
/// - drop legacy `default.telegram`
/// - drop keys whose value is JSON null (parallel to telegram sanitizer)
fn sanitize_default_inplace(value: &mut Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if obj.shift_remove("telegram").is_some() {
        changed = true;
    }
    let null_keys: Vec<String> = obj
        .iter()
        .filter_map(|(k, v)| if v.is_null() { Some(k.clone()) } else { None })
        .collect();
    for k in null_keys {
        obj.shift_remove(&k);
        changed = true;
    }
    changed
}

fn value_object_is_empty(v: &Value) -> bool {
    v.as_object()
        .map(serde_json::Map::is_empty)
        .unwrap_or(false)
}

// ───────────────────────── helpers ────────────────────────────────────────

fn agents_dir(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join(AGENTS_DIRNAME)
}

fn index_file_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    agents_dir(base_dir).join(INDEX_FILENAME)
}

fn agent_file_path(base_dir: &std::path::Path, pubkey: &str) -> std::path::PathBuf {
    agents_dir(base_dir).join(format!("{pubkey}.json"))
}

/// Mirror `JSON.stringify(value, null, 2)` exactly:
/// 2-space indent, no trailing newline. Same as `tenex_config::serialize`.
fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize agent")?;
    Ok(buf)
}

// ───────────────────────── pubkey derivation ──────────────────────────────

/// Derive an agent's hex pubkey from its `nsec` field. TS uses
/// `new NDKPrivateKeySigner(nsec).pubkey` (`AgentStorage.ts:156-159`), which
/// accepts **both** bech32 (`nsec1…`) and 64-char hex strings.
pub fn derive_agent_pubkey_from_nsec(nsec: &str) -> Result<String> {
    // Try bech32 first.
    if let Ok(sk) = SecretKey::from_bech32(nsec) {
        return Ok(Keys::new(sk).public_key().to_hex());
    }
    // Fall back to hex.
    let bytes = hex_to_bytes32(nsec)
        .ok_or_else(|| anyhow!("invalid nsec: must be bech32 (`nsec1…`) or 64-char hex string"))?;
    let sk = SecretKey::from_slice(&bytes).map_err(|e| anyhow!("invalid secret key bytes: {e}"))?;
    Ok(Keys::new(sk).public_key().to_hex())
}

fn hex_to_bytes32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = hex_nibble(s.as_bytes()[2 * i])?;
        let lo = hex_nibble(s.as_bytes()[2 * i + 1])?;
        *byte = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Generate a fresh keypair as bech32 nsec. Used by importers and the
/// interactive add-agent flow that mints a new identity.
pub fn generate_nsec_bech32() -> Result<String> {
    use nostr_sdk::ToBech32;
    let keys = Keys::generate();
    keys.secret_key()
        .to_bech32()
        .map_err(|e| anyhow!("encode generated nsec: {e}"))
}

// ───────────────────────── AgentStorage (mutating) ────────────────────────

/// Mirror of the TS `AgentStorage` class (`src/agents/AgentStorage.ts:266`).
///
/// Wraps the index document and exposes the full mutation surface used by
/// `tenex agent` and the doctor flows: `save_agent`, `delete_agent`,
/// `add_agent_to_project`, `remove_agent_from_project`,
/// `cleanup_duplicate_slugs`, `find_alternative_slug_owner`, plus all the
/// read-side index lookups (`get_agent_by_slug`, `get_agent_by_event_id`,
/// `slug_exists`, `get_canonical_active_agents`, `get_all_stored_agents`,
/// `get_index_projects_for_agent`, `get_project_members_from_index`,
/// `rebuild_index`).
///
/// Index mutations are all in-memory; every public mutator writes the index
/// back to disk before returning, matching the TS `await this.saveIndex()`
/// discipline. Unlike TS we do not lazily `loadIndex()` from method bodies —
/// `new()` always loads (or creates an empty index), so `&mut self` methods
/// can mutate `self.index` directly without async re-entry.
pub struct AgentStorage {
    base_dir: std::path::PathBuf,
    index: AgentIndexDoc,
}

impl AgentStorage {
    /// Open (or create) the storage rooted at `<base>/agents/`.
    /// Creates the directory + an empty index file when missing — matches
    /// `initialize()` (`AgentStorage.ts:279-282`).
    pub fn open(base_dir: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(agents_dir(base_dir))
            .with_context(|| format!("create agents dir {}", agents_dir(base_dir).display()))?;
        let index = AgentIndexDoc::load(base_dir)?;
        Ok(Self {
            base_dir: base_dir.to_path_buf(),
            index,
        })
    }

    pub fn index(&self) -> &AgentIndexDoc {
        &self.index
    }

    /// Persist current in-memory index to disk. Public so flows that batch
    /// mutations through `index_mut()` can finalize without going through a
    /// per-mutation method.
    pub fn save_index(&self) -> Result<()> {
        self.index.save(&self.base_dir)
    }

    /// Direct access to the index — useful for tests and for flows that
    /// need to walk slug entries. Mutating it through here bypasses the
    /// invariants enforced by `save_agent`/`delete_agent`/etc.; prefer the
    /// dedicated mutator methods for normal flows.
    pub fn index_mut(&mut self) -> &mut AgentIndexDoc {
        &mut self.index
    }

    pub fn load_agent(&self, pubkey: &str) -> Result<Option<AgentDoc>> {
        AgentDoc::load(&self.base_dir, pubkey)
    }

    /// `slugExists` (`AgentStorage.ts:696-699`).
    pub fn slug_exists(&self, slug: &str) -> bool {
        self.index.by_slug.contains_key(slug)
    }

    /// `getAgentBySlug` (`:706-714`).
    pub fn get_agent_by_slug(&self, slug: &str) -> Result<Option<AgentDoc>> {
        let Some(entry) = self.index.by_slug.get(slug) else {
            return Ok(None);
        };
        AgentDoc::load(&self.base_dir, &entry.pubkey)
    }

    /// `getAgentBySlugForProject` (`:724-737`).
    pub fn get_agent_by_slug_for_project(
        &self,
        slug: &str,
        project_dtag: &str,
    ) -> Result<Option<AgentDoc>> {
        let Some(entry) = self.index.by_slug.get(slug) else {
            return Ok(None);
        };
        if !entry.project_ids.iter().any(|p| p == project_dtag) {
            return Ok(None);
        }
        AgentDoc::load(&self.base_dir, &entry.pubkey)
    }

    /// `getAgentByEventId` (`:742-750`).
    pub fn get_agent_by_event_id(&self, event_id: &str) -> Result<Option<AgentDoc>> {
        let Some(pubkey) = self.index.by_event_id.get(event_id) else {
            return Ok(None);
        };
        AgentDoc::load(&self.base_dir, pubkey)
    }

    /// Collect every dTag where `pubkey` is the canonical slug owner. Mirror
    /// `getIndexProjectsForAgent` (`:761-771`).
    pub fn get_index_projects_for_agent(&self, pubkey: &str) -> Vec<String> {
        let mut seen: IndexMap<String, ()> = IndexMap::new();
        for entry in self.index.by_slug.values() {
            if entry.pubkey != pubkey {
                continue;
            }
            for p in &entry.project_ids {
                seen.insert(p.clone(), ());
            }
        }
        seen.into_keys().collect()
    }

    /// Collect every slug-owner pubkey for `project_dtag`. Mirror
    /// `getProjectMembersFromIndex` (`:780-788`).
    pub fn get_project_members_from_index(&self, project_dtag: &str) -> Vec<String> {
        let mut out = Vec::new();
        for entry in self.index.by_slug.values() {
            if entry.project_ids.iter().any(|p| p == project_dtag) {
                out.push(entry.pubkey.clone());
            }
        }
        out
    }

    /// Mirror `cleanupDuplicateSlugs` (`AgentStorage.ts:488-546`).
    ///
    /// When a new agent is being saved with a slug that already exists,
    /// remove the old agent from projects that overlap with the new agent.
    /// The old agent's slug entry is updated; if it loses all its projects,
    /// the slug entry is removed entirely.
    fn cleanup_duplicate_slugs(
        &mut self,
        slug: &str,
        new_pubkey: &str,
        new_projects: &[String],
    ) -> Result<()> {
        let existing = match self.index.by_slug.get(slug) {
            Some(e) if e.pubkey != new_pubkey => e.clone(),
            _ => return Ok(()),
        };

        let overlapping: Vec<String> = existing
            .project_ids
            .iter()
            .filter(|p| new_projects.iter().any(|n| n == *p))
            .cloned()
            .collect();
        if overlapping.is_empty() {
            return Ok(());
        }

        for project_dtag in &overlapping {
            // Mirror TS: removeAgentFromProject(existing.pubkey, projectDTag).
            // After eviction, drop this project from the existing slug entry.
            self.remove_agent_from_project(&existing.pubkey, project_dtag)?;

            if let Some(entry) = self.index.by_slug.get_mut(slug) {
                entry.project_ids.retain(|p| p != project_dtag);
            }
        }

        // If old agent has no projects left in this slug entry, remove it.
        if let Some(entry) = self.index.by_slug.get(slug) {
            if entry.project_ids.is_empty() && entry.pubkey == existing.pubkey {
                self.index.by_slug.shift_remove(slug);
            }
        }

        Ok(())
    }

    /// Mirror `findAlternativeSlugOwner` (`AgentStorage.ts:432-454`).
    /// Scans every `*.json` (excluding `index.json`) for an active agent
    /// owning the same slug, excluding `exclude_pubkey`.
    fn find_alternative_slug_owner(
        &self,
        slug: &str,
        exclude_pubkey: &str,
    ) -> Result<Option<String>> {
        let dir = agents_dir(&self.base_dir);
        if !dir.exists() {
            return Ok(None);
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name == INDEX_FILENAME {
                continue;
            }
            let pubkey = &name[..name.len() - 5];
            if pubkey == exclude_pubkey {
                continue;
            }
            let Some(agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
                continue;
            };
            if agent.slug() == Some(slug) && agent.is_active() {
                return Ok(Some(pubkey.to_string()));
            }
        }
        Ok(None)
    }

    /// `saveAgent` (`AgentStorage.ts:551-636`).
    ///
    /// Writes the agent file (with persistence sanitization), updates the
    /// `bySlug` index honoring slug-ownership transitions, updates
    /// `byEventId`, and invokes `cleanup_duplicate_slugs` for overlapping
    /// projects. Pubkey is derived from `agent.nsec`.
    pub fn save_agent(&mut self, agent: &AgentDoc) -> Result<String> {
        let nsec = agent
            .nsec()
            .ok_or_else(|| anyhow!("save_agent: missing nsec"))?;
        let slug = agent
            .slug()
            .ok_or_else(|| anyhow!("save_agent: missing slug"))?
            .to_string();
        let pubkey = derive_agent_pubkey_from_nsec(nsec)?;

        // Existing on-disk agent (for slug/eventId diff).
        let existing = AgentDoc::load(&self.base_dir, &pubkey)?;

        // Cleanup any overlapping projects for the same slug owned by another agent.
        let current_projects = self.get_index_projects_for_agent(&pubkey);
        self.cleanup_duplicate_slugs(&slug, &pubkey, &current_projects)?;

        // Persist the agent file (sanitized).
        agent.save(&self.base_dir, &pubkey)?;

        // ── Update bySlug ──
        // Remove old slug entry if slug changed and we owned it.
        if let Some(existing) = &existing {
            if let Some(old_slug) = existing.slug() {
                if old_slug != slug {
                    if let Some(old_entry) = self.index.by_slug.get(old_slug) {
                        if old_entry.pubkey == pubkey {
                            self.index.by_slug.shift_remove(old_slug);
                        }
                    }
                }
            }
        }

        // Remove old eventId if changed and pointed at us.
        let new_event_id = agent.event_id().map(str::to_owned);
        if let Some(existing) = &existing {
            if let Some(old_eid) = existing.event_id() {
                if Some(old_eid) != new_event_id.as_deref()
                    && self.index.by_event_id.get(old_eid).map(String::as_str) == Some(&pubkey)
                {
                    self.index.by_event_id.shift_remove(old_eid);
                }
            }
        }

        if agent.is_active() {
            // Active: claim the slug if we own it or it's unowned. We do NOT
            // overwrite a different active owner — slug takeover for new
            // agents happens in `add_agent_to_project` after cleanup.
            let agent_projects = self.get_index_projects_for_agent(&pubkey);
            let claim = match self.index.by_slug.get(&slug) {
                None => true,
                Some(e) if e.pubkey == pubkey => true,
                _ => false,
            };
            if claim {
                self.index.by_slug.insert(
                    slug.clone(),
                    SlugEntry {
                        pubkey: pubkey.clone(),
                        project_ids: agent_projects,
                    },
                );
            }
        } else {
            // Inactive: handle ownership transition.
            let current = self.index.by_slug.get(&slug).cloned();
            match current {
                Some(e) if e.pubkey == pubkey => {
                    // We were the canonical owner but are now inactive.
                    let alt = self.find_alternative_slug_owner(&slug, &pubkey)?;
                    if let Some(alt) = alt {
                        let alt_projects = self.get_index_projects_for_agent(&alt);
                        self.index.by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: alt,
                                project_ids: alt_projects,
                            },
                        );
                    } else {
                        // Keep the entry pointing at us with refreshed projects.
                        let our_projects = self.get_index_projects_for_agent(&pubkey);
                        self.index.by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: pubkey.clone(),
                                project_ids: our_projects,
                            },
                        );
                    }
                }
                None => {
                    // No owner — claim it for reactivation lookup.
                    self.index.by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                }
                Some(_) => {
                    // Another agent owns the slug — leave it alone.
                }
            }
        }

        // Update byEventId.
        if let Some(eid) = new_event_id {
            self.index.by_event_id.insert(eid, pubkey.clone());
        }

        self.save_index()?;
        Ok(pubkey)
    }

    /// `deleteAgent` (`AgentStorage.ts:652-690`).
    ///
    /// Permanently removes the agent's file and clears the slug/eventId
    /// index entries that pointed at it. Returns `true` if an agent was
    /// found and deleted, `false` if the file was already gone (matching
    /// TS `if (!agent) return;` behavior).
    pub fn delete_agent(&mut self, pubkey: &str) -> Result<bool> {
        let Some(agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };

        let path = agent_file_path(&self.base_dir, pubkey);
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;

        if let Some(slug) = agent.slug() {
            if let Some(entry) = self.index.by_slug.get(slug) {
                if entry.pubkey == pubkey {
                    self.index.by_slug.shift_remove(slug);
                }
            }
        }

        if let Some(eid) = agent.event_id() {
            if self.index.by_event_id.get(eid).map(String::as_str) == Some(pubkey) {
                self.index.by_event_id.shift_remove(eid);
            }
        }

        self.save_index()?;
        Ok(true)
    }

    /// `addAgentToProject` (`AgentStorage.ts:796-829`).
    ///
    /// Reactivates an inactive agent if necessary, evicts other agents that
    /// own the same slug in this project, and writes back the agent file
    /// with `status: "active"`.
    pub fn add_agent_to_project(&mut self, pubkey: &str, project_dtag: &str) -> Result<()> {
        let mut agent = AgentDoc::load(&self.base_dir, pubkey)?
            .ok_or_else(|| anyhow!("Agent {pubkey} not found"))?;
        let slug = agent
            .slug()
            .ok_or_else(|| anyhow!("agent {pubkey} missing slug"))?
            .to_string();

        self.cleanup_duplicate_slugs(&slug, pubkey, &[project_dtag.to_string()])?;

        // Update bySlug — last writer claims slug ownership.
        match self.index.by_slug.get_mut(&slug) {
            Some(entry) if entry.pubkey == pubkey => {
                if !entry.project_ids.iter().any(|p| p == project_dtag) {
                    entry.project_ids.push(project_dtag.to_string());
                }
            }
            _ => {
                self.index.by_slug.insert(
                    slug.clone(),
                    SlugEntry {
                        pubkey: pubkey.to_string(),
                        project_ids: vec![project_dtag.to_string()],
                    },
                );
            }
        }

        // Reactivate.
        agent
            .raw_mut()
            .insert("status".into(), Value::String("active".into()));
        self.save_agent(&agent)?;
        Ok(())
    }

    /// `removeAgentFromProject` (`AgentStorage.ts:895-916`).
    pub fn remove_agent_from_project(&mut self, pubkey: &str, project_dtag: &str) -> Result<()> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(());
        };
        let Some(slug) = agent.slug().map(str::to_owned) else {
            return Ok(());
        };

        if let Some(entry) = self.index.by_slug.get_mut(&slug) {
            if entry.pubkey == pubkey {
                entry.project_ids.retain(|p| p != project_dtag);
            }
        }

        let remaining = self.get_index_projects_for_agent(pubkey);
        let new_status = if remaining.is_empty() {
            "inactive"
        } else {
            "active"
        };
        agent
            .raw_mut()
            .insert("status".into(), Value::String(new_status.into()));
        self.save_agent(&agent)?;
        Ok(())
    }

    /// `getCanonicalActiveAgents` (`AgentStorage.ts:1020-1035`).
    pub fn get_canonical_active_agents(&self) -> Result<Vec<AgentDoc>> {
        let mut out = Vec::new();
        for entry in self.index.by_slug.values() {
            let Some(agent) = AgentDoc::load(&self.base_dir, &entry.pubkey)? else {
                continue;
            };
            if agent.is_active() {
                out.push(agent);
            }
        }
        Ok(out)
    }

    /// `getAllStoredAgents` (`AgentStorage.ts:1044-1060`).
    /// Includes inactive + duplicates. File order is the OS readdir order.
    pub fn get_all_stored_agents(&self) -> Result<Vec<(String, AgentDoc)>> {
        let dir = agents_dir(&self.base_dir);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name == INDEX_FILENAME {
                continue;
            }
            let pubkey = name[..name.len() - 5].to_string();
            if let Some(agent) = AgentDoc::load(&self.base_dir, &pubkey)? {
                out.push((pubkey, agent));
            }
        }
        Ok(out)
    }

    /// Mirror `updateInferredCategory` (`AgentStorage.ts:920-934`).
    ///
    /// Loads the agent, sets the `inferredCategory` field to the
    /// canonical kebab-case literal, and calls [`Self::save_agent`] (which
    /// applies the persistence sanitiser + index updates). Returns
    /// `Ok(false)` when the agent file is missing — matches TS
    /// `if (!agent) { logger.warn(...); return false; }` at `:921-925`.
    ///
    /// The TS API stores the category as a string literal. Taking
    /// [`crate::store::role_categories::AgentCategory`] here makes it
    /// impossible for the caller to write a stale literal — the enum is
    /// the only spelling on disk.
    pub fn update_inferred_category(
        &mut self,
        pubkey: &str,
        inferred: crate::store::role_categories::AgentCategory,
    ) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        agent.raw_mut().insert(
            "inferredCategory".into(),
            Value::String(inferred.as_str().to_owned()),
        );
        self.save_agent(&agent)?;
        Ok(true)
    }

    /// Mirror `updateAgentTelegramConfig` (`AgentStorage.ts:996-1012`).
    ///
    /// `Some(config)` → write a sanitized telegram block; `None` → drop
    /// the block entirely (i.e. disable the per-agent bot). Either way
    /// runs through `save_agent` so the persistence sanitiser collapses
    /// empties + reapplies index updates. Returns `Ok(false)` when the
    /// agent file is missing — matches TS `if (!agent) return false`.
    pub fn update_agent_telegram_config(
        &mut self,
        pubkey: &str,
        config: Option<&TelegramAgentConfig>,
    ) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        match config {
            None => {
                agent.raw_mut().shift_remove("telegram");
            }
            Some(c) => {
                let mut block = serde_json::Map::new();
                block.insert("botToken".into(), Value::String(c.bot_token.clone()));
                if let Some(b) = c.allow_dms {
                    block.insert("allowDMs".into(), Value::Bool(b));
                }
                if let Some(u) = &c.api_base_url {
                    block.insert("apiBaseUrl".into(), Value::String(u.clone()));
                }
                if let Some(b) = c.publish_reasoning_to_telegram {
                    block.insert("publishReasoningToTelegram".into(), Value::Bool(b));
                }
                if let Some(b) = c.publish_conversation_to_telegram {
                    block.insert("publishConversationToTelegram".into(), Value::Bool(b));
                }
                agent
                    .raw_mut()
                    .insert("telegram".into(), Value::Object(block));
            }
        }
        self.save_agent(&agent)?;
        Ok(true)
    }

    /// `rebuildIndex` (`AgentStorage.ts:374-422`).
    ///
    /// Rebuilds `bySlug` and `byEventId` by scanning every agent file.
    /// Active agents take precedence for slug ownership; if all agents with
    /// a slug are inactive, the first one encountered wins. Project
    /// membership lists are reset to empty (matching TS — they're populated
    /// by subsequent `add_agent_to_project` calls).
    pub fn rebuild_index(&mut self) -> Result<()> {
        let dir = agents_dir(&self.base_dir);
        let mut by_slug: IndexMap<String, SlugEntry> = IndexMap::new();
        let mut by_event_id: IndexMap<String, String> = IndexMap::new();
        let mut active_owners: indexmap::IndexSet<String> = indexmap::IndexSet::new();

        if dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !name.ends_with(".json") || name == INDEX_FILENAME {
                    continue;
                }
                let pubkey = name[..name.len() - 5].to_string();
                let Some(agent) = AgentDoc::load(&self.base_dir, &pubkey)? else {
                    continue;
                };
                let Some(slug) = agent.slug().map(str::to_owned) else {
                    continue;
                };
                let active = agent.is_active();

                let existing = by_slug.get(&slug).cloned();
                if let Some(existing) = existing {
                    if existing.pubkey != pubkey && active && !active_owners.contains(&slug) {
                        by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: pubkey.clone(),
                                project_ids: Vec::new(),
                            },
                        );
                        active_owners.insert(slug.clone());
                    }
                } else {
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                    if active {
                        active_owners.insert(slug.clone());
                    }
                }

                if let Some(eid) = agent.event_id() {
                    by_event_id.insert(eid.to_owned(), pubkey.clone());
                }
            }
        }

        self.index = AgentIndexDoc {
            by_slug,
            by_event_id,
        };
        self.save_index()?;
        Ok(())
    }
}

/// Validate an agent's pubkey by re-deriving from `nsec`. Convenience
/// wrapper for callers that already have a parsed `AgentDoc`.
pub fn pubkey_for(agent: &AgentDoc) -> Result<String> {
    let nsec = agent.nsec().ok_or_else(|| anyhow!("missing nsec"))?;
    derive_agent_pubkey_from_nsec(nsec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-agent-storage-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_file(path: &std::path::Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    // ─────────── AgentIndexDoc ───────────

    #[test]
    fn index_load_missing_returns_empty() {
        let base = unique_temp();
        let doc = AgentIndexDoc::load(&base).unwrap();
        assert!(doc.by_slug().is_empty());
        assert!(doc.by_event_id().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn index_round_trip_canonical_is_byte_identical() {
        let base = unique_temp();
        let canonical = br#"{
  "bySlug": {
    "alpha": {
      "pubkey": "aaaa",
      "projectIds": [
        "P1"
      ]
    },
    "beta": {
      "pubkey": "bbbb",
      "projectIds": []
    }
  },
  "byEventId": {
    "evt1": "aaaa"
  }
}"#;
        write_file(&index_file_path(&base), canonical);
        let doc = AgentIndexDoc::load(&base).unwrap();
        let bytes = doc.serialize_bytes().unwrap();
        assert_eq!(
            bytes.as_slice(),
            canonical.as_slice(),
            "byte-identical roundtrip"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn index_legacy_string_format_migrates() {
        // Source: `migrateIndexFormat` at `AgentStorage.ts:341-361`.
        let base = unique_temp();
        let legacy = br#"{
  "bySlug": {
    "alpha": "aaaa",
    "beta": "bbbb"
  },
  "byEventId": {}
}"#;
        write_file(&index_file_path(&base), legacy);
        let doc = AgentIndexDoc::load(&base).unwrap();
        assert_eq!(doc.by_slug().len(), 2);
        assert_eq!(doc.by_slug().get("alpha").unwrap().pubkey, "aaaa");
        assert_eq!(
            doc.by_slug().get("alpha").unwrap().project_ids,
            Vec::<String>::new()
        );
        // Disk should now be canonicalized.
        let on_disk = std::fs::read(index_file_path(&base)).unwrap();
        assert!(std::str::from_utf8(&on_disk)
            .unwrap()
            .contains("\"projectIds\""));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn index_legacy_byproject_field_is_dropped() {
        let base = unique_temp();
        let legacy = br#"{
  "bySlug": {
    "alpha": {
      "pubkey": "aaaa",
      "projectIds": []
    }
  },
  "byEventId": {},
  "byProject": {
    "P1": ["aaaa"]
  }
}"#;
        write_file(&index_file_path(&base), legacy);
        let doc = AgentIndexDoc::load(&base).unwrap();
        assert_eq!(doc.by_slug().len(), 1);
        let on_disk = String::from_utf8(std::fs::read(index_file_path(&base)).unwrap()).unwrap();
        assert!(
            !on_disk.contains("byProject"),
            "byProject must be stripped on save: {on_disk}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn index_round_trip_real_user_index() {
        // Brutal-verify against the user's actual ~/.tenex/agents/index.json
        // when present. This pin fires only on machines with real data;
        // CI without that file silently passes.
        let real = std::env::var("HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .map(|h| h.join(".tenex/agents/index.json"));
        let Some(real_path) = real else { return };
        if !real_path.exists() {
            return;
        }
        let original = std::fs::read(&real_path).unwrap();
        // Parse the original (mark as canonical if it has no legacy bits).
        let parsed: Value = serde_json::from_slice(&original).unwrap();
        let (doc, needs_migration) = parse_index(&parsed).unwrap();
        if needs_migration {
            // Real file already canonical — but skip the byte-pin if it
            // somehow had legacy fields. The migration test covers that.
            return;
        }
        let regen = doc.serialize_bytes().unwrap();
        assert_eq!(
            regen.as_slice(),
            original.as_slice(),
            "real index.json round-trip diverged"
        );
    }

    // ─────────── AgentDoc ───────────

    #[test]
    fn agent_load_missing_returns_none() {
        let base = unique_temp();
        let doc = AgentDoc::load(&base, "deadbeef").unwrap();
        assert!(doc.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_round_trip_canonical_is_byte_identical() {
        let base = unique_temp();
        let pubkey = "abc123";
        let canonical = br#"{
  "nsec": "nsec1example",
  "slug": "tester",
  "name": "Tester",
  "role": "thinker",
  "instructions": "be careful",
  "useCriteria": "always",
  "status": "active",
  "default": {
    "skills": [
      "write-access"
    ]
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        // Re-save and compare bytes.
        doc.save(&base, pubkey).unwrap();
        let on_disk = std::fs::read(agent_file_path(&base, pubkey)).unwrap();
        assert_eq!(on_disk.as_slice(), canonical.as_slice());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_load_drops_project_overrides_and_writes_back() {
        // Source: `migrateAgentData` (`AgentStorage.ts:253-264`).
        let base = unique_temp();
        let pubkey = "deadbeef";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "projectOverrides": {
    "P1": {}
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(!doc.raw.contains_key("projectOverrides"));
        // Should have been written back.
        let on_disk =
            String::from_utf8(std::fs::read(agent_file_path(&base, pubkey)).unwrap()).unwrap();
        assert!(!on_disk.contains("projectOverrides"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_load_drops_pm_overrides() {
        let base = unique_temp();
        let pubkey = "feed";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "pmOverrides": {
    "x": 1
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(!doc.raw.contains_key("pmOverrides"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_save_drops_chat_bindings_from_telegram() {
        // Source: `sanitizeTelegramConfig` (`AgentStorage.ts:22-34`).
        let base = unique_temp();
        let pubkey = "cafe";
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), "x".into());
        raw.insert("slug".into(), "s".into());
        raw.insert("name".into(), "n".into());
        raw.insert("role".into(), "r".into());
        let mut tg = serde_json::Map::new();
        tg.insert("botToken".into(), "tok".into());
        tg.insert("chatBindings".into(), serde_json::json!({"x": 1}));
        raw.insert("telegram".into(), Value::Object(tg));

        let doc = AgentDoc::from_raw(raw);
        doc.save(&base, pubkey).unwrap();

        let on_disk =
            String::from_utf8(std::fs::read(agent_file_path(&base, pubkey)).unwrap()).unwrap();
        assert!(
            !on_disk.contains("chatBindings"),
            "chatBindings must be stripped: {on_disk}"
        );
        assert!(on_disk.contains("botToken"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_load_promotes_legacy_default_telegram_to_top_level() {
        // Source: `normalizeLoadedAgent` (`AgentStorage.ts:50-61`).
        let base = unique_temp();
        let pubkey = "promote";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "default": {
    "skills": ["write-access"],
    "telegram": {
      "botToken": "tok"
    }
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(doc.raw.contains_key("telegram"));
        assert!(
            !doc.raw
                .get("default")
                .and_then(Value::as_object)
                .map(|m| m.contains_key("telegram"))
                .unwrap_or(false),
            "default.telegram must be dropped after promotion"
        );
        // botToken must be preserved.
        let tg = doc.raw.get("telegram").unwrap().as_object().unwrap();
        assert_eq!(tg.get("botToken").and_then(Value::as_str), Some("tok"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_load_strips_empty_default_block() {
        let base = unique_temp();
        let pubkey = "empty";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "default": {}
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(!doc.raw.contains_key("default"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_load_strips_empty_telegram_block() {
        let base = unique_temp();
        let pubkey = "emptytel";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "telegram": {}
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(!doc.raw.contains_key("telegram"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_top_level_telegram_wins_over_legacy_default_telegram() {
        // If both top-level telegram and default.telegram exist, the
        // top-level wins (`normalizeLoadedAgent` `:56-58`: `topLevelTelegram
        // ?? legacyDefaultTelegram`).
        let base = unique_temp();
        let pubkey = "doubletel";
        let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "telegram": {
    "botToken": "TOP"
  },
  "default": {
    "telegram": {
      "botToken": "LEGACY"
    }
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), legacy);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        let tg = doc.raw.get("telegram").unwrap().as_object().unwrap();
        assert_eq!(tg.get("botToken").and_then(Value::as_str), Some("TOP"));
        // default block should be gone (only had legacy telegram).
        assert!(!doc.raw.contains_key("default"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_is_active_treats_missing_status_as_active() {
        // Source: `isAgentActive` (`AgentStorage.ts:169-174`).
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), "x".into());
        raw.insert("slug".into(), "s".into());
        raw.insert("name".into(), "n".into());
        raw.insert("role".into(), "r".into());
        let doc = AgentDoc::from_raw(raw);
        assert!(doc.is_active());
    }

    #[test]
    fn agent_is_active_only_inactive_string_means_inactive() {
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("status".into(), Value::String("inactive".into()));
        let doc = AgentDoc::from_raw(raw);
        assert!(!doc.is_active());

        let mut raw2 = IndexMap::<String, Value>::new();
        raw2.insert("status".into(), Value::String("active".into()));
        let doc2 = AgentDoc::from_raw(raw2);
        assert!(doc2.is_active());

        // Garbage status is treated as active (TS code's `=== "inactive"`).
        let mut raw3 = IndexMap::<String, Value>::new();
        raw3.insert("status".into(), Value::String("paused".into()));
        let doc3 = AgentDoc::from_raw(raw3);
        assert!(doc3.is_active());
    }

    #[test]
    fn agent_typed_accessors_match_raw() {
        let base = unique_temp();
        let pubkey = "typed";
        let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "eventId": "evt1",
  "status": "active"
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert_eq!(doc.nsec(), Some("nsec1foo"));
        assert_eq!(doc.slug(), Some("alpha"));
        assert_eq!(doc.name(), Some("Alpha"));
        assert_eq!(doc.role(), Some("thinker"));
        assert_eq!(doc.event_id(), Some("evt1"));
        assert_eq!(doc.status(), Some("active"));
        assert!(doc.is_active());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_category_accessors_resolve_through_role_categories() {
        use crate::store::role_categories::AgentCategory;
        let base = unique_temp();
        let pubkey = "categorised";
        let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "category": "domain-expert",
  "inferredCategory": "worker",
  "description": "small philosopher",
  "instructions": "be careful",
  "useCriteria": "always"
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert_eq!(doc.category(), Some(AgentCategory::DomainExpert));
        assert_eq!(doc.inferred_category(), Some(AgentCategory::Worker));
        assert_eq!(doc.description(), Some("small philosopher"));
        assert_eq!(doc.instructions(), Some("be careful"));
        assert_eq!(doc.use_criteria(), Some("always"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_telegram_config_accessor_extracts_typed_block() {
        let base = unique_temp();
        let pubkey = "tgagent";
        let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "telegram": {
    "botToken": "1234:abcd",
    "allowDMs": true,
    "apiBaseUrl": "https://api.test"
  }
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        let tg = doc.telegram_config().unwrap();
        assert_eq!(tg.bot_token, "1234:abcd");
        assert_eq!(tg.allow_dms, Some(true));
        assert_eq!(tg.api_base_url.as_deref(), Some("https://api.test"));
        assert!(tg.publish_reasoning_to_telegram.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_telegram_config_returns_none_when_block_absent() {
        let base = unique_temp();
        let pubkey = "no-tg";
        let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker"
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert!(doc.telegram_config().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_agent_telegram_config_writes_and_clears() {
        // Use a real agent so storage's slug ownership invariants hold.
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let nsec = generate_nsec_bech32().unwrap();
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), Value::String(nsec));
        raw.insert("slug".into(), Value::String("alpha".into()));
        raw.insert("name".into(), Value::String("Alpha".into()));
        raw.insert("role".into(), Value::String("thinker".into()));
        let pk = storage.save_agent(&AgentDoc::from_raw(raw)).unwrap();

        // Set a config.
        let cfg = TelegramAgentConfig {
            bot_token: "tok".into(),
            allow_dms: Some(true),
            api_base_url: None,
            publish_reasoning_to_telegram: None,
            publish_conversation_to_telegram: None,
        };
        let written = storage
            .update_agent_telegram_config(&pk, Some(&cfg))
            .unwrap();
        assert!(written);
        let agent = AgentDoc::load(&base, &pk).unwrap().unwrap();
        assert_eq!(agent.telegram_config().unwrap().bot_token, "tok");

        // Clear it.
        let cleared = storage.update_agent_telegram_config(&pk, None).unwrap();
        assert!(cleared);
        let agent = AgentDoc::load(&base, &pk).unwrap().unwrap();
        assert!(agent.telegram_config().is_none());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_agent_telegram_config_returns_false_for_missing_agent() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let result = storage
            .update_agent_telegram_config("notfound", None)
            .unwrap();
        assert!(!result);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_category_unknown_resolves_to_none() {
        // Legacy values like "executor" / "expert" / "advisor" are
        // mentioned in storage.ts as auto-migrated. The strict resolver
        // returns None for them; the caller decides whether to migrate
        // or leave the on-disk value alone.
        let base = unique_temp();
        let pubkey = "legacy";
        let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "category": "executor"
}"#;
        write_file(&agent_file_path(&base, pubkey), canonical);
        let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
        assert_eq!(doc.category(), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_round_trip_real_user_files() {
        // Brutal-verify pin: every real agent file in ~/.tenex/agents/ must
        // round-trip byte-identically through load → save (provided the file
        // has no legacy fields that would trigger a rewrite).
        let real_dir = std::env::var("HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .map(|h| h.join(".tenex/agents"));
        let Some(real_dir) = real_dir else { return };
        if !real_dir.exists() {
            return;
        }

        let mut checked = 0usize;
        let mut skipped_legacy = 0usize;
        for entry in std::fs::read_dir(&real_dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name == "index.json" {
                continue;
            }
            // Try to parse and round-trip.
            let original = std::fs::read(&path).unwrap();
            let mut raw: IndexMap<String, Value> = match serde_json::from_slice(&original) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let normalized = normalize_loaded_agent(&mut raw);
            let migrated = migrate_agent_data(&mut raw);
            if normalized || migrated {
                skipped_legacy += 1;
                continue;
            }
            // Now sanitize-on-save (which on a clean file should be no-op).
            sanitize_for_persistence(&mut raw);
            let regen = serialize(&raw).unwrap();
            // Some user files have a trailing `\n` from external editors —
            // TS `JSON.stringify` does not emit one, so neither do we.
            // Strip any single trailing `\n` from the original before the
            // byte-identical pin so we don't false-flag cosmetic editor
            // whitespace.
            let mut original_normalized = original.clone();
            if original_normalized.last() == Some(&b'\n') {
                original_normalized.pop();
            }
            assert_eq!(
                regen.as_slice(),
                original_normalized.as_slice(),
                "round-trip diverged for {}",
                path.display()
            );
            checked += 1;
        }
        eprintln!(
            "agent_round_trip_real_user_files: checked={checked} legacy_skipped={skipped_legacy}"
        );
    }

    // ─────────── AgentStorage mutation surface ───────────

    /// Build a minimal in-memory `AgentDoc` for tests. Returns
    /// `(doc, expected_pubkey)`.
    fn fixture_agent(slug: &str) -> (AgentDoc, String) {
        let nsec = generate_nsec_bech32().unwrap();
        let pubkey = derive_agent_pubkey_from_nsec(&nsec).unwrap();
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), Value::String(nsec));
        raw.insert("slug".into(), Value::String(slug.into()));
        raw.insert("name".into(), Value::String(format!("{slug}-name")));
        raw.insert("role".into(), Value::String("thinker".into()));
        raw.insert("status".into(), Value::String("active".into()));
        (AgentDoc::from_raw(raw), pubkey)
    }

    #[test]
    fn derive_pubkey_from_bech32_nsec_round_trips() {
        let nsec = generate_nsec_bech32().unwrap();
        assert!(nsec.starts_with("nsec1"));
        let pubkey = derive_agent_pubkey_from_nsec(&nsec).unwrap();
        assert_eq!(pubkey.len(), 64, "pubkey must be 64-char hex: {pubkey}");
        assert!(pubkey.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn derive_pubkey_accepts_hex_nsec() {
        // TS NDKPrivateKeySigner accepts both bech32 and hex.
        let bech = generate_nsec_bech32().unwrap();
        let from_bech = derive_agent_pubkey_from_nsec(&bech).unwrap();
        // Convert bech32 → hex via SecretKey, and feed back as hex.
        let sk = SecretKey::from_bech32(&bech).unwrap();
        let hex_nsec: String = sk
            .as_secret_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let from_hex = derive_agent_pubkey_from_nsec(&hex_nsec).unwrap();
        assert_eq!(from_bech, from_hex);
    }

    #[test]
    fn save_agent_writes_file_and_updates_index() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, expected_pubkey) = fixture_agent("alpha");
        let pubkey = storage.save_agent(&doc).unwrap();
        assert_eq!(pubkey, expected_pubkey);
        assert!(agent_file_path(&base, &pubkey).exists());
        // Index updated.
        assert_eq!(
            storage.index().lookup_pubkey_by_slug("alpha"),
            Some(pubkey.as_str())
        );
        // Re-loadable.
        let loaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        assert_eq!(loaded.slug(), Some("alpha"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn save_agent_persists_event_id_index() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (mut doc, _) = fixture_agent("alpha");
        doc.raw_mut()
            .insert("eventId".into(), Value::String("evt-1".into()));
        let pubkey = storage.save_agent(&doc).unwrap();
        assert_eq!(
            storage.index().lookup_pubkey_by_event_id("evt-1"),
            Some(pubkey.as_str())
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn save_agent_renames_slug_drops_old_index_entry() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (mut doc, _) = fixture_agent("alpha");
        let pubkey = storage.save_agent(&doc).unwrap();
        // Rename the slug — old entry must vanish.
        doc.raw_mut()
            .insert("slug".into(), Value::String("beta".into()));
        storage.save_agent(&doc).unwrap();
        assert!(storage.index().lookup_pubkey_by_slug("alpha").is_none());
        assert_eq!(
            storage.index().lookup_pubkey_by_slug("beta"),
            Some(pubkey.as_str())
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn delete_agent_removes_file_and_index_entries() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (mut doc, _) = fixture_agent("alpha");
        doc.raw_mut()
            .insert("eventId".into(), Value::String("evt-1".into()));
        let pubkey = storage.save_agent(&doc).unwrap();

        let deleted = storage.delete_agent(&pubkey).unwrap();
        assert!(deleted);
        assert!(!agent_file_path(&base, &pubkey).exists());
        assert!(storage.index().lookup_pubkey_by_slug("alpha").is_none());
        assert!(storage.index().lookup_pubkey_by_event_id("evt-1").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn delete_agent_returns_false_for_missing() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let result = storage.delete_agent("not-real").unwrap();
        assert!(!result);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn add_agent_to_project_appends_project_id() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, _) = fixture_agent("alpha");
        let pubkey = storage.save_agent(&doc).unwrap();
        storage.add_agent_to_project(&pubkey, "P1").unwrap();
        let entry = storage.index().by_slug.get("alpha").unwrap();
        assert_eq!(entry.project_ids, vec!["P1".to_string()]);
        // Idempotent — a second add does not duplicate.
        storage.add_agent_to_project(&pubkey, "P1").unwrap();
        let entry = storage.index().by_slug.get("alpha").unwrap();
        assert_eq!(entry.project_ids, vec!["P1".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn add_agent_reactivates_inactive_agent() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (mut doc, _) = fixture_agent("alpha");
        doc.raw_mut()
            .insert("status".into(), Value::String("inactive".into()));
        let pubkey = storage.save_agent(&doc).unwrap();
        storage.add_agent_to_project(&pubkey, "P1").unwrap();
        let reloaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        assert!(reloaded.is_active(), "agent should reactivate on add");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_agent_from_last_project_marks_inactive() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, _) = fixture_agent("alpha");
        let pubkey = storage.save_agent(&doc).unwrap();
        storage.add_agent_to_project(&pubkey, "P1").unwrap();
        storage.add_agent_to_project(&pubkey, "P2").unwrap();
        storage.remove_agent_from_project(&pubkey, "P1").unwrap();
        let agent = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        assert!(agent.is_active(), "still in P2");
        storage.remove_agent_from_project(&pubkey, "P2").unwrap();
        let agent = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        assert!(!agent.is_active(), "no projects → inactive");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn cleanup_duplicate_slugs_evicts_old_owner_from_overlap() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc1, _) = fixture_agent("shared");
        let pk1 = storage.save_agent(&doc1).unwrap();
        storage.add_agent_to_project(&pk1, "P1").unwrap();

        // A second agent with same slug enters P1.
        let (doc2, _) = fixture_agent("shared");
        let pk2 = storage.save_agent(&doc2).unwrap();
        storage.add_agent_to_project(&pk2, "P1").unwrap();

        // pk2 should now own the slug; pk1 must be inactive after eviction.
        let entry = storage.index().by_slug.get("shared").unwrap();
        assert_eq!(entry.pubkey, pk2);
        let pk1_agent = AgentDoc::load(&base, &pk1).unwrap().unwrap();
        assert!(
            !pk1_agent.is_active(),
            "pk1 evicted from P1, no other projects"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn slug_exists_returns_true_for_any_recorded_slug() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, _) = fixture_agent("alpha");
        storage.save_agent(&doc).unwrap();
        assert!(storage.slug_exists("alpha"));
        assert!(!storage.slug_exists("beta"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn get_agent_by_slug_returns_loaded_doc() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, _) = fixture_agent("alpha");
        storage.save_agent(&doc).unwrap();
        let got = storage.get_agent_by_slug("alpha").unwrap().unwrap();
        assert_eq!(got.slug(), Some("alpha"));
        assert!(storage.get_agent_by_slug("missing").unwrap().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn get_agent_by_slug_for_project_filters_correctly() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (doc, _) = fixture_agent("alpha");
        let pk = storage.save_agent(&doc).unwrap();
        storage.add_agent_to_project(&pk, "P1").unwrap();
        assert!(storage
            .get_agent_by_slug_for_project("alpha", "P1")
            .unwrap()
            .is_some());
        assert!(storage
            .get_agent_by_slug_for_project("alpha", "P2")
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn get_agent_by_event_id_returns_loaded_doc() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (mut doc, _) = fixture_agent("alpha");
        doc.raw_mut()
            .insert("eventId".into(), Value::String("evt-7".into()));
        storage.save_agent(&doc).unwrap();
        let got = storage.get_agent_by_event_id("evt-7").unwrap().unwrap();
        assert_eq!(got.event_id(), Some("evt-7"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn get_canonical_active_agents_skips_inactive() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (a1, _) = fixture_agent("a1");
        let (mut a2, _) = fixture_agent("a2");
        a2.raw_mut()
            .insert("status".into(), Value::String("inactive".into()));
        storage.save_agent(&a1).unwrap();
        storage.save_agent(&a2).unwrap();
        let canonical = storage.get_canonical_active_agents().unwrap();
        let slugs: Vec<_> = canonical
            .iter()
            .map(|d| d.slug().unwrap().to_owned())
            .collect();
        assert_eq!(slugs, vec!["a1".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn get_all_stored_agents_includes_inactive() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let (a1, _) = fixture_agent("a1");
        let (mut a2, _) = fixture_agent("a2");
        a2.raw_mut()
            .insert("status".into(), Value::String("inactive".into()));
        storage.save_agent(&a1).unwrap();
        storage.save_agent(&a2).unwrap();
        let all = storage.get_all_stored_agents().unwrap();
        assert_eq!(all.len(), 2);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rebuild_index_recovers_from_missing_index_file() {
        let base = unique_temp();
        // Bootstrap: write two agents through storage.
        let pk_a;
        let pk_b;
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let (a1, _) = fixture_agent("a1");
            let (mut a2, _) = fixture_agent("a2");
            a2.raw_mut()
                .insert("eventId".into(), Value::String("E2".into()));
            pk_a = storage.save_agent(&a1).unwrap();
            pk_b = storage.save_agent(&a2).unwrap();
        }
        // Nuke the index.
        std::fs::remove_file(index_file_path(&base)).unwrap();
        // Re-open and rebuild.
        let mut storage = AgentStorage::open(&base).unwrap();
        assert!(
            storage.index().by_slug.is_empty(),
            "fresh open w/o index = empty"
        );
        storage.rebuild_index().unwrap();
        let pks: std::collections::HashSet<_> = storage
            .index()
            .by_slug
            .values()
            .map(|e| e.pubkey.clone())
            .collect();
        assert!(pks.contains(&pk_a));
        assert!(pks.contains(&pk_b));
        assert_eq!(
            storage.index().lookup_pubkey_by_event_id("E2"),
            Some(pk_b.as_str())
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn save_inactive_agent_reassigns_slug_to_active_alternative() {
        // Source: `findAlternativeSlugOwner` (`AgentStorage.ts:432-454`)
        // + the inactive branch of saveAgent (`:605-628`).
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();

        // Active agent A owns slug "shared" with no projects.
        let (doc_a, _) = fixture_agent("shared");
        let pk_a = storage.save_agent(&doc_a).unwrap();

        // Active agent B also has slug "shared" but isn't in the index yet —
        // since A was saved first, it owns. To get B into the index without
        // evicting A, we simulate the scenario: write B's file directly.
        let (doc_b, pk_b_expected) = fixture_agent("shared");
        doc_b.save(&base, &pk_b_expected).unwrap();
        let pk_b = pk_b_expected;

        // Now mark A inactive — the alternative owner should be discovered.
        let mut a_inactive = AgentDoc::load(&base, &pk_a).unwrap().unwrap();
        a_inactive
            .raw_mut()
            .insert("status".into(), Value::String("inactive".into()));
        storage.save_agent(&a_inactive).unwrap();

        let entry = storage.index().by_slug.get("shared").unwrap();
        assert_eq!(entry.pubkey, pk_b, "slug ownership should pass to active B");
        std::fs::remove_dir_all(&base).ok();
    }
}

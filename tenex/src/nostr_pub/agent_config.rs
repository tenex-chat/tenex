//! kind:0 agent profile — identity and capability announcement, signed by the
//! agent itself.
//!
//! Parallel to `project_status.rs`, but signed by the *agent* (not the
//! backend). Combines the standard Nostr kind:0 profile fields with
//! TENEX-specific capability tags so a single replaceable event carries both
//! the agent's human-readable identity and its full runtime configuration.
//!
//! Event shape:
//!
//! ```text
//! kind    = 0
//! content = JSON { "name": "<agent_name>", "about": "<description>" }
//! tags    = ["slug", "<agent_slug>"]
//!         + ["use-criteria", "<text>"]                    # when set
//!         + ["p", "<backend_pubkey_hex>"]
//!         + ["backend", "<name>"]                        # when set
//!         + ["model", "<slug>"]                           # available
//!           or ["model", "<slug>", "active"]              # selected
//!         + ["skill", "<id>"]                             # available
//!           or ["skill", "<id>", "active"]                # enabled
//!         + ["mcp", "<slug>", "active"]                   # configured = active
//! ```
//!
//! Skills emitted here are every *globally* reachable skill for this agent —
//! the non-project sources from `tenex-agent`'s skill loader: built-in,
//! agent-home, and user-global. Project-shared skills
//! (`{project_path}/.agents/skills/`) are deliberately excluded here; they
//! are advertised on the per-project kind:24010 event instead.
//!
//! Models = every config name in the project's `LlmsDoc`. Active marker is
//! placed on the entry that matches `agent.default_config_json["model"]`
//! when one is set.
//!
//! MCPs come from `agent.mcp_servers_json` keys. Every configured MCP is
//! considered active (there is no notion of an MCP being "available but not
//! enabled" today — registering an MCP server *is* enabling it).
//!
//! Tags within each group are sorted by their primary identifier for
//! deterministic event content (same convention as `project_status.rs`).

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Kind, PublicKey, Tag, TagKind};
use serde_json::{json, Value};

use crate::store::llms::LlmsDoc;
use tenex_project::{signer::signer_for, Agent};

/// Result of inspecting the agent's `default_config_json` blob.
struct ActiveConfig {
    model: Option<String>,
    skills: HashSet<String>,
}

/// Truncated pubkey used by the on-disk skill-discovery layout for the
/// agent-home source. Mirrors `tenex_agent::skills::short_pubkey`.
fn short_pubkey(pubkey: &str) -> &str {
    if pubkey.len() >= 8 {
        &pubkey[..8]
    } else {
        pubkey
    }
}

/// Enumerate skill IDs installed in the agent's own home directory
/// (`{base_dir}/home/<short_pubkey>/skills`). These are the only skills
/// advertised on the agent's kind:0 profile — shared skills (built-in,
/// user-global) and project-scoped skills are advertised on kind:24010.
fn list_agent_skill_ids(agent_pubkey: &str, base_dir: &Path) -> Vec<String> {
    let dir = base_dir
        .join("home")
        .join(short_pubkey(agent_pubkey))
        .join("skills");
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        if let Some(id) = path.file_name().and_then(|n| n.to_str()) {
            seen.insert(id.to_string());
        }
    }
    seen.into_iter().collect()
}

/// Pull `model` + `skills` out of the agent's `default_config_json` blob.
fn parse_active_config(agent: &Agent) -> ActiveConfig {
    let mut active = ActiveConfig {
        model: None,
        skills: HashSet::new(),
    };
    let Some(raw) = agent.default_config_json.as_deref() else {
        return active;
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return active;
    };
    if let Some(model) = map.get("model").and_then(Value::as_str) {
        if !model.is_empty() {
            active.model = Some(model.to_string());
        }
    }
    if let Some(Value::Array(skills)) = map.get("skills") {
        for skill in skills {
            if let Some(s) = skill.as_str() {
                active.skills.insert(s.to_string());
            }
        }
    }
    active
}

/// Configured MCP server slugs (every key in `mcp_servers_json` — every
/// configured MCP is active by definition today).
fn mcp_server_slugs(agent: &Agent) -> Vec<String> {
    let Some(raw) = agent.mcp_servers_json.as_deref() else {
        return Vec::new();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut slugs: Vec<String> = map.keys().cloned().collect();
    slugs.sort();
    slugs
}

/// Build (and sign) a kind:0 profile event for one agent.
///
/// - `agent`            — the agent being announced.
/// - `backend_pubkey`   — the backend that runs this agent (emitted as `p`).
/// - `base_dir`         — TENEX base dir (`~/.tenex`); used to find skills.
/// - `llms`             — the project's LLM doc (provides the model universe).
/// - `backend_name`     — optional human-readable backend name (emitted as
///                        `["backend", "<name>"]` when present).
pub async fn build_agent_config_event(
    agent: &Agent,
    backend_pubkey: &PublicKey,
    base_dir: &Path,
    llms: &LlmsDoc,
    backend_name: Option<&str>,
) -> Result<Event> {
    let signer = signer_for(agent).map_err(|e| anyhow!("resolve signer for agent: {e}"))?;
    let signer_pubkey = signer
        .pubkey()
        .await
        .map_err(|e| anyhow!("resolve agent signer pubkey: {e}"))?;

    // Pubkey safety check: refuse to publish a kind:0 for a key the project's
    // agent set does not actually own. If `signer_for` resolved to a different
    // key (mis-edited `signer_ref`, swapped bunker URI, etc.), the event would
    // still be cryptographically valid but would announce capabilities under a
    // pubkey that isn't part of this project — corrupting downstream state.
    if signer_pubkey != agent.pubkey {
        return Err(anyhow!(
            "agent {} signer mismatch: signer pk = {}, agent pk = {}",
            agent.slug,
            signer_pubkey,
            agent.pubkey,
        ));
    }

    let mut active = parse_active_config(agent);
    // Active-model fallback: when the agent has no explicit `model` in its
    // `default_config_json`, the runtime falls back to the project's
    // `LlmsDoc::default_config()`. Mirror that here so the published kind:0
    // marks the right model as `active` instead of leaving the agent's row
    // model-less in the TUI.
    if active.model.is_none() {
        if let Some(default) = llms.default_config() {
            if !default.is_empty() {
                active.model = Some(default.to_string());
            }
        }
    }
    let mut tags: Vec<Tag> = Vec::new();

    // ["slug", <agent_slug>] — stable machine identifier, also present in
    // the content JSON as the `name` field.
    tags.push(Tag::parse(["slug", agent.slug.as_str()]).map_err(|e| anyhow!("slug tag: {e}"))?);

    // ["use-criteria", <text>] — optional; tells callers when to delegate.
    if let Some(criteria) = agent.use_criteria.as_deref().filter(|s| !s.is_empty()) {
        tags.push(
            Tag::parse(["use-criteria", criteria])
                .map_err(|e| anyhow!("use-criteria tag: {e}"))?,
        );
    }

    // ["p", <backend_pubkey_hex>]
    tags.push(
        Tag::parse(["p", backend_pubkey.to_hex().as_str()]).map_err(|e| anyhow!("p tag: {e}"))?,
    );

    // ["backend", <name>] — optional; present when the operator has configured
    // a human-readable backend profile name in config.json.
    if let Some(name) = backend_name {
        tags.push(
            Tag::parse(["backend", name]).map_err(|e| anyhow!("backend tag: {e}"))?,
        );
    }

    // Models — sorted by config slug; "active" marker on the agent's selection.
    let mut model_names = llms.config_names();
    model_names.sort();
    for slug in model_names {
        let mut vals = vec![slug.clone()];
        if active.model.as_deref() == Some(slug.as_str()) {
            vals.push("active".to_string());
        }
        tags.push(Tag::custom(TagKind::Custom("model".into()), vals));
    }

    // Skills — agent-home only, sorted by id; "active" on those in default_config.
    for id in list_agent_skill_ids(&signer_pubkey, base_dir) {
        let mut vals = vec![id.clone()];
        if active.skills.contains(&id) {
            vals.push("active".to_string());
        }
        tags.push(Tag::custom(TagKind::Custom("skill".into()), vals));
    }

    // MCPs — sorted by slug; every configured MCP is active.
    for slug in mcp_server_slugs(agent) {
        tags.push(Tag::custom(
            TagKind::Custom("mcp".into()),
            [slug, "active".to_string()],
        ));
    }

    // Build kind:0 content: slug as `name` (standard Nostr identity field),
    // description as `about` when present.
    let mut content_map = json!({ "name": agent.slug });
    if let Some(about) = agent.description.as_deref().filter(|s| !s.is_empty()) {
        content_map["about"] = json!(about);
    }
    let content = content_map.to_string();

    let event = signer
        .sign(EventBuilder::new(Kind::Metadata, content).tags(tags))
        .await
        .map_err(|e| anyhow!("sign agent profile event: {e}"))?;

    Ok(event)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use nostr_sdk::{Keys, ToBech32};
    use tenex_project::Agent;

    use super::*;

    const BACKEND_PK_HEX: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";

    fn unique_temp(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-agent-config-{label}-{}-{}-{n}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_skill(parent: &Path, id: &str) {
        let dir = parent.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: test\n---\nbody").unwrap();
    }

    fn load_llms(raw: serde_json::Value) -> LlmsDoc {
        let base = unique_temp("llms");
        fs::write(base.join("llms.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
        let doc = LlmsDoc::load(&base).unwrap();
        fs::remove_dir_all(&base).ok();
        doc
    }

    fn agent_with_signer(
        slug: &str,
        default_cfg: serde_json::Value,
        mcps: serde_json::Value,
    ) -> (Agent, Keys) {
        let keys = Keys::generate();
        let nsec_bech32 = keys.secret_key().to_bech32().unwrap();
        let signer_ref = format!("nsec:{nsec_bech32}");
        let agent = Agent {
            pubkey: keys.public_key().to_hex(),
            slug: slug.into(),
            name: slug.into(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: Some(signer_ref),
            event_id: None,
            status: None,
            default_config_json: Some(default_cfg.to_string()),
            telegram_config_json: None,
            mcp_servers_json: Some(mcps.to_string()),
            is_local: true,
            backend_name: None,
        };
        (agent, keys)
    }

    fn extract<'a>(event: &'a Event, name: &str) -> Vec<Vec<&'a str>> {
        event
            .tags
            .iter()
            .filter_map(|t| {
                let s = t.as_slice();
                if s.first().map(String::as_str) == Some(name) {
                    Some(s.iter().map(String::as_str).collect())
                } else {
                    None
                }
            })
            .collect()
    }

    #[tokio::test]
    async fn build_event_emits_expected_tags_with_active_markers() {
        // Two global skills: one in agent-home (source 2), one in user-global
        // (source 3). Plus a project-shared skill on disk that MUST NOT appear
        // on kind:0 (it belongs on 24010).
        let base_dir = unique_temp("base");
        let project_path = unique_temp("proj");

        // Project-scoped skill that must be excluded from kind:0.
        let project_skills = project_path.join(".agents").join("skills");
        fs::create_dir_all(&project_skills).unwrap();
        write_skill(&project_skills, "project-only");

        // LLM doc with two configs.
        let llms = load_llms(serde_json::json!({
            "configurations": {
                "alpha": { "provider": "mock", "model": "a" },
                "beta":  { "provider": "mock", "model": "b" }
            },
            "default": "alpha"
        }));

        // Agent: model=alpha, skill `home-only` active, MCP `github` configured.
        let (agent, _keys) = agent_with_signer(
            "worker",
            serde_json::json!({ "model": "alpha", "skills": ["home-only"] }),
            serde_json::json!({ "github": { "command": "gh" } }),
        );

        // Source 2: agent-home skills (seed with actual short pubkey).
        let short = &agent.pubkey[..8];
        let agent_home_skills = base_dir.join("home").join(short).join("skills");
        fs::create_dir_all(&agent_home_skills).unwrap();
        write_skill(&agent_home_skills, "home-only");

        let backend_pk = nostr_sdk::PublicKey::from_hex(BACKEND_PK_HEX).unwrap();

        let event = build_agent_config_event(&agent, &backend_pk, &base_dir, &llms, None)
            .await
            .expect("event built");

        // kind:0
        assert_eq!(u16::from(event.kind), 0);
        // slug tag = agent slug
        let slug_tags = extract(&event, "slug");
        assert_eq!(slug_tags, vec![vec!["slug", "worker"]]);
        // content JSON contains name = slug
        let content: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(content["name"], "worker");
        // No d-tag (not a NIP-33 event)
        assert!(extract(&event, "d").is_empty());
        // event signer pubkey is the agent's pubkey
        assert_eq!(event.pubkey.to_hex(), agent.pubkey);
        // p-tag = backend pubkey
        let p_tags = extract(&event, "p");
        assert_eq!(p_tags, vec![vec!["p", BACKEND_PK_HEX]]);

        // model tags: alpha active, beta available
        let m_tags = extract(&event, "model");
        assert!(m_tags.contains(&vec!["model", "alpha", "active"]));
        assert!(m_tags.contains(&vec!["model", "beta"]));

        // skill tags: home-only active. Project-scoped `project-only` MUST NOT
        // appear here — it belongs on the 24010 event.
        let s_tags = extract(&event, "skill");
        assert!(s_tags.contains(&vec!["skill", "home-only", "active"]));
        assert!(
            !s_tags.iter().any(|t| t.get(1) == Some(&"project-only")),
            "project-scoped skill must not appear on kind:0 profile: {s_tags:?}",
        );

        // mcp tag: github active
        let mcp_tags = extract(&event, "mcp");
        assert_eq!(mcp_tags, vec![vec!["mcp", "github", "active"]]);

        // signature must verify
        event.verify().expect("agent-signed event must verify");

        fs::remove_dir_all(&base_dir).ok();
        fs::remove_dir_all(&project_path).ok();
    }

    /// Explicit guard: a skill placed under `{project}/.agents/skills/foo/SKILL.md`
    /// must NOT be advertised on the kind:0 profile (project-scoped → belongs on 24010).
    /// We use a unique skill id so a real `~/.agents/skills/` populated on the
    /// dev machine cannot accidentally satisfy the assertion.
    #[tokio::test]
    async fn build_event_excludes_project_shared_skills() {
        let base_dir = unique_temp("base-excl");
        let project_path = unique_temp("proj-excl");

        // Unique-per-run skill id so it cannot collide with anything on the
        // user's real `~/.agents/skills/` tree.
        let skill_id = format!(
            "project-only-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );

        let project_skills = project_path.join(".agents").join("skills");
        fs::create_dir_all(&project_skills).unwrap();
        write_skill(&project_skills, &skill_id);

        let llms = load_llms(serde_json::json!({ "configurations": {} }));
        let (agent, _keys) = agent_with_signer(
            "w",
            serde_json::json!({ "skills": [skill_id.clone()] }), // even if "active", must not surface
            serde_json::json!({}),
        );
        let backend_pk = nostr_sdk::PublicKey::from_hex(BACKEND_PK_HEX).unwrap();

        let event = build_agent_config_event(&agent, &backend_pk, &base_dir, &llms, None)
            .await
            .expect("event built");
        let s_tags = extract(&event, "skill");
        assert!(
            !s_tags.iter().any(|t| t.get(1) == Some(&skill_id.as_str())),
            "project-shared skill {skill_id:?} must not appear on kind:0 profile; got {s_tags:?}",
        );

        fs::remove_dir_all(&base_dir).ok();
        fs::remove_dir_all(&project_path).ok();
    }

    /// Codex finding #5: when an agent has no explicit `model` in its
    /// `default_config_json`, the runtime falls back to `LlmsDoc::default_config()`.
    /// The published kind:0 profile must mark THAT model as `active`, not leave
    /// the agent's row model-less in the TUI.
    #[tokio::test]
    async fn build_event_marks_llms_default_model_active_when_agent_has_no_model() {
        let base_dir = unique_temp("base-fallback");
        let project_path = unique_temp("proj-fallback");

        let llms = load_llms(serde_json::json!({
            "configurations": {
                "alpha": { "provider": "mock", "model": "a" },
                "beta":  { "provider": "mock", "model": "b" }
            },
            "default": "beta"
        }));

        // Agent intentionally has no "model" key.
        let (agent, _keys) = agent_with_signer(
            "no-model",
            serde_json::json!({ "skills": [] }),
            serde_json::json!({}),
        );

        let backend_pk = nostr_sdk::PublicKey::from_hex(BACKEND_PK_HEX).unwrap();
        let event = build_agent_config_event(&agent, &backend_pk, &base_dir, &llms, None)
            .await
            .expect("event built");

        let m_tags = extract(&event, "model");
        // Fallback: beta (the LlmsDoc default) is marked active.
        assert!(
            m_tags.contains(&vec!["model", "beta", "active"]),
            "expected ['model','beta','active'], got {m_tags:?}"
        );
        assert!(m_tags.contains(&vec!["model", "alpha"]));

        fs::remove_dir_all(&base_dir).ok();
        fs::remove_dir_all(&project_path).ok();
    }

    /// Signer must own the agent's pubkey. A swapped `signer_ref` (or bunker
    /// URI pointing at a different account) would otherwise produce a
    /// cryptographically valid kind:0 announcing capabilities for a key the
    /// project doesn't actually manage.
    #[tokio::test]
    async fn build_event_rejects_signer_with_mismatched_pubkey() {
        let base_dir = unique_temp("base-mismatch");
        let project_path = unique_temp("proj-mismatch");
        let llms = load_llms(serde_json::json!({ "configurations": {} }));

        // Real signer for a different key, but agent.pubkey points elsewhere.
        let other = nostr_sdk::Keys::generate();
        let nsec_bech32 = other.secret_key().to_bech32().unwrap();
        let mut agent = Agent {
            pubkey: "0".repeat(64), // arbitrary, definitely not other's pk
            slug: "spoofed".into(),
            name: "spoofed".into(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: Some(format!("nsec:{nsec_bech32}")),
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
            is_local: true,
            backend_name: None,
        };
        // Sanity: ensure they really differ.
        assert_ne!(agent.pubkey, other.public_key().to_hex());

        let backend_pk = nostr_sdk::PublicKey::from_hex(BACKEND_PK_HEX).unwrap();
        let err = build_agent_config_event(&agent, &backend_pk, &base_dir, &llms, None)
            .await
            .expect_err("mismatch must fail");
        let msg = err.to_string();
        assert!(msg.contains("signer mismatch"), "unexpected error: {msg}");

        // And the matching-pubkey path still succeeds.
        agent.pubkey = other.public_key().to_hex();
        build_agent_config_event(&agent, &backend_pk, &base_dir, &llms, None)
            .await
            .expect("matching pubkey should succeed");

        fs::remove_dir_all(&base_dir).ok();
        fs::remove_dir_all(&project_path).ok();
    }
}

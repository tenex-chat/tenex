//! Runtime startup helpers: project working-dir resolution, sibling-binary
//! discovery, the per-project lockfile, the relay subscription filter
//! builder, and `now_ms()` (used both here and by the persisted-driver
//! freshness gate in [`super::runtime_state_store`]).
//!
//! Everything in this module is invoked once during `runtime_cmd::run`
//! startup or — for `now_ms` and `subscribe_runtime_filters` — on every
//! agent-config / project-definition reload.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::{RuntimeAgentSnapshot, RuntimeFilters, RuntimeSubscriptionIds, PROJECT_KIND};
use crate::store::tenex_config::TenexConfigDoc;

pub(super) fn resolve_project_working_dir(base_dir: &Path, project_dtag: &str) -> Result<PathBuf> {
    let config = TenexConfigDoc::load(base_dir)?;
    let projects_base = config
        .projects_base()
        .unwrap_or_else(crate::onboard::commit::default_projects_base);
    Ok(crate::utils::path_expand::resolve_path(&projects_base).join(project_dtag))
}

pub(super) fn build_runtime_filters(
    user_authors: &[PublicKey],
    trusted_authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
    snapshot: &RuntimeAgentSnapshot,
) -> RuntimeFilters {
    let agent_keys: Vec<PublicKey> = snapshot
        .agents
        .iter()
        .filter_map(|a| PublicKey::from_hex(&a.pubkey).ok())
        .collect();
    let mut p_authors = trusted_authors.to_vec();
    p_authors.extend(agent_keys.iter().copied());

    RuntimeFilters {
        // External-author intake: `#a=project_addr` is the affiliation
        // assertion. Anyone — whitelisted or not — claiming this project
        // address lands here. The trust gate moves to dispatch:
        // untrusted authors are persisted, and only routed if
        // `routeUnauthorizedAuthors` is enabled and the firewall passes.
        project: Filter::new()
            .kind(Kind::TextNote)
            .custom_tags(SingleLetterTag::lowercase(Alphabet::A), [project_addr])
            .since(since),
        project_definition: Filter::new()
            .kind(Kind::Custom(PROJECT_KIND))
            .author(owner)
            .custom_tags(SingleLetterTag::lowercase(Alphabet::D), [project_dtag]),
        directed: Filter::new()
            .kind(Kind::TextNote)
            .authors(p_authors)
            .pubkeys(agent_keys.clone())
            .since(since),
        stop: Filter::new()
            .kind(Kind::Custom(tenex_protocol::nostr::kinds::STOP_COMMAND))
            .authors(user_authors.to_vec())
            .pubkeys(agent_keys.clone())
            .since(since),
        config_update: Filter::new()
            .kind(Kind::Custom(
                tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE,
            ))
            .authors(user_authors.to_vec())
            .since(since),
    }
}

pub(super) fn trusted_runtime_authors(
    user_authors: &[PublicKey],
    backend_pubkey: PublicKey,
) -> Vec<PublicKey> {
    let mut authors = user_authors.to_vec();
    if !authors.contains(&backend_pubkey) {
        authors.push(backend_pubkey);
    }
    authors
}

pub(super) fn pubkey_hex_set(pubkeys: &[PublicKey]) -> std::collections::HashSet<String> {
    pubkeys.iter().map(PublicKey::to_hex).collect()
}

pub(super) async fn subscribe_runtime_filters(
    client: &Client,
    ids: &RuntimeSubscriptionIds,
    filters: RuntimeFilters,
) -> Result<()> {
    for id in [
        &ids.project,
        &ids.project_definition,
        &ids.directed,
        &ids.stop,
        &ids.config_update,
    ] {
        client.unsubscribe(id).await;
    }
    client
        .subscribe_with_id(ids.project.clone(), filters.project, None)
        .await?;
    client
        .subscribe_with_id(
            ids.project_definition.clone(),
            filters.project_definition,
            None,
        )
        .await?;
    client
        .subscribe_with_id(ids.directed.clone(), filters.directed, None)
        .await?;
    client
        .subscribe_with_id(ids.stop.clone(), filters.stop, None)
        .await?;
    client
        .subscribe_with_id(ids.config_update.clone(), filters.config_update, None)
        .await?;
    Ok(())
}

pub(super) fn find_agent_binary() -> PathBuf {
    find_sibling_binary("tenex-agent")
}

pub(super) fn find_agent_acp_binary() -> PathBuf {
    find_sibling_binary("tenex-agent-acp")
}

fn find_sibling_binary(name: &str) -> PathBuf {
    // Prefer a sibling binary (same install dir as the current process).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(name);
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from(name)
}

// ─── Per-project runtime lockfile ──────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct LockInfo {
    pid: i32,
    #[serde(rename = "startedAt")]
    started_at: u64,
}

pub(super) struct RuntimeLockfile {
    path: PathBuf,
}

impl RuntimeLockfile {
    pub(super) fn acquire(dir: &Path) -> Result<Self> {
        let path = dir.join("runtime.lock");

        if path.exists() {
            let bytes = std::fs::read(&path)?;
            if let Ok(info) = serde_json::from_slice::<LockInfo>(&bytes) {
                if process_alive(info.pid) {
                    anyhow::bail!(
                        "tenex runtime already running for this project (pid {})",
                        info.pid
                    );
                }
            }
            std::fs::remove_file(&path).ok();
        }

        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let info = LockInfo {
            pid: std::process::id() as i32,
            started_at,
        };
        std::fs::write(&path, serde_json::to_vec(&info)?)?;
        Ok(Self { path })
    }
}

impl Drop for RuntimeLockfile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(error = %e, "failed to remove runtime lockfile");
            }
        }
    }
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: kill(pid, 0) is a probe — no signal is delivered.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM means the process exists but we lack permission to signal it.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use tenex_project::{models::ProjectAgent, Agent};

    use super::*;

    fn agent(pubkey: &str) -> Agent {
        Agent {
            pubkey: pubkey.to_string(),
            slug: pubkey.to_string(),
            name: pubkey.to_string(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: None,
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
            is_local: true,
            backend_name: None,
        }
    }

    #[test]
    fn runtime_filters_trust_backend_for_kind1_routing() {
        let user_keys = Keys::generate();
        let backend_keys = Keys::generate();
        let agent_keys = Keys::generate();
        let owner_keys = Keys::generate();
        let agent_pubkey = agent_keys.public_key().to_hex();
        let user_authors = vec![user_keys.public_key()];
        let trusted_authors = trusted_runtime_authors(&user_authors, backend_keys.public_key());
        let snapshot = RuntimeAgentSnapshot {
            agents: vec![agent(&agent_pubkey)],
            project_agents: vec![ProjectAgent {
                agent_pubkey: agent_pubkey.clone(),
                is_pm: true,
            }],
            agent_pubkeys: HashSet::from([agent_pubkey]),
        };

        let filters = build_runtime_filters(
            &user_authors,
            &trusted_authors,
            "31933:owner:project",
            owner_keys.public_key(),
            "project",
            Timestamp::now(),
            &snapshot,
        );

        let directed_authors = filters.directed.authors.as_ref().unwrap();
        assert!(directed_authors.contains(&user_keys.public_key()));
        assert!(directed_authors.contains(&backend_keys.public_key()));
        assert!(directed_authors.contains(&agent_keys.public_key()));

        let stop_authors = filters.stop.authors.as_ref().unwrap();
        assert!(stop_authors.contains(&user_keys.public_key()));
        assert!(!stop_authors.contains(&backend_keys.public_key()));
    }

    #[test]
    fn trusted_author_pubkeys_include_backend_pubkey() {
        let user_keys = Keys::generate();
        let backend_keys = Keys::generate();
        let trusted_authors =
            trusted_runtime_authors(&[user_keys.public_key()], backend_keys.public_key());
        let trusted_hex = pubkey_hex_set(&trusted_authors);

        assert!(trusted_hex.contains(&user_keys.public_key().to_hex()));
        assert!(trusted_hex.contains(&backend_keys.public_key().to_hex()));
    }
}

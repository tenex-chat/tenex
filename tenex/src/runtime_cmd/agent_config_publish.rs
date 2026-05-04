//! Publish helpers for per-agent kind:0 profile events.
//!
//! The runtime owns three triggers for republishing per-agent profiles:
//!
//! 1. **Startup** — REQ all agent pubkeys, diff against fs mtimes, fill gaps.
//! 2. **fs-watcher reload** — when `{base_dir}/agents/<pk>.json` mutates.
//! 3. **agent add/remove** — bundled with `publish_project_status_now()`.
//!
//! There is intentionally **no** periodic re-publish: kind:0 is replaceable
//! and only changes when an agent's config does. Re-publishing on a timer
//! would just churn relay state for no value.
//!
//! Private to `runtime_cmd::mod` — the wrapper there fans these out from the
//! `RuntimeShared` context. Pure decision logic
//! ([`agents_needing_publish`], [`agent_pubkey_from_path`],
//! [`fold_existing_agent_configs`]) is testable without spinning up a relay
//! or a live `Client`.
//!
//! Diff policy: if any kind:0 exists for an agent and its `created_at` is
//! `>=` the agent config file's mtime, do nothing; otherwise (no event, or
//! event older than the file) publish a fresh one. On mtime read failure we
//! fail-open and republish — a redundant publish is cheaper than a silently
//! stale view.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use nostr_sdk::{Event, Filter, Kind, PublicKey};
use tenex_project::Agent;
use tracing::{info, warn};

use crate::nostr_pub::agent_config::build_agent_config_event;
use crate::store::llms::LlmsDoc;

/// 5-second cap on the startup REQ. A slow or silent relay must not block
/// the runtime from coming up — on timeout we treat every agent as missing
/// and publish a fresh kind:0.
pub(super) const STARTUP_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Path of the agent's on-disk config file.
pub(super) fn agent_config_path(base_dir: &Path, agent_pubkey: &str) -> PathBuf {
    base_dir.join("agents").join(format!("{agent_pubkey}.json"))
}

/// Inverse of [`agent_config_path`]: extract the agent pubkey from a path
/// fired by the fs watcher (`<base_dir>/agents/<pubkey>.json`). Returns
/// `None` if the path doesn't match the convention (e.g. tmpfile, swp file).
pub(super) fn agent_pubkey_from_path(path: &Path) -> Option<String> {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    path.file_stem().and_then(|s| s.to_str()).map(str::to_owned)
}

/// Decide which agents need a fresh kind:0 profile published.
///
/// `existing` maps agent pubkey → most-recent received `created_at` (unix
/// seconds) for that agent's kind:0 event on relays. Absent entries mean no
/// kind:0 was received for that agent.
///
/// An agent is republished when:
/// - no kind:0 exists for it on relays, **or**
/// - the most recent one is older than the agent's config file mtime, **or**
/// - the file mtime cannot be read (fail-open: prefer a redundant publish
///   over a silently stale view).
pub(super) fn agents_needing_publish(
    agents: &[Agent],
    base_dir: &Path,
    existing: &HashMap<String, u64>,
) -> Vec<String> {
    let mut out = Vec::new();
    for agent in agents {
        let path = agent_config_path(base_dir, &agent.pubkey);
        let needs = match (existing.get(&agent.pubkey), file_mtime_secs(&path)) {
            (None, _) => true,
            (Some(_), None) => true,
            (Some(remote_ts), Some(file_ts)) => *remote_ts < file_ts,
        };
        if needs {
            out.push(agent.pubkey.clone());
        }
    }
    out
}

/// File mtime in unix seconds. `None` if the file is absent or its mtime
/// can't be expressed as a unix timestamp.
fn file_mtime_secs(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Fold a stream of kind:0 events into a `pubkey → newest_created_at` map.
///
/// Multiple events per author are reduced to the highest `created_at`. The
/// caller has already constrained the filter to `kind=0, authors=...`,
/// so we trust the input and don't re-validate.
pub(super) fn fold_existing_agent_configs(events: &[Event]) -> HashMap<String, u64> {
    let mut out: HashMap<String, u64> = HashMap::new();
    for ev in events {
        let ts = ev.created_at.as_secs();
        let pk = ev.pubkey.to_hex();
        out.entry(pk)
            .and_modify(|existing| {
                if ts > *existing {
                    *existing = ts;
                }
            })
            .or_insert(ts);
    }
    out
}

/// Build the relay filter for the startup REQ over kind:0 (agent profiles).
pub(super) fn startup_filter(authors: &[PublicKey]) -> Filter {
    Filter::new()
        .kind(Kind::Metadata)
        .authors(authors.to_vec())
}

/// Build (and sign) the kind:0 profile for one agent. Side-effect free —
/// caller is responsible for sending. Loads `llms.json` fresh on each call
/// so an mid-runtime LLM-config edit is reflected immediately.
pub(super) async fn build_event_for(
    agent: &Agent,
    backend_pubkey: &PublicKey,
    base_dir: &Path,
    backend_name: Option<&str>,
) -> Result<Event> {
    let llms = LlmsDoc::load(base_dir).context("loading llms.json for agent config publish")?;
    build_agent_config_event(agent, backend_pubkey, base_dir, &llms, backend_name)
        .await
        .with_context(|| format!("building kind:0 for agent {}", agent.slug))
}

/// Build + send one kind:0 profile via the live relay client. Failures are logged
/// (warn) and swallowed — publish failures must not poison higher-level
/// reload paths.
pub(super) async fn publish_one(
    agent_pubkey: &str,
    agents: &[Agent],
    backend_pubkey: &PublicKey,
    base_dir: &Path,
    client: &nostr_sdk::Client,
    backend_name: Option<&str>,
) {
    let Some(agent) = agents.iter().find(|a| a.pubkey == agent_pubkey) else {
        warn!(agent_pubkey, "skip kind:0 publish: agent not in snapshot");
        return;
    };
    match build_event_for(agent, backend_pubkey, base_dir, backend_name).await {
        Ok(event) => match client.send_event(&event).await {
            Ok(_) => info!(agent = %agent.slug, "published kind:0 agent profile"),
            Err(error) => warn!(agent = %agent.slug, error = %error, "kind:0 publish failed"),
        },
        Err(error) => warn!(agent = %agent.slug, error = %error, "kind:0 build failed"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use nostr_sdk::{EventBuilder, Keys, ToBech32};
    use tenex_project::Agent;

    use super::*;

    fn unique_temp(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-ac-publish-{label}-{}-{}-{n}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn agent_with_keys(slug: &str) -> (Agent, Keys) {
        let keys = Keys::generate();
        let nsec = keys.secret_key().to_bech32().unwrap();
        let agent = Agent {
            pubkey: keys.public_key().to_hex(),
            slug: slug.into(),
            name: slug.into(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: Some(format!("nsec:{nsec}")),
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
            is_local: true,
        };
        (agent, keys)
    }

    fn write_agent_config_file(base_dir: &Path, agent: &Agent) {
        let path = agent_config_path(base_dir, &agent.pubkey);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}").unwrap();
    }

    fn make_kind0(keys: &Keys, created_at: u64) -> Event {
        EventBuilder::new(Kind::Metadata, r#"{"name":"test"}"#)
            .custom_created_at(nostr_sdk::Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn agent_pubkey_from_path_extracts_stem_for_json_files() {
        let pk = "deadbeef".repeat(8);
        let path = PathBuf::from(format!("/tmp/agents/{pk}.json"));
        assert_eq!(agent_pubkey_from_path(&path), Some(pk));
    }

    #[test]
    fn agent_pubkey_from_path_rejects_non_json_files() {
        let path = PathBuf::from("/tmp/agents/deadbeef.swp");
        assert_eq!(agent_pubkey_from_path(&path), None);
    }

    #[test]
    fn fold_existing_agent_configs_keeps_newest_per_author() {
        let (_, keys_a) = agent_with_keys("a");
        let (_, keys_b) = agent_with_keys("b");
        let events = vec![
            make_kind0(&keys_a, 100),
            make_kind0(&keys_a, 200), // newer for A — must win
            make_kind0(&keys_b, 50),
        ];
        let folded = fold_existing_agent_configs(&events);
        assert_eq!(folded.get(&keys_a.public_key().to_hex()), Some(&200));
        assert_eq!(folded.get(&keys_b.public_key().to_hex()), Some(&50));
    }

    #[test]
    fn agents_needing_publish_returns_all_when_relay_silent() {
        let base_dir = unique_temp("silent");
        let (a, _) = agent_with_keys("a");
        let (b, _) = agent_with_keys("b");
        write_agent_config_file(&base_dir, &a);
        write_agent_config_file(&base_dir, &b);
        let agents = vec![a.clone(), b.clone()];

        let needing = agents_needing_publish(&agents, &base_dir, &HashMap::new());
        let set: std::collections::HashSet<_> = needing.into_iter().collect();
        assert_eq!(set, std::collections::HashSet::from([a.pubkey, b.pubkey]));

        fs::remove_dir_all(&base_dir).ok();
    }

    #[test]
    fn agents_needing_publish_skips_when_relay_event_is_fresh() {
        let base_dir = unique_temp("fresh");
        let (a, _) = agent_with_keys("a");
        write_agent_config_file(&base_dir, &a);
        let agents = vec![a.clone()];

        let mtime = file_mtime_secs(&agent_config_path(&base_dir, &a.pubkey)).unwrap();
        let mut existing = HashMap::new();
        // Pretend the relay's kind:0 is 60 seconds newer than the file mtime.
        existing.insert(a.pubkey.clone(), mtime + 60);

        let needing = agents_needing_publish(&agents, &base_dir, &existing);
        assert!(
            needing.is_empty(),
            "fresh remote event should suppress publish"
        );

        fs::remove_dir_all(&base_dir).ok();
    }

    #[test]
    fn agents_needing_publish_picks_only_stale_when_mixed() {
        // The "stale relay" scenario: two agents, one fresh, one stale.
        let base_dir = unique_temp("mixed");
        let (a, _) = agent_with_keys("fresh");
        let (b, _) = agent_with_keys("stale");
        write_agent_config_file(&base_dir, &a);
        write_agent_config_file(&base_dir, &b);
        let agents = vec![a.clone(), b.clone()];

        let mtime_a = file_mtime_secs(&agent_config_path(&base_dir, &a.pubkey)).unwrap();
        let mtime_b = file_mtime_secs(&agent_config_path(&base_dir, &b.pubkey)).unwrap();
        let mut existing = HashMap::new();
        existing.insert(a.pubkey.clone(), mtime_a + 60); // newer than file
        existing.insert(b.pubkey.clone(), mtime_b.saturating_sub(60)); // stale

        let needing = agents_needing_publish(&agents, &base_dir, &existing);
        assert_eq!(needing, vec![b.pubkey]);

        fs::remove_dir_all(&base_dir).ok();
    }

    /// build_event_for is the per-agent build step that publish_one invokes
    /// before sending. Verifying it directly proves the event has the right
    /// kind + slug tag + p-tag without needing a live relay client. (publish_one
    /// itself is a thin wrapper: lookup → this function → client.send_event,
    /// with errors logged not propagated.)
    #[tokio::test]
    async fn build_event_for_emits_expected_kind_slug_tag_and_p_tag() {
        let base_dir = unique_temp("publish");
        // Minimal llms.json so build_agent_config_event can load it.
        fs::write(
            base_dir.join("llms.json"),
            br#"{"configurations":{"alpha":{"provider":"mock","model":"a"}},"default":"alpha"}"#,
        )
        .unwrap();

        let (agent, _keys) = agent_with_keys("worker");
        write_agent_config_file(&base_dir, &agent);

        let backend_keys = Keys::generate();
        let backend_pk = backend_keys.public_key();

        let event = build_event_for(&agent, &backend_pk, &base_dir, None)
            .await
            .expect("build succeeds");

        assert_eq!(u16::from(event.kind), 0);

        let slug_tag_value = event
            .tags
            .iter()
            .find_map(|t| {
                let s = t.as_slice();
                (s.first().map(String::as_str) == Some("slug"))
                    .then(|| s.get(1).cloned())
                    .flatten()
            })
            .expect("slug tag present");
        assert_eq!(slug_tag_value, agent.slug, "slug tag = agent slug");

        let p_tag_value = event
            .tags
            .iter()
            .find_map(|t| {
                let s = t.as_slice();
                (s.first().map(String::as_str) == Some("p"))
                    .then(|| s.get(1).cloned())
                    .flatten()
            })
            .expect("p tag present");
        assert_eq!(p_tag_value, backend_pk.to_hex(), "p-tag = backend pubkey");

        fs::remove_dir_all(&base_dir).ok();
    }
}

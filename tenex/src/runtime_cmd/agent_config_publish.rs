//! Publish helpers for per-agent kind:0 profile events.
//!
//! The runtime owns three triggers for republishing per-agent profiles:
//!
//! 1. **Startup** — REQ all agent pubkeys, compare canonical content, fill gaps.
//! 2. **fs-watcher reload** — when `{base_dir}/agents/<pk>.json` mutates.
//! 3. **agent add/remove** — bundled with `publish_project_status_now()`.
//!
//! There is intentionally **no** periodic re-publish: kind:0 is replaceable
//! and only changes when an agent's config does. Re-publishing on a timer
//! would just churn relay state for no value.
//!
//! Private to `runtime_cmd::mod` — the wrapper there fans these out from the
//! `RuntimeShared` context. Pure decision logic
//! ([`canonical_payload_equal`], [`agent_pubkey_from_path`],
//! [`fold_existing_agent_configs`]) is testable without spinning up a relay
//! or a live `Client`.
//!
//! Diff policy: at startup we build the candidate kind:0 for each agent and
//! compare its canonical (tags, content) against the relay's most recent
//! event for that pubkey. If they match exactly, the agent's view is already
//! in sync and we skip the publish. Otherwise (no relay event, or content
//! differs) we publish via the runtime's [`Kind0Throttle`].

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr_sdk::{Event, Filter, Kind, PublicKey};
use tenex_project::Agent;
use tracing::{info, warn};

use crate::nostr_pub::agent_config::build_agent_config_event;
use crate::nostr_pub::kind0_throttle::Kind0Throttle;
use crate::store::llms::LlmsDoc;

/// 5-second cap on the startup REQ. A slow or silent relay must not block
/// the runtime from coming up — on timeout we treat every agent as missing
/// and publish a fresh kind:0.
pub(super) const STARTUP_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Extract the agent pubkey from a path fired by the fs watcher
/// (`<base_dir>/agents/<pubkey>.json`). Returns `None` if the path doesn't
/// match the convention (e.g. tmpfile, swp file).
pub(super) fn agent_pubkey_from_path(path: &Path) -> Option<String> {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    path.file_stem().and_then(|s| s.to_str()).map(str::to_owned)
}

/// Two kind:0 events carry equivalent state when their canonical
/// `(tags, content)` projection matches. `created_at`, `id`, and `sig`
/// are deliberately excluded — only the meaningful payload counts, so a
/// republish that would only change the timestamp is suppressed.
pub(super) fn canonical_payload_equal(a: &Event, b: &Event) -> bool {
    if a.content != b.content {
        return false;
    }
    if a.tags.len() != b.tags.len() {
        return false;
    }
    for (ta, tb) in a.tags.iter().zip(b.tags.iter()) {
        if ta.as_slice() != tb.as_slice() {
            return false;
        }
    }
    true
}

/// Fold a stream of kind:0 events into a `pubkey → newest_event` map.
///
/// Multiple events per author are reduced to the one with the highest
/// `created_at`. The caller has already constrained the filter to
/// `kind=0, authors=...`, so we trust the input and don't re-validate.
pub(super) fn fold_existing_agent_configs(events: &[Event]) -> HashMap<String, Event> {
    let mut out: HashMap<String, Event> = HashMap::new();
    for ev in events {
        let pk = ev.pubkey.to_hex();
        out.entry(pk)
            .and_modify(|existing| {
                if ev.created_at > existing.created_at {
                    *existing = ev.clone();
                }
            })
            .or_insert_with(|| ev.clone());
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

/// Build + send one kind:0 profile via the runtime's shared client and
/// kind:0 throttle. Failures are logged (warn) and swallowed — publish
/// failures must not poison higher-level reload paths.
pub(super) async fn publish_one(
    agent_pubkey: &str,
    agents: &[Agent],
    backend_pubkey: &PublicKey,
    base_dir: &Path,
    client: &nostr_sdk::Client,
    throttle: &Kind0Throttle,
    backend_name: Option<&str>,
) {
    let Some(agent) = agents.iter().find(|a| a.pubkey == agent_pubkey) else {
        warn!(agent_pubkey, "skip kind:0 publish: agent not in snapshot");
        return;
    };
    let event = match build_event_for(agent, backend_pubkey, base_dir, backend_name).await {
        Ok(e) => e,
        Err(error) => {
            warn!(agent = %agent.slug, error = %error, "kind:0 build failed");
            return;
        }
    };
    use crate::nostr_pub::kind0_throttle::PublishOutcome;
    match throttle.publish(client, event).await {
        Ok(PublishOutcome::Sent) => {
            info!(agent = %agent.slug, "published kind:0 agent profile")
        }
        Ok(PublishOutcome::SkippedDuplicate) => {
            info!(agent = %agent.slug, "kind:0 agent profile unchanged; skipped publish")
        }
        Err(error) => warn!(agent = %agent.slug, error = %error, "kind:0 publish failed"),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use nostr_sdk::{EventBuilder, Keys, Tag, ToBech32};
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
            backend_name: None,
        };
        (agent, keys)
    }

    fn make_kind0(keys: &Keys, content: &str, created_at: u64, tags: Vec<Tag>) -> Event {
        EventBuilder::new(Kind::Metadata, content)
            .tags(tags)
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
            make_kind0(&keys_a, r#"{"name":"a"}"#, 100, vec![]),
            make_kind0(&keys_a, r#"{"name":"a-new"}"#, 200, vec![]), // newer for A
            make_kind0(&keys_b, r#"{"name":"b"}"#, 50, vec![]),
        ];
        let folded = fold_existing_agent_configs(&events);
        let a = folded.get(&keys_a.public_key().to_hex()).expect("A present");
        assert_eq!(a.created_at.as_secs(), 200);
        assert_eq!(a.content, r#"{"name":"a-new"}"#);
        let b = folded.get(&keys_b.public_key().to_hex()).expect("B present");
        assert_eq!(b.created_at.as_secs(), 50);
    }

    #[test]
    fn canonical_payload_equal_ignores_created_at() {
        let (_, keys) = agent_with_keys("a");
        let a = make_kind0(&keys, r#"{"name":"a"}"#, 100, vec![]);
        let b = make_kind0(&keys, r#"{"name":"a"}"#, 999, vec![]);
        assert!(canonical_payload_equal(&a, &b));
    }

    #[test]
    fn canonical_payload_equal_detects_content_diff() {
        let (_, keys) = agent_with_keys("a");
        let a = make_kind0(&keys, r#"{"name":"a"}"#, 100, vec![]);
        let b = make_kind0(&keys, r#"{"name":"b"}"#, 100, vec![]);
        assert!(!canonical_payload_equal(&a, &b));
    }

    #[test]
    fn canonical_payload_equal_detects_tag_diff() {
        let (_, keys) = agent_with_keys("a");
        let a = make_kind0(&keys, r#"{"name":"a"}"#, 100, vec![]);
        let b = make_kind0(
            &keys,
            r#"{"name":"a"}"#,
            100,
            vec![Tag::parse(["slug", "x"]).unwrap()],
        );
        assert!(!canonical_payload_equal(&a, &b));
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

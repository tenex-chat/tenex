//! Sign-and-publish kind:31933 NDKProject mutations.
//!
//! Mirrors `ProjectEventPublishService.publishMutation`
//! (`src/services/projects/ProjectEventPublishService.ts:111-234`).
//!
//! The pure mutation logic (`apply_mutation`) lives in
//! [`crate::store::project_mutation`] — this module orchestrates
//! around it: load the on-disk event, apply the mutation, validate
//! the owner signer, sign, publish, and return a structured result
//! whose [`PublishOutcome`] strings match the TS literals verbatim.
//!
//! Reads the persisted event from `~/.tenex/projects/<dTag>/event.json`
//! (the daemon-maintained canonical store) rather than going through
//! NDK fetch — same shortcut already in use elsewhere in the Rust port.

use anyhow::Result;
use nostr_sdk::{Client, EventBuilder, Keys, Kind, Tag};
use serde_json::Value;

use crate::store::project_members::{
    is_deleted_project_event, read_persisted_project_event,
};
use crate::store::project_mutation::{
    apply_mutation, AppliedProjectMutation, MetadataKey,
    PublishProjectMutationParams,
};
use crate::store::tenex_config::TenexConfigDoc;

const PROJECT_KIND: u16 = 31933;

/// Verbatim mirror of `ProjectEventPublishOutcome`
/// (`ProjectEventPublishService.ts:27-33`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishOutcome {
    Published,
    ProjectNotFound,
    SigningFailed,
    PublishFailed,
    NoChanges,
}

impl PublishOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            PublishOutcome::Published => "published",
            PublishOutcome::ProjectNotFound => "project_not_found",
            PublishOutcome::SigningFailed => "signing_failed",
            PublishOutcome::PublishFailed => "publish_failed",
            PublishOutcome::NoChanges => "no_changes",
        }
    }
}

/// Mirror of `ProjectEventPublishResult`
/// (`ProjectEventPublishService.ts:35-44`).
#[derive(Debug, Clone)]
pub struct ProjectEventPublishResult {
    pub project_dtag: String,
    pub outcome: PublishOutcome,
    pub event_id: Option<String>,
    pub reason: Option<String>,
    pub added_pubkeys: Vec<String>,
    pub removed_pubkeys: Vec<String>,
    pub updated_fields: Vec<MetadataKey>,
    pub skipped: Vec<String>,
}

impl ProjectEventPublishResult {
    fn from_applied(
        project_dtag: &str,
        outcome: PublishOutcome,
        applied: &AppliedProjectMutation,
        reason: Option<String>,
        event_id: Option<String>,
    ) -> Self {
        Self {
            project_dtag: project_dtag.to_owned(),
            outcome,
            event_id,
            reason,
            added_pubkeys: applied.added_pubkeys.clone(),
            removed_pubkeys: applied.removed_pubkeys.clone(),
            updated_fields: applied.updated_fields.clone(),
            skipped: applied.skipped.clone(),
        }
    }

    fn empty(project_dtag: &str, outcome: PublishOutcome) -> Self {
        Self {
            project_dtag: project_dtag.to_owned(),
            outcome,
            event_id: None,
            reason: None,
            added_pubkeys: Vec::new(),
            removed_pubkeys: Vec::new(),
            updated_fields: Vec::new(),
            skipped: Vec::new(),
        }
    }
}

/// Sign and publish a project mutation. End-to-end orchestration:
/// load on-disk project event, apply mutation, validate signer, sign,
/// publish.
///
/// Mirrors `publishMutation` (`ProjectEventPublishService.ts:111-234`)
/// outcome-for-outcome.
pub async fn publish_project_mutation(
    base_dir: &std::path::Path,
    keys: &Keys,
    params: &PublishProjectMutationParams,
) -> Result<ProjectEventPublishResult> {
    // ── 1. Fetch + validate base event ────────────────────────────────
    let parsed = match read_persisted_project_event(base_dir, &params.project_dtag)? {
        Some(p) => p,
        None => {
            return Ok(ProjectEventPublishResult::empty(
                &params.project_dtag,
                PublishOutcome::ProjectNotFound,
            ));
        }
    };
    if is_deleted_project_event(&parsed) {
        return Ok(ProjectEventPublishResult::empty(
            &params.project_dtag,
            PublishOutcome::ProjectNotFound,
        ));
    }

    let base_tags = extract_tags(&parsed);
    let base_content = parsed
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("");

    // ── 2. Apply mutation ─────────────────────────────────────────────
    let applied = apply_mutation(&base_tags, base_content, params);
    if !applied.has_changes {
        return Ok(ProjectEventPublishResult::from_applied(
            &params.project_dtag,
            PublishOutcome::NoChanges,
            &applied,
            None,
            None,
        ));
    }

    // ── 3. Validate signer pubkey ─────────────────────────────────────
    let signer_pubkey_hex = keys.public_key().to_hex();
    if signer_pubkey_hex != params.owner_pubkey {
        return Ok(ProjectEventPublishResult::from_applied(
            &params.project_dtag,
            PublishOutcome::SigningFailed,
            &applied,
            Some(format!(
                "Owner nsec does not match project owner {}",
                params.owner_pubkey
            )),
            None,
        ));
    }

    // ── 4. Build + sign new event ─────────────────────────────────────
    let mut tags: Vec<Tag> = Vec::with_capacity(applied.tags.len());
    for tag in &applied.tags {
        match Tag::parse(tag.iter().map(String::as_str)) {
            Ok(t) => tags.push(t),
            Err(e) => {
                return Ok(ProjectEventPublishResult::from_applied(
                    &params.project_dtag,
                    PublishOutcome::SigningFailed,
                    &applied,
                    Some(format!("malformed tag {tag:?}: {e}")),
                    None,
                ));
            }
        }
    }
    let event = match EventBuilder::new(Kind::Custom(PROJECT_KIND), applied.content.clone())
        .tags(tags)
        .sign_with_keys(keys)
    {
        Ok(e) => e,
        Err(e) => {
            return Ok(ProjectEventPublishResult::from_applied(
                &params.project_dtag,
                PublishOutcome::SigningFailed,
                &applied,
                Some(format!("{e}")),
                None,
            ));
        }
    };

    // ── 5. Publish ────────────────────────────────────────────────────
    let doc = TenexConfigDoc::load(base_dir)?;
    let relays = if doc.relays().is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        doc.relays()
    };

    let client = Client::new(keys.clone());
    for relay in &relays {
        if let Err(e) = client.add_relay(relay.as_str()).await {
            // Best-effort — single-relay failure shouldn't abort the whole
            // publish if other relays are available. TS NDK behaves the
            // same way: it continues with whatever relays are reachable.
            tracing::warn!(relay, error = %e, "add_relay failed");
        }
    }
    client.connect().await;

    let result = client.send_event(&event).await;
    let _ = client.disconnect().await;

    match result {
        Ok(_) => Ok(ProjectEventPublishResult::from_applied(
            &params.project_dtag,
            PublishOutcome::Published,
            &applied,
            None,
            Some(event.id.to_hex()),
        )),
        Err(e) => Ok(ProjectEventPublishResult::from_applied(
            &params.project_dtag,
            PublishOutcome::PublishFailed,
            &applied,
            Some(format!("{e}")),
            None,
        )),
    }
}

/// Result of [`sync_project_membership`]: pairs the project dTag with
/// the publish outcome. Mirrors the TS `ProjectMembershipSyncResult` shape
/// at `ProjectMembershipPublishService.ts:18-21`.
#[derive(Debug, Clone)]
pub struct ProjectMembershipSyncResult {
    pub project_dtag: String,
    pub outcome: PublishOutcome,
    pub reason: Option<String>,
}

/// Re-publish a project's kind:31933 event with its **current local
/// p-tag membership** as `retain_agent_pubkeys`. Mirrors
/// `ProjectMembershipPublishService.syncProjectMembership`
/// (`:87-118`).
///
/// Looks up the latest persisted event to recover the project owner's
/// pubkey, then calls [`publish_project_mutation`] with the local agent
/// pubkeys (read from the same event's `p` tags via
/// [`crate::store::project_members::read_project_agent_pubkeys`]) as the
/// retain set. The mutation is purely a "retain → re-sign" — net effect
/// is that any agents the local AgentStorage has just removed will be
/// dropped from the relay-side project event too.
///
/// Trigger string is `"agent_manager_31933"` verbatim (`:110`).
pub async fn sync_project_membership(
    base_dir: &std::path::Path,
    keys: &Keys,
    project_dtag: &str,
) -> Result<ProjectMembershipSyncResult> {
    use crate::store::project_members::read_project_agent_pubkeys;

    let parsed = match read_persisted_project_event(base_dir, project_dtag)? {
        Some(p) => p,
        None => {
            return Ok(ProjectMembershipSyncResult {
                project_dtag: project_dtag.to_owned(),
                outcome: PublishOutcome::ProjectNotFound,
                reason: None,
            });
        }
    };
    if is_deleted_project_event(&parsed) {
        return Ok(ProjectMembershipSyncResult {
            project_dtag: project_dtag.to_owned(),
            outcome: PublishOutcome::ProjectNotFound,
            reason: None,
        });
    }

    let owner_pubkey = match parsed.get("pubkey").and_then(Value::as_str) {
        Some(p) => p.to_owned(),
        None => {
            return Ok(ProjectMembershipSyncResult {
                project_dtag: project_dtag.to_owned(),
                outcome: PublishOutcome::ProjectNotFound,
                reason: Some("event.json missing pubkey".to_owned()),
            });
        }
    };

    let assigned_pubkeys = read_project_agent_pubkeys(base_dir, project_dtag)?;
    let params = PublishProjectMutationParams {
        owner_pubkey,
        project_dtag: project_dtag.to_owned(),
        trigger: "agent_manager_31933".to_owned(),
        retain_agent_pubkeys: assigned_pubkeys,
        ..Default::default()
    };

    let result = publish_project_mutation(base_dir, keys, &params).await?;
    Ok(ProjectMembershipSyncResult {
        project_dtag: project_dtag.to_owned(),
        outcome: result.outcome,
        reason: result.reason,
    })
}

/// Re-publish multiple projects' kind:31933 events. Dedupes the input
/// preserving first-occurrence order. Mirrors
/// `syncManyProjectMemberships` (`ProjectMembershipPublishService.ts:120-132`).
pub async fn sync_many_project_memberships(
    base_dir: &std::path::Path,
    keys: &Keys,
    project_dtags: &[String],
) -> Result<Vec<ProjectMembershipSyncResult>> {
    let mut seen: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for d in project_dtags {
        if !d.is_empty() {
            seen.insert(d.clone());
        }
    }
    let mut out = Vec::with_capacity(seen.len());
    for dtag in seen {
        out.push(sync_project_membership(base_dir, keys, &dtag).await?);
    }
    Ok(out)
}

/// Pull `tags` out of a parsed event JSON value as `Vec<Vec<String>>`.
/// Skips non-array entries and non-string members — matches the
/// permissive TS `Array.isArray(parsed.tags)` handling.
fn extract_tags(event: &Value) -> Vec<Vec<String>> {
    let Some(arr) = event.get("tags").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|t| {
            t.as_array().map(|inner| {
                inner
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-publish-31933-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_project_event(
        base: &std::path::Path,
        dtag: &str,
        author_pubkey: &str,
        agent_pubkeys: &[&str],
        content: &str,
        deleted: bool,
    ) {
        let dir = base.join("projects").join(dtag);
        std::fs::create_dir_all(&dir).unwrap();
        let mut tags: Vec<Value> = vec![Value::Array(vec![
            Value::String("d".into()),
            Value::String(dtag.into()),
        ])];
        for pk in agent_pubkeys {
            tags.push(Value::Array(vec![
                Value::String("p".into()),
                Value::String((*pk).into()),
            ]));
        }
        if deleted {
            tags.push(Value::Array(vec![
                Value::String("deleted".into()),
                Value::String("".into()),
            ]));
        }
        let event = serde_json::json!({
            "tags": tags,
            "content": content,
            "pubkey": author_pubkey,
            "kind": 31933,
        });
        std::fs::write(dir.join("event.json"), event.to_string()).unwrap();
    }

    fn empty_params(owner_pubkey: &str, project_dtag: &str) -> PublishProjectMutationParams {
        PublishProjectMutationParams {
            owner_pubkey: owner_pubkey.to_owned(),
            project_dtag: project_dtag.to_owned(),
            trigger: "test".to_owned(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn missing_event_returns_project_not_found() {
        let base = unique_temp();
        let keys = Keys::generate();
        let pk_hex = keys.public_key().to_hex();
        let params = empty_params(&pk_hex, "ghost");
        let result = publish_project_mutation(&base, &keys, &params).await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::ProjectNotFound);
        assert!(result.event_id.is_none());
        assert!(result.added_pubkeys.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn deleted_event_returns_project_not_found() {
        let base = unique_temp();
        let keys = Keys::generate();
        let pk_hex = keys.public_key().to_hex();
        write_project_event(&base, "rip", &pk_hex, &[], "", true);
        let params = empty_params(&pk_hex, "rip");
        let result = publish_project_mutation(&base, &keys, &params).await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::ProjectNotFound);
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn no_mutation_returns_no_changes() {
        let base = unique_temp();
        let keys = Keys::generate();
        let pk_hex = keys.public_key().to_hex();
        write_project_event(&base, "static", &pk_hex, &["alice".repeat(8).as_str()], "", false);
        let params = empty_params(&pk_hex, "static"); // no add/remove/set
        let result = publish_project_mutation(&base, &keys, &params).await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::NoChanges);
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn signer_mismatch_returns_signing_failed_with_verbatim_reason() {
        let base = unique_temp();
        let owner_keys = Keys::generate();
        let other_keys = Keys::generate(); // wrong signer
        let owner_pubkey = owner_keys.public_key().to_hex();
        write_project_event(&base, "p1", &owner_pubkey, &[], "", false);

        let mut params = empty_params(&owner_pubkey, "p1");
        params.add_agent_pubkeys = vec!["a".repeat(64)];
        let result = publish_project_mutation(&base, &other_keys, &params).await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::SigningFailed);
        let expected = format!("Owner nsec does not match project owner {}", owner_pubkey);
        assert_eq!(result.reason.as_deref(), Some(expected.as_str()));
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn outcome_as_str_matches_ts_literals() {
        // The TS literal strings are visible to consumers — preserve verbatim.
        assert_eq!(PublishOutcome::Published.as_str(), "published");
        assert_eq!(PublishOutcome::ProjectNotFound.as_str(), "project_not_found");
        assert_eq!(PublishOutcome::SigningFailed.as_str(), "signing_failed");
        assert_eq!(PublishOutcome::PublishFailed.as_str(), "publish_failed");
        assert_eq!(PublishOutcome::NoChanges.as_str(), "no_changes");
    }

    #[test]
    fn extract_tags_pulls_arrays_from_event_json() {
        let v: Value = serde_json::from_str(
            r#"{"tags":[["d","p1"],["p","alice"],["title","T"]]}"#,
        )
        .unwrap();
        let tags = extract_tags(&v);
        assert_eq!(tags.len(), 3);
        assert_eq!(tags[0], vec!["d".to_string(), "p1".into()]);
        assert_eq!(tags[1], vec!["p".to_string(), "alice".into()]);
    }

    #[test]
    fn extract_tags_skips_non_arrays() {
        let v: Value =
            serde_json::from_str(r#"{"tags":[null,42,["d","p1"],"oops"]}"#).unwrap();
        let tags = extract_tags(&v);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0], vec!["d".to_string(), "p1".into()]);
    }

    #[test]
    fn extract_tags_returns_empty_when_tags_missing() {
        let v: Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(extract_tags(&v).is_empty());
    }

    // ─────────── sync_project_membership ───────────

    #[tokio::test]
    async fn sync_returns_project_not_found_when_event_missing() {
        let base = unique_temp();
        let keys = Keys::generate();
        let result = sync_project_membership(&base, &keys, "ghost").await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::ProjectNotFound);
        assert_eq!(result.project_dtag, "ghost");
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn sync_returns_project_not_found_when_event_marked_deleted() {
        let base = unique_temp();
        let keys = Keys::generate();
        let pk_hex = keys.public_key().to_hex();
        write_project_event(&base, "rip", &pk_hex, &[], "", true);
        let result = sync_project_membership(&base, &keys, "rip").await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::ProjectNotFound);
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn sync_returns_no_changes_when_local_matches_event() {
        // Event already has alice as a `p` tag; local read returns alice;
        // retain set = [alice]; mutation is a no-op → NoChanges.
        let base = unique_temp();
        let keys = Keys::generate();
        let owner = keys.public_key().to_hex();
        let alice = "a".repeat(64);
        write_project_event(&base, "stable", &owner, &[&alice], "", false);
        let result = sync_project_membership(&base, &keys, "stable").await.unwrap();
        assert_eq!(result.outcome, PublishOutcome::NoChanges);
        std::fs::remove_dir_all(&base).ok();
    }

    // (Signer-mismatch error path is covered at the publish layer by
    // `signer_mismatch_returns_signing_failed_with_verbatim_reason`. The
    // sync layer reads its retain set from the same event.json that
    // supplies the owner pubkey, so a same-event setup never reaches the
    // mismatch branch — it returns NoChanges first. Layered correctly.)

    #[tokio::test]
    async fn sync_many_dedupes_input_preserving_order() {
        let base = unique_temp();
        let keys = Keys::generate();
        // No events on disk → every sync returns ProjectNotFound, but
        // we get one result per unique input dTag, in input order.
        let inputs = vec![
            "z".to_string(),
            "a".to_string(),
            "z".to_string(),
            "m".to_string(),
            "a".to_string(),
        ];
        let results = sync_many_project_memberships(&base, &keys, &inputs)
            .await
            .unwrap();
        let dtags: Vec<&str> =
            results.iter().map(|r| r.project_dtag.as_str()).collect();
        assert_eq!(dtags, vec!["z", "a", "m"]);
        for r in &results {
            assert_eq!(r.outcome, PublishOutcome::ProjectNotFound);
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn sync_many_filters_empty_strings() {
        let base = unique_temp();
        let keys = Keys::generate();
        let inputs = vec!["".to_string(), "real".to_string(), "".to_string()];
        let results = sync_many_project_memberships(&base, &keys, &inputs)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].project_dtag, "real");
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn sync_many_empty_input_returns_empty() {
        let base = unique_temp();
        let keys = Keys::generate();
        let results = sync_many_project_memberships(&base, &keys, &[])
            .await
            .unwrap();
        assert!(results.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }
}

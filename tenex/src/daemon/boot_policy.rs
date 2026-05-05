//! Central gate for "should this project be booted right now?".
//!
//! Two concerns live here:
//!
//! 1. [`decide_boot`] — pure decision against the operator's
//!    `ignoredProjects`/`onlyProjects` filters and the on-disk agent
//!    projections. Every code path that boots a per-project runtime must
//!    consult this (`nostr.rs` for relay-driven discovery and triggers,
//!    `control_socket.rs` for transport bridges like Telegram).
//!
//! 2. [`SkippedProjects`] — a tiny shared set tracking d-tags whose boot was
//!    deferred so we can re-evaluate when their preconditions change (a
//!    republished kind:31933, a new agent JSON file). The wrapper enforces
//!    the "log once per skip" invariant: repeat skips of the same d-tag for
//!    the same reason stay silent.
//!
//! Keeping both here lets `nostr.rs` focus on subscriptions and the control
//! socket reuse the same gate without copy-pasting the policy.
//!
//! `nostr.rs` triggers re-evaluation of [`SkippedProjects`] when a new agent
//! JSON file lands in `<base_dir>/agents/`, since that may flip the
//! local-agent gate from no→yes for one or more deferred projects.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::{info, warn};

/// Outcome of evaluating whether the daemon should spawn a runtime for a
/// project right now. `Allow` means boot it; the others carry the reason
/// for the user-visible info log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootDecision {
    Allow,
    Filtered,
    NoLocalAgents,
}

impl BootDecision {
    /// Short, user-visible reason for a deferred boot. Stable across call
    /// sites so log lines are greppable.
    pub fn skip_reason(self) -> Option<&'static str> {
        match self {
            Self::Allow => None,
            Self::Filtered => {
                Some("excluded by ignoredProjects/onlyProjects")
            }
            Self::NoLocalAgents => Some("no relevant agents available locally"),
        }
    }
}

/// Apply the operator-configured allow/deny lists. `only_projects` is an
/// allowlist (when non-empty); `ignored_projects` is a denylist applied
/// after.
fn project_allowed_by_filters(
    ignored_projects: &[String],
    only_projects: &[String],
    d_tag: &str,
) -> bool {
    if !only_projects.is_empty() && !only_projects.iter().any(|p| p == d_tag) {
        return false;
    }
    !ignored_projects.iter().any(|p| p == d_tag)
}

/// The shared boot gate. Both relay-driven boots (`nostr.rs`) and
/// control-socket boots (`control_socket.rs`) must consult this before
/// invoking the supervisor.
pub fn decide_boot(
    base_dir: &Path,
    ignored_projects: &[String],
    only_projects: &[String],
    d_tag: &str,
) -> BootDecision {
    if !project_allowed_by_filters(ignored_projects, only_projects, d_tag) {
        return BootDecision::Filtered;
    }
    match tenex_project::Project::open(d_tag, base_dir) {
        Ok(p) => match p.has_locally_signable_agents() {
            Ok(true) => BootDecision::Allow,
            Ok(false) => BootDecision::NoLocalAgents,
            Err(e) => {
                warn!(d_tag, error = %e, "failed to enumerate project members; treating as no local agents");
                BootDecision::NoLocalAgents
            }
        },
        Err(e) => {
            warn!(d_tag, error = %e, "failed to open project for boot decision");
            BootDecision::NoLocalAgents
        }
    }
}

/// Set of project d-tags whose boot was deferred — either filtered by
/// `ignoredProjects`/`onlyProjects`, or no locally-signable agent at the
/// time of discovery. A republished kind:31933 or a new agent JSON file
/// triggers re-evaluation against the same gate.
///
/// Wraps a `Mutex<HashSet<String>>` so the "log once per skip" invariant
/// is enforced at the type level: callers cannot insert without going
/// through [`Self::record`], which only logs on a fresh insertion.
#[derive(Default)]
pub struct SkippedProjects {
    inner: Mutex<HashSet<String>>,
}

impl SkippedProjects {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Insert `d_tag` into the skip set and emit an info-level log iff this
    /// is a fresh skip (returns `true`). Repeat calls for an already-skipped
    /// d-tag are silent.
    pub async fn record(&self, d_tag: &str, reason: &str) -> bool {
        let inserted = self.inner.lock().await.insert(d_tag.to_string());
        if inserted {
            info!(d_tag, %reason, "skipping project");
        }
        inserted
    }

    /// Remove `d_tag` from the skip set. Returns `true` iff it was present.
    pub async fn clear(&self, d_tag: &str) -> bool {
        self.inner.lock().await.remove(d_tag)
    }

    /// Snapshot the current skip set. Used by the agent-dir watcher to
    /// re-evaluate every deferred project after a filesystem change.
    pub async fn snapshot(&self) -> Vec<String> {
        self.inner.lock().await.iter().cloned().collect()
    }

    /// True iff `d_tag` is currently deferred. Lets `nostr.rs` distinguish
    /// "first discovery" from "republish of a deferred project" without
    /// pulling the d-tag out of the set.
    pub async fn contains(&self, d_tag: &str) -> bool {
        self.inner.lock().await.contains(d_tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_allowlist_then_denylist() {
        assert!(project_allowed_by_filters(&[], &[], "anything"));
        assert!(project_allowed_by_filters(
            &[],
            &["allowed".into()],
            "allowed"
        ));
        assert!(!project_allowed_by_filters(
            &[],
            &["allowed".into()],
            "other"
        ));
        assert!(!project_allowed_by_filters(
            &["blocked".into()],
            &[],
            "blocked"
        ));
        assert!(!project_allowed_by_filters(
            &["allowed".into()],
            &["allowed".into()],
            "allowed"
        ));
    }

    #[tokio::test]
    async fn record_logs_once_per_skip() {
        let s = SkippedProjects::default();
        assert!(s.record("d1", "reason").await);
        assert!(!s.record("d1", "reason").await);
        assert!(s.contains("d1").await);
        assert!(s.clear("d1").await);
        assert!(!s.clear("d1").await);
        assert!(s.record("d1", "reason").await);
    }
}

//! Dispatch coordinator: per `(agent_pubkey, conversation_id)` queue and
//! driver-busy state. Owns the in-memory bookkeeping for runs that are
//! currently executing, runs that are queued behind a busy driver, and the
//! preempt path used by shell interventions.
//!
//! Queue state is paired with persisted driver state in
//! [`super::runtime_state_store::persisted_driver_busy`]; the relay loop
//! consults the persistent value before deciding whether an inbound job can
//! start immediately.

use std::collections::{HashMap, VecDeque};

use super::agent_subprocess::DispatchJob;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(super) struct DispatchKey {
    pub(super) agent_pubkey: String,
    pub(super) conversation_id: String,
}

impl DispatchKey {
    pub(super) fn new(agent_pubkey: impl Into<String>, conversation_id: impl Into<String>) -> Self {
        Self {
            agent_pubkey: agent_pubkey.into(),
            conversation_id: conversation_id.into(),
        }
    }
}

#[derive(Default)]
pub(super) struct DispatchCoordinator {
    entries: HashMap<DispatchKey, DispatchEntry>,
}

#[derive(Default)]
struct DispatchEntry {
    active_runs: usize,
    driver_busy: bool,
    queued: VecDeque<DispatchJob>,
}

impl DispatchCoordinator {
    pub(super) fn dispatch_inbound(
        &mut self,
        job: DispatchJob,
        allow_parallel_when_busy: bool,
    ) -> Option<DispatchJob> {
        let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
        let entry = self.entries.entry(key).or_default();

        if entry.active_runs == 0 {
            entry.active_runs = 1;
            entry.driver_busy = true;
            return Some(job);
        }

        if entry.driver_busy && !allow_parallel_when_busy {
            entry.queued.push_back(job);
            return None;
        }

        entry.active_runs += 1;
        entry.driver_busy = true;
        Some(job)
    }

    pub(super) fn mark_driver_busy(&mut self, key: &DispatchKey) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.driver_busy = true;
        }
    }

    pub(super) fn mark_driver_free(&mut self, key: &DispatchKey) {
        let Some(entry) = self.entries.get_mut(key) else {
            return;
        };
        entry.driver_busy = false;
    }

    pub(super) fn sync_driver_busy(&mut self, key: &DispatchKey, driver_busy: bool) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.driver_busy = driver_busy;
        }
    }

    pub(super) fn drop_queued_matching(
        &mut self,
        key: &DispatchKey,
        mut should_drop: impl FnMut(&DispatchJob) -> bool,
    ) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.queued.retain(|job| !should_drop(job));
        }
    }

    pub(super) fn finish_run(&mut self, key: &DispatchKey) -> Option<DispatchJob> {
        let entry = self.entries.get_mut(key)?;

        entry.active_runs = entry.active_runs.saturating_sub(1);
        if entry.active_runs == 0 {
            entry.driver_busy = false;
        }

        let next = if !entry.driver_busy {
            if let Some(job) = entry.queued.pop_back() {
                entry.queued.clear();
                entry.active_runs += 1;
                entry.driver_busy = true;
                Some(job)
            } else {
                None
            }
        } else {
            None
        };

        if entry.active_runs == 0 && entry.queued.is_empty() {
            self.entries.remove(key);
        }

        next
    }

    pub(super) fn active_agent_pubkeys_for_conversation(&self, conv_id: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (key, entry) in &self.entries {
            if entry.active_runs > 0
                && key.conversation_id == conv_id
                && !out.contains(&key.agent_pubkey)
            {
                out.push(key.agent_pubkey.clone());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use nostr_sdk::prelude::*;
    use tenex_project::Agent;

    use super::*;

    fn signed_event(kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, content)
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap()
    }

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
        }
    }

    fn dispatch_job(agent_pubkey: &str, conv_id: &str, content: &str) -> DispatchJob {
        DispatchJob {
            event: signed_event(Kind::TextNote, content, Vec::new()),
            agent: agent(agent_pubkey),
            conv_id: conv_id.to_string(),
            agent_json: PathBuf::from("agent.json"),
            allow_driver_preempt: false,
            completion_recipient_pubkey: None,
            is_external: false,
            is_remote_agent: false,
            response_tee: None,
            trace_carrier: None,
        }
    }

    #[test]
    fn dispatch_queues_while_driver_busy_and_runs_newest_when_run_finishes() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let third = dispatch_job("agent1", "conv1", "third");
        let key = DispatchKey::new("agent1", "conv1");

        assert_eq!(
            coordinator
                .dispatch_inbound(first, false)
                .unwrap()
                .event
                .content,
            "first"
        );
        assert!(coordinator.dispatch_inbound(second, false).is_none());
        assert!(coordinator.dispatch_inbound(third, false).is_none());

        coordinator.mark_driver_free(&key);
        let resumed = coordinator.finish_run(&key).unwrap();

        assert_eq!(resumed.event.content, "third");
    }

    #[test]
    fn dispatch_drops_queued_messages_consumed_by_current_run() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        assert!(coordinator.dispatch_inbound(second, false).is_none());
        coordinator.drop_queued_matching(&key, |job| job.event.content == "second");

        assert!(coordinator.finish_run(&key).is_none());
    }

    #[test]
    fn dispatch_starts_concurrent_run_when_existing_run_is_in_tool() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        coordinator.mark_driver_free(&key);

        assert_eq!(
            coordinator
                .dispatch_inbound(second, false)
                .unwrap()
                .event
                .content,
            "second"
        );
    }

    #[test]
    fn dispatch_can_preempt_busy_driver_for_shell_intervention() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        assert_eq!(
            coordinator
                .dispatch_inbound(second, true)
                .unwrap()
                .event
                .content,
            "second"
        );
    }

    #[test]
    fn dispatch_queues_when_persisted_driver_was_reacquired() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        coordinator.mark_driver_free(&key);
        coordinator.sync_driver_busy(&key, true);

        assert!(coordinator.dispatch_inbound(second, false).is_none());
    }
}

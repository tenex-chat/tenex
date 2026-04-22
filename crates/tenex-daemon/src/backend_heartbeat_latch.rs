use std::collections::HashSet;

use crate::nostr_event::{NormalizedNostrEvent, SignedNostrEvent};

pub const PROJECT_AGENT_SNAPSHOT_KIND: u64 = 14199;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendHeartbeatLatchState {
    Active,
    Stopped,
}

impl BackendHeartbeatLatchState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Active)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendHeartbeatLatchPlanner {
    backend_pubkey: String,
    owner_pubkeys: HashSet<String>,
    state: BackendHeartbeatLatchState,
}

impl BackendHeartbeatLatchPlanner {
    pub fn new(
        backend_pubkey: impl Into<String>,
        owner_pubkeys: impl IntoIterator<Item = String>,
    ) -> Self {
        let owner_pubkeys = owner_pubkeys.into_iter().collect::<HashSet<_>>();
        let state = if owner_pubkeys.is_empty() {
            BackendHeartbeatLatchState::Stopped
        } else {
            BackendHeartbeatLatchState::Active
        };

        Self {
            backend_pubkey: backend_pubkey.into(),
            owner_pubkeys,
            state,
        }
    }

    pub fn state(&self) -> BackendHeartbeatLatchState {
        self.state
    }

    pub fn should_heartbeat(&self) -> bool {
        self.state.is_active()
    }

    pub fn observe_signed_event(&mut self, event: &SignedNostrEvent) -> BackendHeartbeatLatchState {
        self.observe_snapshot(event.kind, Some(event.pubkey.as_str()), &event.tags)
    }

    pub fn observe_normalized_event(
        &mut self,
        event: &NormalizedNostrEvent,
    ) -> BackendHeartbeatLatchState {
        self.observe_snapshot(event.kind, event.pubkey.as_deref(), &event.tags)
    }

    fn observe_snapshot(
        &mut self,
        kind: u64,
        author_pubkey: Option<&str>,
        tags: &[Vec<String>],
    ) -> BackendHeartbeatLatchState {
        if !self.state.is_active() {
            return self.state;
        }

        if kind != PROJECT_AGENT_SNAPSHOT_KIND {
            return self.state;
        }

        let Some(author_pubkey) = author_pubkey else {
            return self.state;
        };

        if !self.owner_pubkeys.contains(author_pubkey) {
            return self.state;
        }

        if tags.iter().any(|tag| {
            tag.first().is_some_and(|field| field == "p")
                && tag
                    .get(1)
                    .is_some_and(|value| value == self.backend_pubkey.as_str())
        }) {
            self.state = BackendHeartbeatLatchState::Stopped;
        }

        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(fill_byte: u8) -> String {
        hex::encode([fill_byte; 32])
    }

    fn normalized_event(
        kind: u64,
        author_pubkey: Option<String>,
        tags: Vec<Vec<String>>,
    ) -> NormalizedNostrEvent {
        NormalizedNostrEvent {
            kind,
            content: String::new(),
            tags,
            pubkey: author_pubkey,
            created_at: Some(1_710_000_000),
        }
    }

    fn signed_event(kind: u64, author_pubkey: String, tags: Vec<Vec<String>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: "00".repeat(32),
            pubkey: author_pubkey,
            created_at: 1_710_000_000,
            kind,
            tags,
            content: String::new(),
            sig: "11".repeat(64),
        }
    }

    #[test]
    fn no_owner_pubkeys_start_stopped_and_stay_stopped() {
        let backend = owner(0x02);
        let mut planner = BackendHeartbeatLatchPlanner::new(backend.clone(), Vec::new());

        assert_eq!(planner.state(), BackendHeartbeatLatchState::Stopped);
        assert!(!planner.should_heartbeat());

        let event = normalized_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            Some(owner(0x03)),
            vec![vec!["p".to_string(), backend]],
        );

        assert_eq!(
            planner.observe_normalized_event(&event),
            BackendHeartbeatLatchState::Stopped
        );
        assert_eq!(planner.state(), BackendHeartbeatLatchState::Stopped);
    }

    #[test]
    fn no_matching_p_tags_keeps_heartbeat_active() {
        let backend = owner(0x02);
        let owner_pubkey = owner(0x03);
        let mut planner =
            BackendHeartbeatLatchPlanner::new(backend.clone(), vec![owner_pubkey.clone()]);

        let event = normalized_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            Some(owner_pubkey),
            vec![vec!["p".to_string(), owner(0x04)]],
        );

        assert_eq!(
            planner.observe_normalized_event(&event),
            BackendHeartbeatLatchState::Active
        );
        assert!(planner.should_heartbeat());
    }

    #[test]
    fn matching_p_tag_latches_heartbeat_stopped() {
        let backend = owner(0x02);
        let owner_pubkey = owner(0x03);
        let mut planner =
            BackendHeartbeatLatchPlanner::new(backend.clone(), vec![owner_pubkey.clone()]);

        let event = signed_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            owner_pubkey,
            vec![vec!["p".to_string(), backend]],
        );

        assert_eq!(
            planner.observe_signed_event(&event),
            BackendHeartbeatLatchState::Stopped
        );
        assert!(!planner.should_heartbeat());
    }

    #[test]
    fn non_owner_snapshot_is_ignored_even_with_matching_p_tag() {
        let backend = owner(0x02);
        let owner_pubkey = owner(0x03);
        let non_owner_pubkey = owner(0x05);
        let mut planner = BackendHeartbeatLatchPlanner::new(backend.clone(), vec![owner_pubkey]);

        let event = normalized_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            Some(non_owner_pubkey),
            vec![vec!["p".to_string(), backend]],
        );

        assert_eq!(
            planner.observe_normalized_event(&event),
            BackendHeartbeatLatchState::Active
        );
        assert!(planner.should_heartbeat());
    }

    #[test]
    fn wrong_kind_snapshot_is_ignored() {
        let backend = owner(0x02);
        let owner_pubkey = owner(0x03);
        let mut planner =
            BackendHeartbeatLatchPlanner::new(backend.clone(), vec![owner_pubkey.clone()]);

        let event = normalized_event(
            24012,
            Some(owner_pubkey),
            vec![vec!["p".to_string(), backend]],
        );

        assert_eq!(
            planner.observe_normalized_event(&event),
            BackendHeartbeatLatchState::Active
        );
        assert!(planner.should_heartbeat());
    }

    #[test]
    fn one_way_state_stays_stopped_after_a_matching_snapshot() {
        let backend = owner(0x02);
        let owner_pubkey = owner(0x03);
        let mut planner =
            BackendHeartbeatLatchPlanner::new(backend.clone(), vec![owner_pubkey.clone()]);

        let matching = normalized_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            Some(owner_pubkey.clone()),
            vec![vec!["p".to_string(), backend.clone()]],
        );
        assert_eq!(
            planner.observe_normalized_event(&matching),
            BackendHeartbeatLatchState::Stopped
        );
        assert!(!planner.should_heartbeat());

        let later = signed_event(
            PROJECT_AGENT_SNAPSHOT_KIND,
            owner_pubkey,
            vec![vec!["p".to_string(), owner(0x04)]],
        );
        assert_eq!(
            planner.observe_signed_event(&later),
            BackendHeartbeatLatchState::Stopped
        );
        assert_eq!(planner.state(), BackendHeartbeatLatchState::Stopped);
        assert!(!planner.should_heartbeat());
    }
}

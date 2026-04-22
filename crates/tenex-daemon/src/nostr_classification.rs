use serde::{Deserialize, Serialize};

use crate::nostr_event::SignedNostrEvent;

pub const KIND_METADATA: u64 = 0;
pub const KIND_CONTACTS: u64 = 3;
pub const KIND_TEXT: u64 = 1;
pub const KIND_EVENT_METADATA: u64 = 513;
pub const KIND_COMMENT: u64 = 1111;
pub const KIND_AGENT_LESSON: u64 = 4129;
pub const KIND_PROJECT_AGENT_SNAPSHOT: u64 = 14199;
pub const KIND_PROJECT: u64 = 31933;
pub const KIND_TENEX_BOOT_PROJECT: u64 = 24000;
pub const KIND_TENEX_AGENT_CREATE: u64 = 24001;
pub const KIND_TENEX_PROJECT_STATUS: u64 = 24010;
pub const KIND_TENEX_INSTALLED_AGENT_LIST: u64 = 24011;
pub const KIND_TENEX_AGENT_CONFIG_UPDATE: u64 = 24020;
pub const KIND_TENEX_OPERATIONS_STATUS: u64 = 24133;
pub const KIND_TENEX_STREAM_TEXT_DELTA: u64 = 24135;

const NEVER_ROUTE_EVENT_KINDS: &[u64] = &[
    KIND_METADATA,
    KIND_CONTACTS,
    KIND_PROJECT_AGENT_SNAPSHOT,
    KIND_TENEX_PROJECT_STATUS,
    KIND_TENEX_INSTALLED_AGENT_LIST,
    KIND_TENEX_OPERATIONS_STATUS,
    KIND_TENEX_STREAM_TEXT_DELTA,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonNostrEventClass {
    NeverRoute,
    Project,
    Lesson,
    LessonComment,
    Conversation,
    Boot,
    AgentCreate,
    ConfigUpdate,
    Other,
}

impl DaemonNostrEventClass {
    pub fn should_normalize_for_worker(self) -> bool {
        matches!(self, Self::Conversation)
    }

    pub fn is_daemon_control_event(self) -> bool {
        matches!(
            self,
            Self::Project
                | Self::Lesson
                | Self::LessonComment
                | Self::Boot
                | Self::AgentCreate
                | Self::ConfigUpdate
        )
    }
}

pub fn classify_for_daemon(event: &SignedNostrEvent) -> DaemonNostrEventClass {
    if NEVER_ROUTE_EVENT_KINDS.contains(&event.kind) {
        return DaemonNostrEventClass::NeverRoute;
    }
    if event.kind == KIND_PROJECT {
        return DaemonNostrEventClass::Project;
    }
    if event.kind == KIND_AGENT_LESSON {
        return DaemonNostrEventClass::Lesson;
    }
    if is_lesson_comment(event) {
        return DaemonNostrEventClass::LessonComment;
    }
    if event.kind == KIND_TENEX_AGENT_CREATE {
        return DaemonNostrEventClass::AgentCreate;
    }
    if event.kind == KIND_TENEX_AGENT_CONFIG_UPDATE {
        return DaemonNostrEventClass::ConfigUpdate;
    }
    if matches!(event.kind, KIND_TEXT | KIND_EVENT_METADATA) {
        return DaemonNostrEventClass::Conversation;
    }
    if event.kind == KIND_TENEX_BOOT_PROJECT {
        return DaemonNostrEventClass::Boot;
    }
    DaemonNostrEventClass::Other
}

pub fn is_never_route_kind(kind: u64) -> bool {
    NEVER_ROUTE_EVENT_KINDS.contains(&kind)
}

pub fn is_lesson_comment(event: &SignedNostrEvent) -> bool {
    event.kind == KIND_COMMENT
        && event.tags.iter().any(|tag| {
            tag.first().is_some_and(|name| name == "K")
                && tag.get(1).is_some_and(|kind| kind == "4129")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_typescript_classify_for_daemon_cases() {
        assert_eq!(
            classify_for_daemon(&event(
                KIND_TENEX_AGENT_CONFIG_UPDATE,
                vec![vec!["p", "agent-pubkey"]]
            )),
            DaemonNostrEventClass::ConfigUpdate
        );
        assert_eq!(
            classify_for_daemon(&event(
                KIND_EVENT_METADATA,
                vec![
                    vec!["a", "31933:owner-pubkey:project-d-tag"],
                    vec!["e", "conversation-event-id"],
                ],
            )),
            DaemonNostrEventClass::Conversation
        );
        assert_eq!(
            classify_for_daemon(&event(
                30023,
                vec![vec!["a", "31933:owner-pubkey:project-d-tag"]],
            )),
            DaemonNostrEventClass::Other
        );
    }

    #[test]
    fn never_route_kinds_match_ts_daemon_exclusion_list() {
        for kind in [
            KIND_METADATA,
            KIND_CONTACTS,
            KIND_PROJECT_AGENT_SNAPSHOT,
            KIND_TENEX_PROJECT_STATUS,
            KIND_TENEX_INSTALLED_AGENT_LIST,
            KIND_TENEX_OPERATIONS_STATUS,
            KIND_TENEX_STREAM_TEXT_DELTA,
        ] {
            assert_eq!(
                classify_for_daemon(&event(kind, Vec::new())),
                DaemonNostrEventClass::NeverRoute,
                "kind {kind}"
            );
            assert!(is_never_route_kind(kind));
        }
    }

    #[test]
    fn daemon_control_and_worker_classes_are_distinct() {
        assert_eq!(
            classify_for_daemon(&event(KIND_PROJECT, vec![vec!["d", "project-alpha"]])),
            DaemonNostrEventClass::Project
        );
        assert_eq!(
            classify_for_daemon(&event(KIND_AGENT_LESSON, vec![vec!["e", "definition"]])),
            DaemonNostrEventClass::Lesson
        );
        assert_eq!(
            classify_for_daemon(&event(KIND_COMMENT, vec![vec!["K", "4129"]])),
            DaemonNostrEventClass::LessonComment
        );
        assert_eq!(
            classify_for_daemon(&event(KIND_TENEX_BOOT_PROJECT, Vec::new())),
            DaemonNostrEventClass::Boot
        );
        assert_eq!(
            classify_for_daemon(&event(KIND_TENEX_AGENT_CREATE, Vec::new())),
            DaemonNostrEventClass::AgentCreate
        );
        assert_eq!(
            classify_for_daemon(&event(KIND_TEXT, vec![vec!["p", "agent"]])),
            DaemonNostrEventClass::Conversation
        );
        assert!(DaemonNostrEventClass::Conversation.should_normalize_for_worker());
        assert!(!DaemonNostrEventClass::Boot.should_normalize_for_worker());
        assert!(DaemonNostrEventClass::Project.is_daemon_control_event());
        assert!(!DaemonNostrEventClass::NeverRoute.is_daemon_control_event());
    }

    fn event(kind: u64, tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: "1".repeat(64),
            created_at: 1_710_001_000,
            kind,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: String::new(),
            sig: "2".repeat(128),
        }
    }
}

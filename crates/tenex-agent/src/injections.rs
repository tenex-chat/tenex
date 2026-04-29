use std::path::PathBuf;

use tenex_conversations::{ConversationStore, MessageQuery, MessageRecord};

use crate::runtime_state::RuntimeStateHandle;

pub struct MessageInjectionTracker {
    db_path: PathBuf,
    conversation_id: String,
    agent_pubkey: String,
    include_untagged: bool,
    last_sequence: i64,
    runtime_state: Option<RuntimeStateHandle>,
}

impl MessageInjectionTracker {
    pub fn new(
        db_path: PathBuf,
        conversation_id: String,
        agent_pubkey: String,
        trigger_event_id: String,
        include_untagged: bool,
        runtime_state: Option<RuntimeStateHandle>,
    ) -> Self {
        let last_sequence = initial_sequence(&db_path, &conversation_id, &trigger_event_id);
        if let Some(state) = &runtime_state {
            state.mark_messages_consumed(&[trigger_event_id.clone()]);
        }
        Self {
            db_path,
            conversation_id,
            agent_pubkey,
            include_untagged,
            last_sequence,
            runtime_state,
        }
    }

    pub fn take_new_messages(&mut self) -> Option<String> {
        let store = ConversationStore::open(&self.db_path).ok()?;
        let messages = store
            .list_messages(&self.conversation_id, MessageQuery::default())
            .ok()?;
        let consumed = self
            .runtime_state
            .as_ref()
            .map(RuntimeStateHandle::consumed_message_ids)
            .unwrap_or_default();
        let new_messages: Vec<&MessageRecord> = messages
            .iter()
            .filter(|message| self.is_injectable(message, &consumed))
            .collect();
        if new_messages.is_empty() {
            return None;
        }

        self.last_sequence = new_messages
            .iter()
            .map(|message| message.sequence)
            .max()
            .unwrap_or(self.last_sequence);
        let event_ids: Vec<String> = new_messages
            .iter()
            .filter_map(|message| message.nostr_event_id.clone())
            .collect();
        if let Some(state) = &self.runtime_state {
            state.mark_messages_consumed(&event_ids);
        }

        let lines = new_messages
            .iter()
            .map(|message| {
                let event_id = message.nostr_event_id.as_deref().unwrap_or("local");
                format!(
                    "<message event_id=\"{}\" sequence=\"{}\">\n{}\n</message>",
                    escape_xml(event_id),
                    message.sequence,
                    escape_xml(&message.content)
                )
            })
            .collect::<Vec<_>>();

        Some(format!(
            "<system-reminder type=\"injected-user-messages\">\nNew user messages arrived while this execution was already running. Treat them as the latest user input for this next step.\n{}\n</system-reminder>",
            lines.join("\n")
        ))
    }

    fn is_injectable(
        &self,
        message: &MessageRecord,
        consumed: &std::collections::HashSet<String>,
    ) -> bool {
        if message.sequence <= self.last_sequence {
            return false;
        }
        if message
            .nostr_event_id
            .as_ref()
            .is_some_and(|event_id| consumed.contains(event_id))
        {
            return false;
        }
        if message.role.as_deref() != Some("user") || message.author_pubkey == self.agent_pubkey {
            return false;
        }

        match message.targeted_pubkeys.as_deref() {
            Some(targets) if !targets.is_empty() => {
                targets.iter().any(|target| target == &self.agent_pubkey)
            }
            _ => self.include_untagged,
        }
    }
}

fn initial_sequence(db_path: &PathBuf, conversation_id: &str, trigger_event_id: &str) -> i64 {
    let Ok(store) = ConversationStore::open(db_path) else {
        return -1;
    };
    let Ok(messages) = store.list_messages(conversation_id, MessageQuery::default()) else {
        return -1;
    };
    messages
        .iter()
        .find(|message| message.nostr_event_id.as_deref() == Some(trigger_event_id))
        .map(|message| message.sequence)
        .or_else(|| messages.iter().map(|message| message.sequence).max())
        .unwrap_or(-1)
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tenex_conversations::NewMessage;

    fn append_user(
        store: &ConversationStore,
        event_id: &str,
        content: &str,
        targets: Option<Vec<String>>,
    ) {
        store
            .append_message(
                "conv1",
                &NewMessage {
                    record_id: format!("event:{event_id}"),
                    nostr_event_id: Some(event_id.to_string()),
                    author_pubkey: "user1".to_string(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".to_string(),
                    role: Some("user".to_string()),
                    content: content.to_string(),
                    timestamp: None,
                    targeted_pubkeys: targets,
                    sender_principal: None,
                    targeted_principals: None,
                    tool_data: None,
                    delegation_marker: None,
                    human_readable: None,
                    transcript_tool_attributes: None,
                },
            )
            .unwrap();
    }

    #[test]
    fn injects_new_targeted_messages_once_and_marks_consumed() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("conversation.db");
        let store = ConversationStore::open(&db_path).unwrap();
        store.ensure_conversation("conv1").unwrap();
        append_user(&store, "trigger", "start", Some(vec!["agent1".to_string()]));
        append_user(
            &store,
            "followup",
            "also read 10 files",
            Some(vec!["agent1".to_string()]),
        );
        let runtime_state = RuntimeStateHandle::new(
            db_path.clone(),
            "conv1".to_string(),
            "agent1".to_string(),
            "exec1".to_string(),
        );
        let mut tracker = MessageInjectionTracker::new(
            db_path.clone(),
            "conv1".to_string(),
            "agent1".to_string(),
            "trigger".to_string(),
            false,
            Some(runtime_state),
        );

        let reminder = tracker.take_new_messages().unwrap();

        assert!(reminder.contains("also read 10 files"));
        assert!(tracker.take_new_messages().is_none());
        let state = ConversationStore::open(&db_path)
            .unwrap()
            .get_conversation("conv1")
            .unwrap()
            .unwrap()
            .runtime_state;
        assert!(state["rustRuntime"]["consumedMessages"]["followup"].is_object());
    }

    #[test]
    fn untagged_messages_only_inject_for_pm_agent() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("conversation.db");
        let store = ConversationStore::open(&db_path).unwrap();
        store.ensure_conversation("conv1").unwrap();
        append_user(&store, "trigger", "start", Some(vec!["agent1".to_string()]));
        append_user(&store, "followup", "untagged", None);

        let mut worker_tracker = MessageInjectionTracker::new(
            db_path.clone(),
            "conv1".to_string(),
            "agent1".to_string(),
            "trigger".to_string(),
            false,
            None,
        );
        let mut pm_tracker = MessageInjectionTracker::new(
            db_path,
            "conv1".to_string(),
            "agent1".to_string(),
            "trigger".to_string(),
            true,
            None,
        );

        assert!(worker_tracker.take_new_messages().is_none());
        assert!(pm_tracker.take_new_messages().is_some());
    }

    #[test]
    fn already_consumed_messages_are_not_injected() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("conversation.db");
        let store = ConversationStore::open(&db_path).unwrap();
        store.ensure_conversation("conv1").unwrap();
        append_user(&store, "trigger", "start", Some(vec!["agent1".to_string()]));
        append_user(
            &store,
            "followup",
            "already handled",
            Some(vec!["agent1".to_string()]),
        );
        let runtime_state = RuntimeStateHandle::new(
            db_path.clone(),
            "conv1".to_string(),
            "agent1".to_string(),
            "exec1".to_string(),
        );
        runtime_state.mark_messages_consumed(&["followup".to_string()]);
        let mut tracker = MessageInjectionTracker::new(
            db_path,
            "conv1".to_string(),
            "agent1".to_string(),
            "trigger".to_string(),
            false,
            Some(runtime_state),
        );

        assert!(tracker.take_new_messages().is_none());
    }
}

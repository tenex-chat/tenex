use super::super::*;
use crate::emit::{EmitState, EmitStateArgs};
use async_trait::async_trait;
use nostr::Keys;
use std::sync::Arc;
use tenex_conversations::model::ConversationRow;
use tenex_conversations::{NewMessage, NewToolMessage};
use tenex_protocol::{
    Channel, ChannelError, EncodingContext, Intent, MessageRef, PrincipalRef, ProjectRef,
};

pub(super) fn resolved() -> Arc<ResolvedModel> {
    Arc::new(ResolvedModel {
        provider: "anthropic".to_string(),
        model: "claude-3-sonnet".to_string(),
        api_key: None,
        base_url: None,
    })
}

struct NoopChannel {
    identity: PrincipalRef,
}

#[async_trait]
impl Channel for NoopChannel {
    fn name(&self) -> &'static str {
        "noop"
    }

    fn identity(&self) -> &PrincipalRef {
        &self.identity
    }

    async fn send(
        &self,
        _intent: Intent,
        _ctx: &EncodingContext,
    ) -> Result<Vec<MessageRef>, ChannelError> {
        Ok(vec![])
    }
}

pub(super) fn emit_state() -> Arc<EmitState> {
    let keys = Keys::generate();
    let pubkey = keys.public_key();
    let identity = PrincipalRef::nostr_agent(pubkey);
    let channel: Arc<dyn Channel> = Arc::new(NoopChannel {
        identity: identity.clone(),
    });
    Arc::new(EmitState::new(EmitStateArgs {
        channel,
        project: ProjectRef {
            author: pubkey,
            d_tag: "test".to_string(),
        },
        triggering_principal: identity,
        triggering_message: None,
        conversation_root: None,
        completion_recipient: None,
        model: "test:test".to_string(),
        team: None,
        current_branch: None,
        completion_project_a_tags: vec![],
    }))
}

pub(super) fn seed_db(
    path: &std::path::Path,
    conversation_id: &str,
    messages: &[(&str, &str, &str, i64)],
) {
    let store = ConversationStore::open(path).expect("open store");
    store
        .upsert_conversation(&ConversationRow {
            id: conversation_id.to_string(),
            title: Some("Test Conversation".to_string()),
            summary: None,
            last_user_message: None,
            status_label: None,
            status_current_activity: None,
            owner_pubkey: None,
            created_at: messages.first().map(|(_, _, _, timestamp)| *timestamp),
            last_activity: messages.last().map(|(_, _, _, timestamp)| *timestamp),
            metadata: serde_json::json!({}),
            runtime_state: serde_json::json!({}),
            updated_at: 0,
        })
        .expect("upsert conversation");
    for (i, (record_id, author, content, timestamp)) in messages.iter().enumerate() {
        store
            .append_message(
                conversation_id,
                &NewMessage {
                    record_id: record_id.to_string(),
                    nostr_event_id: record_id.strip_prefix("event:").map(str::to_string),
                    author_pubkey: author.to_string(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".to_string(),
                    role: Some(if i == 0 { "user" } else { "assistant" }.to_string()),
                    content: content.to_string(),
                    timestamp: Some(*timestamp),
                    targeted_pubkeys: None,
                    sender_principal: None,
                    targeted_principals: None,
                    tool_data: None,
                    delegation_marker: None,
                    human_readable: None,
                    transcript_tool_attributes: None,
                },
            )
            .expect("append message");
    }
}

pub(super) fn seed_tool(path: &std::path::Path, conversation_id: &str, timestamp_ms: i64) {
    let store = ConversationStore::open(path).expect("open store");
    store
        .record_tool_message(
            conversation_id,
            &NewToolMessage {
                tool_call_id: "toolcall123456".to_string(),
                parent_message_id: None,
                agent_pubkey: "agent0000abcdef".to_string(),
                tool_name: "conversation_get".to_string(),
                call_input: serde_json::json!({
                    "conversation_id": "target",
                    "description": "Retrieve full conversation content"
                }),
                result_output: Some(serde_json::json!("hidden result payload")),
                is_error: false,
                timestamp: Some(timestamp_ms),
            },
        )
        .expect("record tool message");
}

pub(super) fn messages_xml(output: &str) -> &str {
    output
}

pub(super) fn message_count(output: &str) -> usize {
    output.matches("<message").count()
}

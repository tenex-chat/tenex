//! Projection tests for in-flight runtime tools.

use serde_json::json;
use tenex_context::{Message, ModelProfile, project};
use tenex_conversations::{ConversationStore, NewMessage};

const CONVO_ID: &str = "conv-active-tools";
const AGENT_PUBKEY: &str = "agent-pubkey-test";
const USER_PUBKEY: &str = "user-pubkey-test";

fn open_store() -> ConversationStore {
    let store = ConversationStore::open_in_memory().expect("open in-memory store");
    store.ensure_conversation(CONVO_ID).expect("ensure convo");
    store
}

fn cacheable_profile() -> ModelProfile {
    ModelProfile {
        provider: "anthropic".into(),
        model_id: "claude-test".into(),
        prompt_cache: true,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 200_000,
    }
}

fn append_user_at(store: &ConversationStore, record_id: &str, content: &str, timestamp: i64) {
    let msg = NewMessage {
        record_id: record_id.into(),
        nostr_event_id: None,
        author_pubkey: USER_PUBKEY.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "message".into(),
        role: Some("user".into()),
        content: content.into(),
        timestamp: Some(timestamp),
        targeted_pubkeys: None,
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    store.append_message(CONVO_ID, &msg).expect("append");
}

#[tokio::test]
async fn active_tool_projects_as_pending_tool_pair_before_later_user_message() {
    let mut store = open_store();
    append_user_at(&store, "run", "run sleep 60", 1_777_464_675);
    append_user_at(&store, "kill", "kill the shell", 1_777_464_685);
    store
        .update_runtime_state(CONVO_ID, |state| {
            *state = json!({
                "rustRuntime": {
                    "activeTools": {
                        "execution-1:tool-call-1": {
                            "agentPubkey": AGENT_PUBKEY,
                            "conversationId": CONVO_ID,
                            "executionId": "execution-1",
                            "toolCallId": "tool-call-1",
                            "toolName": "shell",
                            "args": {
                                "command": "sleep 60",
                                "description": "Run sleep command for 60 seconds",
                                "timeout": 90
                            },
                            "startedAt": 1_777_464_679_000i64
                        }
                    }
                }
            });
        })
        .expect("runtime state");

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        None,
    )
    .await
    .expect("project");

    assert!(
        matches!(projection.messages[1], Message::User { ref content } if content == "run sleep 60")
    );
    assert!(matches!(
        &projection.messages[2],
        Message::Assistant { content, tool_calls, .. }
            if content.is_empty()
                && tool_calls.len() == 1
                && tool_calls[0].id == "tool-call-1"
                && tool_calls[0].name == "shell"
                && tool_calls[0].arguments["command"] == "sleep 60"
    ));
    assert!(matches!(
        &projection.messages[3],
        Message::ToolResult { tool_call_id, tool_name, content, is_error, .. }
            if tool_call_id == "tool-call-1"
                && tool_name == "shell"
                && !is_error
                && content.contains("pending-tool-result")
                && content.contains("sleep 60")
    ));
    assert!(
        matches!(projection.messages[4], Message::User { ref content } if content == "kill the shell")
    );
}

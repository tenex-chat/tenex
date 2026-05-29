//! Diagnostic test that prints the full projected `messages[]` for the
//! pending and completed delegation scenarios. Run with:
//!
//!   cargo test -p tenex-context --test print_delegation_projection -- --nocapture
//!
//! Kept as a real `#[tokio::test]` so it stays compiled and any
//! regressions in the rendered shape surface here too.

use tenex_context::{project, DisplayNameResolver, Message, ModelProfile};
use tenex_conversations::{
    ConversationStore, DelegationMarker, DelegationStatus, NewMessage, NewToolMessage,
};

const CONV: &str = "rootevent12345";
const AGENT1_PK: &str = "agent1-pubkey-hex";
const AGENT2_PK: &str = "agent2-pubkey-hex";

struct Names;
impl DisplayNameResolver for Names {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        match pubkey {
            AGENT1_PK => Some("agent1".into()),
            AGENT2_PK => Some("agent2".into()),
            "user-pk" => Some("human".into()),
            _ => None,
        }
    }
}

fn put_user(
    store: &ConversationStore,
    conv: &str,
    record_id: &str,
    event_id: Option<&str>,
    author: &str,
    content: &str,
    ts: i64,
    targeted: Option<Vec<String>>,
) -> i64 {
    store
        .append_message(
            conv,
            &NewMessage {
                record_id: record_id.into(),
                nostr_event_id: event_id.map(String::from),
                author_pubkey: author.into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
                content: content.into(),
                timestamp: Some(ts),
                targeted_pubkeys: targeted,
                sender_principal: None,
                targeted_principals: None,
                tool_data: None,
                delegation_marker: None,
                human_readable: None,
                transcript_tool_attributes: None,
            },
        )
        .unwrap()
}

fn put_assistant(
    store: &ConversationStore,
    conv: &str,
    record_id: &str,
    author: &str,
    content: &str,
    ts: i64,
) -> i64 {
    store
        .append_message(
            conv,
            &NewMessage {
                record_id: record_id.into(),
                nostr_event_id: None,
                author_pubkey: author.into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("assistant".into()),
                content: content.into(),
                timestamp: Some(ts),
                targeted_pubkeys: None,
                sender_principal: None,
                targeted_principals: None,
                tool_data: None,
                delegation_marker: None,
                human_readable: None,
                transcript_tool_attributes: None,
            },
        )
        .unwrap()
}

fn put_tool(
    store: &ConversationStore,
    conv: &str,
    parent_msg_id: i64,
    tool_call_id: &str,
    name: &str,
    input: serde_json::Value,
    output: serde_json::Value,
    ts: i64,
) {
    store
        .record_tool_message(
            conv,
            &NewToolMessage {
                tool_call_id: tool_call_id.into(),
                parent_message_id: Some(parent_msg_id),
                agent_pubkey: AGENT1_PK.into(),
                tool_name: name.into(),
                call_input: input,
                result_output: Some(output),
                is_error: false,
                timestamp: Some(ts * 1000),
            },
        )
        .unwrap();
}

fn build_scenario(store: &ConversationStore) -> i64 {
    store.ensure_conversation(CONV).unwrap();

    // 1. Human triggers agent1.
    put_user(
        store,
        CONV,
        "event:root",
        Some(CONV),
        "user-pk",
        "delegate to agent2 ask for a colour and report back",
        1779879578,
        None,
    );

    // 2. Agent1 invocation 1, step 1: emits delegate tool call.
    let assistant_row = put_assistant(
        store,
        CONV,
        "step:exec1:agent1:1",
        AGENT1_PK,
        "", // no text, only tool call
        1779879579,
    );
    put_tool(
        store,
        CONV,
        assistant_row,
        "delegate-call-1",
        "delegate",
        serde_json::json!({"recipient": "agent2", "prompt": "pick a colour"}),
        serde_json::json!(
            "Delegated to @agent2. Delegation event ID: bb7bd910abcdef0123456789. \
             Use this ID with delegate_followup if you need to send corrections before they finish. \
             Stop here — do not take further actions this turn."
        ),
        1779879580,
    );

    // 3. The delegate tool also writes the Pending marker (same step,
    //    same instant). Real code does this inside `delegate.rs` after
    //    `channel.send` returns.
    let pending = DelegationMarker {
        delegation_conversation_id: "bb7bd910abcdef0123456789".into(),
        recipient_pubkey: AGENT2_PK.into(),
        parent_conversation_id: CONV.into(),
        initiated_at: Some(1779879580),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONV, &pending, AGENT1_PK, Some(1))
        .unwrap();

    // 4. Agent1 invocation 1, step 2 (terminal): "Waiting for agent2..."
    put_assistant(
        store,
        CONV,
        "step:exec1:agent1:2",
        AGENT1_PK,
        "Waiting for agent2 to respond with a colour.",
        1779879581,
    );

    // Snapshot point: pending scenario. (We'll print the projection here.)
    assistant_row
}

#[tokio::test]
async fn print_pending_and_completed_projections() {
    let store = ConversationStore::open_in_memory().unwrap();
    build_scenario(&store);

    let resolver = Names;
    let profile = ModelProfile {
        provider: "test".into(),
        model_id: "model".into(),
        prompt_cache: false,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 200_000,
    };

    println!("\n=========================================================");
    println!("SCENARIO 1: delegation is PENDING (agent2 hasn't replied yet)");
    println!("=========================================================");
    let projection = project(
        &store,
        CONV,
        AGENT1_PK,
        "<agent1 system prompt>",
        &profile,
        &[],
        None,
        Some(&resolver),
        None,
        None,
    )
    .await
    .unwrap();
    for (i, m) in projection.messages.iter().enumerate() {
        print_message(i, m);
    }

    // 5. Time passes. Agent2 publishes its reply in its child conversation.
    store.ensure_conversation("bb7bd910abcdef0123456789").unwrap();
    put_user(
        &store,
        "bb7bd910abcdef0123456789",
        "event:delegation-req",
        Some("delegation-req"),
        AGENT1_PK,
        "pick a colour",
        1779879580,
        Some(vec![AGENT2_PK.into()]),
    );
    put_assistant(
        &store,
        "bb7bd910abcdef0123456789",
        "step:exec2:agent2:1",
        AGENT2_PK,
        "", // no terminal text yet
        1779879600,
    );
    // Agent2's terminal published as kind:1, status=completed → runtime
    // sees it and updates the parent's marker (replaces persist_user_message).
    // We simulate that by appending an assistant row in the child conv
    // representing the published completion, then doing the update.
    let child_terminal_row = put_assistant(
        &store,
        "bb7bd910abcdef0123456789",
        "event:agent2-completion",
        AGENT2_PK,
        "Black — RGB(0,0,0)",
        1779879612,
    );
    // Stamp the event_id so the row counts as a published completion.
    store
        .set_message_event_id(child_terminal_row, "agent2-reply-evt")
        .unwrap();

    // 6. Runtime upserts the Completed marker on agent1's parent conv.
    store
        .update_delegation_marker(
            CONV,
            "bb7bd910abcdef0123456789",
            AGENT2_PK,
            AGENT1_PK,
            DelegationStatus::Completed,
            1779879612,
            None,
        )
        .unwrap();

    println!("\n=========================================================");
    println!("SCENARIO 2: delegation has COMPLETED (agent2's reply arrived)");
    println!("=========================================================");
    let projection = project(
        &store,
        CONV,
        AGENT1_PK,
        "<agent1 system prompt>",
        &profile,
        &[],
        None,
        Some(&resolver),
        None,
        None,
    )
    .await
    .unwrap();
    for (i, m) in projection.messages.iter().enumerate() {
        print_message(i, m);
    }
    println!();
}

fn print_message(i: usize, m: &Message) {
    let kind = match m {
        Message::System { .. } => "System",
        Message::User { .. } => "User",
        Message::Assistant { .. } => "Assistant",
        Message::ToolResult { .. } => "ToolResult",
        Message::DelegationMarker { .. } => "DelegationMarker (unexpanded)",
    };
    println!("\n[{i}] {kind}");
    match m {
        Message::System { content } => {
            println!("    content: {content:?}");
        }
        Message::User { content, attachments } => {
            for line in content.lines() {
                println!("    | {line}");
            }
            if !attachments.is_empty() {
                println!("    attachments: {} item(s)", attachments.len());
            }
        }
        Message::Assistant {
            content,
            reasoning,
            tool_calls,
        } => {
            if !content.is_empty() {
                for line in content.lines() {
                    println!("    | {line}");
                }
            } else {
                println!("    (no text content)");
            }
            for (i, tc) in tool_calls.iter().enumerate() {
                println!(
                    "    tool_call #{i}: id={:?} name={:?} args={}",
                    tc.id, tc.name, tc.arguments
                );
            }
            if !reasoning.is_empty() {
                println!("    reasoning: {} block(s)", reasoning.len());
            }
        }
        Message::ToolResult {
            tool_call_id,
            tool_name,
            content,
            is_error,
            ..
        } => {
            println!(
                "    tool_call_id={tool_call_id:?} tool_name={tool_name:?} is_error={is_error}"
            );
            for line in content.lines() {
                println!("    | {line}");
            }
        }
        Message::DelegationMarker { marker, .. } => {
            println!(
                "    delegation_conv={:?} recipient={:?} parent={:?} status={:?}",
                marker.delegation_conversation_id,
                marker.recipient_pubkey,
                marker.parent_conversation_id,
                marker.status,
            );
        }
    }
}

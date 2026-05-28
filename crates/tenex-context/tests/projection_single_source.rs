//! Single-source-of-truth integration tests.
//!
//! These tests assert the exact `messages[]` array shape that
//! `tenex_context::project` produces at every load-bearing seam after
//! the splice/in-memory-tail removal. They simulate the persistence
//! patterns the runtime + agent runner would produce in production
//! (trigger event, step assistant, tool messages, supervision nudge,
//! delegation callback) and then project — no live agent process
//! required.
//!
//! Each test is the new architecture's contract: if these assertions
//! pass, projection is sound at the points where Bug A / Bug B / the
//! splice-related bugs used to live.

use serde_json::json;
use tenex_context::{
    project_with_options, BreakpointHint, BreakpointKind, DisplayNameResolver, Message,
    ModelProfile, ProjectionOptions,
};
use tenex_conversations::{
    ConversationStore, DelegationMarker, DelegationStatus, NewMessage, NewToolMessage,
};

const CONVO_ID: &str = "conv-test-001";
const AGENT1: &str = "pubkey-agent1";
const AGENT2: &str = "pubkey-agent2";
const SYSTEM_PROMPT: &str = "SYSTEM";

fn profile() -> ModelProfile {
    ModelProfile {
        provider: "test".into(),
        model_id: "model".into(),
        prompt_cache: false,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 200_000,
    }
}

fn open_store_with_conv() -> ConversationStore {
    let s = ConversationStore::open_in_memory().expect("open in-memory");
    s.ensure_conversation(CONVO_ID).unwrap();
    s
}

fn append_user(
    store: &ConversationStore,
    record_id: &str,
    nostr_event_id: Option<&str>,
    author: &str,
    content: &str,
    ts: i64,
) -> i64 {
    store
        .append_message(
            CONVO_ID,
            &NewMessage {
                record_id: record_id.into(),
                nostr_event_id: nostr_event_id.map(str::to_string),
                author_pubkey: author.into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
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

fn append_assistant(
    store: &ConversationStore,
    record_id: &str,
    author: &str,
    content: &str,
    ts: i64,
) -> i64 {
    store
        .append_message(
            CONVO_ID,
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

fn append_supervision_nudge(
    store: &ConversationStore,
    record_id: &str,
    author: &str,
    content: &str,
    ts: i64,
) -> i64 {
    store
        .append_message(
            CONVO_ID,
            &NewMessage {
                record_id: record_id.into(),
                nostr_event_id: None,
                author_pubkey: author.into(),
                sender_pubkey: None,
                ral: None,
                message_type: "supervision".into(),
                role: Some("user".into()),
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

fn record_tool(
    store: &ConversationStore,
    parent: i64,
    agent: &str,
    name: &str,
    input: serde_json::Value,
    output: Option<serde_json::Value>,
    ts: i64,
) {
    store
        .record_tool_message(
            CONVO_ID,
            &NewToolMessage {
                tool_call_id: format!("call-{}-{}", name, ts),
                parent_message_id: Some(parent),
                agent_pubkey: agent.into(),
                tool_name: name.into(),
                call_input: input,
                result_output: output,
                is_error: false,
                timestamp: Some(ts),
            },
        )
        .unwrap();
}

fn opts() -> ProjectionOptions {
    ProjectionOptions {
        excluded_event_id: None,
        in_turn_tail: Vec::new(),
        compaction_override: None,
        proactive_context: None,
    }
}

async fn project(store: &ConversationStore, agent: &str) -> Vec<Message> {
    project_with_options(
        store,
        CONVO_ID,
        agent,
        SYSTEM_PROMPT,
        &profile(),
        &[],
        None,
        None,
        opts(),
    )
    .await
    .unwrap()
    .messages
}

fn user(content: &str) -> Message {
    Message::User {
        content: content.into(),
        attachments: Vec::new(),
    }
}

fn assistant_text(content: &str) -> Message {
    Message::Assistant {
        content: content.into(),
        reasoning: Vec::new(),
        tool_calls: Vec::new(),
    }
}

// ============================================================================
// Test 1: single-agent multi-turn
// ============================================================================

#[tokio::test]
async fn single_agent_two_turns_projects_in_storage_order() {
    let store = open_store_with_conv();

    // Turn 1: user asks; assistant answers terminally.
    append_user(&store, "event:t1", Some("t1"), "user-pk", "What's 2+2?", 100);
    let before_step1 = project(&store, AGENT1).await;
    assert_eq!(
        before_step1,
        vec![
            Message::System { content: SYSTEM_PROMPT.into() },
            user("What's 2+2?"),
        ],
        "pre-step projection sees only system + trigger"
    );

    append_assistant(&store, "step:exec1:agent1:1", AGENT1, "4", 101);
    let after_step1 = project(&store, AGENT1).await;
    assert_eq!(
        after_step1,
        vec![
            Message::System { content: SYSTEM_PROMPT.into() },
            user("What's 2+2?"),
            assistant_text("4"),
        ],
        "post-step projection includes the assistant row in sequence order"
    );

    // Turn 2: another user message lands in the same conversation.
    append_user(&store, "event:t2", Some("t2"), "user-pk", "And 3*3?", 200);
    let before_step2 = project(&store, AGENT1).await;
    assert_eq!(
        before_step2,
        vec![
            Message::System { content: SYSTEM_PROMPT.into() },
            user("What's 2+2?"),
            assistant_text("4"),
            user("And 3*3?"),
        ],
        "turn 2's projection chains storage rows in order — no splicing required"
    );
}

// ============================================================================
// Test 2: two-agent delegation flow (Bug A reproduction)
//
// Mirrors the production trace where agent1 delegated to agent2, agent2 replied
// "Black — RGB(0,0,0)", and agent1's callback invocation infinitely re-emitted
// the delegate. Under the old splice, the supervision nudge ended up positioned
// BEFORE the prior delegate tool call in projection, so the model read its own
// stale tool calls as a response. Under the new architecture, the rows appear
// in storage order (sequence), so the model sees a coherent timeline.
// ============================================================================

#[tokio::test]
async fn delegation_callback_projects_in_strict_storage_order() {
    let store = open_store_with_conv();

    // Step 1: human asks agent1 for a poem with a colour.
    append_user(
        &store,
        "event:root",
        Some("root"),
        "user-pk",
        "delegate to agent2 ask for a colour then write a poem",
        100,
    );

    // Agent1 invocation 1: emits delegate tool call (assistant row with no text +
    // tool_message linked by parent_message_id).
    let agent1_step1 = append_assistant(
        &store,
        "step:exec-a1-inv1:agent1:1",
        AGENT1,
        "",
        101,
    );
    record_tool(
        &store,
        agent1_step1,
        AGENT1,
        "delegate",
        json!({"recipient": "agent2", "prompt": "give me a colour"}),
        Some(json!("Black — RGB(0,0,0)")),
        102,
    );

    // Agent2 publishes its terminal in its own subconversation, but in the
    // production model the delegatee's reply is materialized into agent1's
    // conversation by the runtime as a new user-role row (the delegation
    // callback trigger). Simulate that.
    append_user(
        &store,
        "event:agent2-reply",
        Some("agent2-reply"),
        AGENT2,
        "Black — RGB(0,0,0)",
        200,
    );

    // Agent1 invocation 2 (callback). At this point — BEFORE step1 of inv2
    // runs — the projection must show the timeline in strict order:
    //   [system, root user, agent1 delegate, tool_result, agent2 reply user]
    let pre_callback = project(&store, AGENT1).await;
    assert_eq!(
        pre_callback,
        vec![
            Message::System { content: SYSTEM_PROMPT.into() },
            user("delegate to agent2 ask for a colour then write a poem"),
            Message::Assistant {
                content: String::new(),
                reasoning: Vec::new(),
                tool_calls: vec![tenex_context::ToolCall {
                    id: format!("call-delegate-{}", 102),
                    provider_call_id: None,
                    name: "delegate".into(),
                    arguments: json!({"recipient": "agent2", "prompt": "give me a colour"}),
                }],
            },
            Message::ToolResult {
                tool_call_id: format!("call-delegate-{}", 102),
                tool_name: "delegate".into(),
                content: "Black — RGB(0,0,0)".into(),
                provider_call_id: None,
                is_error: false,
            },
            user("Black — RGB(0,0,0)"),
        ],
        "delegation callback timeline must be in storage order; the seam where Bug A used to live"
    );

    // Agent1 invocation 2 step 1: writes a terminal "Black like the night" assistant row.
    append_assistant(
        &store,
        "step:exec-a1-inv2:agent1:1",
        AGENT1,
        "Black like the night sky.",
        300,
    );

    let post_callback = project(&store, AGENT1).await;
    assert_eq!(
        post_callback.len(),
        6,
        "projection now includes the inv-2 terminal assistant at the tail"
    );
    assert_eq!(
        post_callback.last(),
        Some(&assistant_text("Black like the night sky.")),
    );
}

// ============================================================================
// Test 3: re-engagement flow (supervision nudge projects as user message)
// ============================================================================

#[tokio::test]
async fn supervision_nudge_projects_as_user_and_preserves_header() {
    let store = open_store_with_conv();

    append_user(
        &store,
        "event:root",
        Some("root"),
        "user-pk",
        "do A and B",
        100,
    );

    // Step 1: assistant says "started, did A" terminally. (Real runner might
    // have done a todo_write too; we keep it simple here.)
    append_assistant(
        &store,
        "step:exec1:agent1:1",
        AGENT1,
        "Started on A and B.",
        101,
    );

    // Supervision fires: there are pending todos.
    append_supervision_nudge(
        &store,
        "supervision:exec1:0",
        AGENT1,
        "Your original task was: do A and B. You have unfinished todo items: t-b. Please continue.",
        200,
    );

    let projected = project(&store, AGENT1).await;
    assert_eq!(
        projected,
        vec![
            Message::System { content: SYSTEM_PROMPT.into() },
            user("do A and B"),
            assistant_text("Started on A and B."),
            user("Your original task was: do A and B. You have unfinished todo items: t-b. Please continue."),
        ],
        "supervision nudge appears as a User message at the tail — agent loop will respond"
    );

    // Header guard: last_user_message must still reflect the ACTUAL last human
    // message ("do A and B"), not the supervision text.
    let header = store.get_conversation(CONVO_ID).unwrap().unwrap();
    assert_eq!(
        header.last_user_message.as_deref(),
        Some("do A and B"),
        "supervision rows must NOT clobber conversations.last_user_message"
    );
}

// ============================================================================
// Test 4: image attachments survive the projection seam
// ============================================================================

#[tokio::test]
async fn image_attachments_project_alongside_user_text() {
    let store = open_store_with_conv();

    let row = append_user(
        &store,
        "event:img",
        Some("img"),
        "user-pk",
        "describe this image",
        100,
    );
    store
        .record_attachment(row, 0, "image/png", &[0x89, 0x50, 0x4e, 0x47], Some("https://x/a.png"))
        .unwrap();
    store
        .record_attachment(row, 1, "image/jpeg", &[0xFF, 0xD8, 0xFF], Some("https://x/b.jpg"))
        .unwrap();

    let projected = project(&store, AGENT1).await;
    let Message::User {
        content,
        attachments,
    } = &projected[1]
    else {
        panic!("expected user message at index 1");
    };
    assert_eq!(content, "describe this image");
    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].media_type, "image/png");
    assert_eq!(attachments[0].data, vec![0x89, 0x50, 0x4e, 0x47]);
    assert_eq!(attachments[1].media_type, "image/jpeg");
    assert_eq!(
        attachments[1].source_url.as_deref(),
        Some("https://x/b.jpg")
    );
}

// ============================================================================
// Test 5: proactive context overlays on the last visible message
// ============================================================================

#[tokio::test]
async fn proactive_context_overlays_last_message_via_strategy() {
    let store = open_store_with_conv();
    append_user(&store, "event:t1", Some("t1"), "user-pk", "hello", 100);

    let opts = ProjectionOptions {
        excluded_event_id: None,
        in_turn_tail: Vec::new(),
        compaction_override: None,
        proactive_context: Some(
            "<proactive-context>\nfound: prior reply 'Black'\n</proactive-context>".into(),
        ),
    };
    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT1,
        SYSTEM_PROMPT,
        &profile(),
        &[],
        None,
        None,
        opts,
    )
    .await
    .unwrap();

    let Message::User { content, .. } = &projection.messages[1] else {
        panic!("expected user");
    };
    assert!(
        content.starts_with("hello\n\n<proactive-context>"),
        "block appended to last non-system message; system prompt itself stays clean. got {content:?}"
    );
    assert_eq!(
        projection.messages[0],
        Message::System { content: SYSTEM_PROMPT.into() },
        "system prompt is stable — prompt cache anchor stays warm"
    );
}

// ============================================================================
// Test 6: cache breakpoint still emits on first non-system message
// ============================================================================

// ============================================================================
// Delegation completion attribution — the headline feature recovered from
// the deleted TypeScript implementation.
// ============================================================================

struct StubNameResolver;
impl DisplayNameResolver for StubNameResolver {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        match pubkey {
            AGENT1 => Some("agent1".into()),
            AGENT2 => Some("agent2".into()),
            "user-pk" => Some("human".into()),
            _ => None,
        }
    }
}

#[tokio::test]
async fn delegation_completed_projects_with_delegation_completed_header_and_transcript() {
    // The whole point of this refactor: agent1 delegates to agent2;
    // agent2 publishes a colour; the runtime updates the parent's
    // delegation marker; agent1's next projection should see a
    // `# DELEGATION COMPLETED` block carrying the child transcript as
    // XML — exactly the shape the deleted TS implementation produced
    // (`src/conversations/MessageBuilder.ts:expandDelegationMarker`).

    let store = open_store_with_conv();

    // The conversation root: human's task to agent1.
    append_user(
        &store,
        CONVO_ID,
        Some(CONVO_ID),
        "user-pk",
        "delegate to agent2 and report back",
        100,
    );

    // Agent1's invocation 1: writes a Pending delegation marker for
    // child conversation `delegation-evt-1` (which IS the delegation
    // event id in the Nostr-rooted model).
    let pending = DelegationMarker {
        delegation_conversation_id: "delegation-evt-1".into(),
        recipient_pubkey: AGENT2.into(),
        parent_conversation_id: CONVO_ID.into(),
        initiated_at: Some(101),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONVO_ID, &pending, AGENT1, None)
        .unwrap();

    // Time passes. Agent2 runs in its own child conversation.
    store
        .ensure_conversation("delegation-evt-1")
        .unwrap();
    append_user(
        &store,
        "delegation-evt-1",
        Some("dlg-trigger"),
        AGENT1,
        "pick a colour",
        102,
    );
    // Agent2's response in its child conversation, persisted with role=user
    // (in the production runtime this is what `persist_user_message` writes
    // for the agent's published CompletionIntent).
    let child_reply = NewMessage {
        record_id: "event:agent2-reply".into(),
        nostr_event_id: Some("agent2-reply".into()),
        author_pubkey: AGENT2.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "text".into(),
        role: Some("user".into()),
        content: "Black — RGB(0,0,0)".into(),
        timestamp: Some(150),
        targeted_pubkeys: Some(vec![AGENT1.into()]),
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    store
        .append_message("delegation-evt-1", &child_reply)
        .unwrap();

    // Runtime sees agent2's completion event and updates the parent
    // marker. This is the load-bearing call — replaces what TS's
    // `RALResolver.updateDelegationMarker` did.
    store
        .update_delegation_marker(
            CONVO_ID,
            "delegation-evt-1",
            AGENT2,
            AGENT1,
            DelegationStatus::Completed,
            200,
            None,
        )
        .unwrap();

    // Agent1's callback invocation projects:
    let resolver = StubNameResolver;
    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT1,
        SYSTEM_PROMPT,
        &profile(),
        &[],
        None,
        Some(&resolver),
        opts(),
    )
    .await
    .unwrap();

    // Shape: System + User(original task) + the expanded marker as a User.
    let expanded_user = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .find(|c| c.starts_with("# DELEGATION COMPLETED"))
        .expect("# DELEGATION COMPLETED block must appear in agent1's projection");

    // Header shape.
    assert!(
        expanded_user.starts_with("# DELEGATION COMPLETED\n\n### Transcript:\n"),
        "got: {expanded_user}"
    );
    // Transcript is an embedded <conversation>...</conversation>.
    assert!(expanded_user.contains("<conversation id=\"delegation\""));
    // The child's reply text and attribution are inside the XML.
    assert!(expanded_user.contains("Black — RGB(0,0,0)"));
    assert!(expanded_user.contains("author=\"agent2\""));
    assert!(expanded_user.contains("recipient=\"agent1\""));

    // No raw "Black — RGB(0,0,0)" user message at the tail — the
    // marker IS the user message. (Bug B-shape regression: the bare
    // injection should not appear as a separate row.)
    let raw_black_count = projection
        .messages
        .iter()
        .filter(|m| matches!(m, Message::User { content, .. } if content == "Black — RGB(0,0,0)"))
        .count();
    assert_eq!(
        raw_black_count, 0,
        "raw bare delegatee text must not appear as a sibling user message"
    );

    // Only the LATEST marker per delegation surfaces — the pending row
    // is filtered out by `project_messages`.
    let pending_renders = projection
        .messages
        .iter()
        .filter(|m| matches!(m, Message::User { content, .. } if content.contains("# DELEGATION IN PROGRESS")))
        .count();
    assert_eq!(pending_renders, 0, "older Pending marker must be dropped");
}

#[tokio::test]
async fn delegation_pending_projects_as_system_reminder_overlay_not_user_message() {
    // While agent2 is still working, agent1's projection must NOT show
    // a freestanding user message for the pending delegation — that
    // would look like fresh input. Instead, a `<system-reminder>
    // <agent-delegations>` block is overlaid on the last visible
    // message, exactly like the todo-list reminder. The agent gets
    // continuous awareness of outstanding delegations as state, not
    // as content to respond to.

    let store = open_store_with_conv();
    append_user(&store, CONVO_ID, Some(CONVO_ID), "user-pk", "task", 100);

    let pending = DelegationMarker {
        delegation_conversation_id: "delegation-evt-1".into(),
        recipient_pubkey: AGENT2.into(),
        parent_conversation_id: CONVO_ID.into(),
        initiated_at: Some(101),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONVO_ID, &pending, AGENT1, None)
        .unwrap();

    let resolver = StubNameResolver;
    let projection = project_with_options(
        &store, CONVO_ID, AGENT1, SYSTEM_PROMPT, &profile(),
        &[], None, Some(&resolver), opts(),
    )
    .await
    .unwrap();

    // (1) No `# DELEGATION IN PROGRESS` user message appears — the
    // pending marker is *state*, not content.
    let progress_as_user_msg = projection.messages.iter().any(|m| matches!(
        m,
        Message::User { content, .. } if content.starts_with("# DELEGATION IN PROGRESS")
    ));
    assert!(
        !progress_as_user_msg,
        "pending delegations must not produce a standalone user message"
    );

    // (2) The `<system-reminder>` overlay is appended to the last
    // visible non-system message (the trigger user message here).
    let Message::User { content, .. } = projection.messages.last().unwrap() else {
        panic!("last message should be the trigger user message");
    };
    assert!(
        content.contains("<system-reminder>\n<agent-delegations>"),
        "reminder block must overlay last message: {content}"
    );
    assert!(
        content.contains("[~] @agent2 (delegation: delegation...) — pending"),
        "marker entry must be present in reminder block: {content}"
    );
    assert!(
        content.contains("**ATTENTION:** You have 1 outstanding delegation"),
        "ATTENTION nudge must be present"
    );
    // (3) Sanity: original message content is preserved before the
    // reminder, separated by a blank line.
    assert!(content.starts_with("[human] task\n\n<system-reminder>"));
}

#[tokio::test]
async fn delegation_aborted_projects_with_reason() {
    let store = open_store_with_conv();
    append_user(&store, CONVO_ID, Some(CONVO_ID), "user-pk", "task", 100);
    store.ensure_conversation("delegation-evt-1").unwrap();

    let pending = DelegationMarker {
        delegation_conversation_id: "delegation-evt-1".into(),
        recipient_pubkey: AGENT2.into(),
        parent_conversation_id: CONVO_ID.into(),
        initiated_at: Some(101),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONVO_ID, &pending, AGENT1, None)
        .unwrap();
    store
        .update_delegation_marker(
            CONVO_ID,
            "delegation-evt-1",
            AGENT2,
            AGENT1,
            DelegationStatus::Aborted,
            200,
            Some("agent2 was killed".to_string()),
        )
        .unwrap();

    let resolver = StubNameResolver;
    let projection = project_with_options(
        &store, CONVO_ID, AGENT1, SYSTEM_PROMPT, &profile(),
        &[], None, Some(&resolver), opts(),
    )
    .await
    .unwrap();

    let aborted = projection
        .messages
        .iter()
        .find_map(|m| match m {
            Message::User { content, .. } if content.starts_with("# DELEGATION ABORTED") => Some(content.as_str()),
            _ => None,
        })
        .expect("# DELEGATION ABORTED must surface");
    assert!(aborted.contains("**Reason:** agent2 was killed"));
    assert!(aborted.contains("### Transcript:\n<conversation"));
}

#[tokio::test]
async fn delegation_completion_lands_at_its_own_sequence_position_not_where_delegate_was_issued() {
    // Scenario: agent1 delegates to agent2 (seq N). While agent2 is
    // working, the human keeps replying to agent1 — adding 5 more user
    // messages (seq N+1 … N+5). When agent2 finally completes, the
    // runtime upserts a `Completed` marker (seq N+6). The completion
    // MUST appear *after* the 5 intervening messages — that's its real
    // place in the conversation timeline. The pending marker at seq N
    // gets dropped (we surface only the latest marker per delegation).

    let store = open_store_with_conv();
    append_user(
        &store,
        "event:root",
        Some(CONVO_ID),
        "user-pk",
        "original task",
        100,
    );

    // Seq N: pending marker (the `delegate` call).
    let pending = DelegationMarker {
        delegation_conversation_id: "delegation-evt-1".into(),
        recipient_pubkey: AGENT2.into(),
        parent_conversation_id: CONVO_ID.into(),
        initiated_at: Some(101),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONVO_ID, &pending, AGENT1, None)
        .unwrap();

    // Seq N+1 … N+5: human keeps adding messages while agent2 works.
    for (i, txt) in [
        "follow-up 1",
        "follow-up 2",
        "follow-up 3",
        "follow-up 4",
        "follow-up 5",
    ]
    .iter()
    .enumerate()
    {
        let evt_id = format!("evt-followup-{i}");
        append_user(
            &store,
            &format!("event:{evt_id}"),
            Some(&evt_id),
            "user-pk",
            txt,
            110 + i as i64,
        );
    }

    // Child transcript content (just enough so the rendered XML carries
    // the reply text).
    store.ensure_conversation("delegation-evt-1").unwrap();
    let child_reply = NewMessage {
        record_id: "event:reply".into(),
        nostr_event_id: Some("reply".into()),
        author_pubkey: AGENT2.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "text".into(),
        role: Some("user".into()),
        content: "Black — RGB(0,0,0)".into(),
        timestamp: Some(199),
        targeted_pubkeys: Some(vec![AGENT1.into()]),
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    store
        .append_message("delegation-evt-1", &child_reply)
        .unwrap();

    // Seq N+6: completion marker.
    store
        .update_delegation_marker(
            CONVO_ID,
            "delegation-evt-1",
            AGENT2,
            AGENT1,
            DelegationStatus::Completed,
            200,
            None,
        )
        .unwrap();

    let resolver = StubNameResolver;
    let projection = project_with_options(
        &store, CONVO_ID, AGENT1, SYSTEM_PROMPT, &profile(),
        &[], None, Some(&resolver), opts(),
    )
    .await
    .unwrap();

    // Collect the User-message content in order.
    let user_contents: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();

    // Find each text in the projection and assert ordering. Using
    // `contains` because multi-author projection prefixes each user
    // message with `[name]` once two distinct user-authoring pubkeys
    // appear in the conversation (human + agent1 from the markers).
    let pos = |needle: &str| -> usize {
        user_contents
            .iter()
            .position(|c| c.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} not in projection: {user_contents:#?}"))
    };
    let original = pos("original task");
    let f1 = pos("follow-up 1");
    let f5 = pos("follow-up 5");
    let completion = pos("# DELEGATION COMPLETED");

    assert!(original < f1, "original task first");
    assert!(f1 < f5, "follow-ups in order");
    assert!(
        f5 < completion,
        "completion must land AFTER all intervening messages — got positions f5={f5} completion={completion}"
    );

    // No `# DELEGATION IN PROGRESS` block survives — pending row is
    // dropped because the latest marker (Completed) supersedes it.
    let pending_count = user_contents
        .iter()
        .filter(|c| c.starts_with("# DELEGATION IN PROGRESS"))
        .count();
    assert_eq!(pending_count, 0, "pending marker must be filtered out");
}

#[tokio::test]
async fn nested_delegation_marker_renders_one_liner_not_full_transcript() {
    // A marker whose `parent_conversation_id` is NOT the current
    // conversation = nested deeper in the delegation tree. Avoid
    // exponential context bloat by rendering a one-liner instead.

    let store = open_store_with_conv();
    append_user(&store, CONVO_ID, Some(CONVO_ID), "user-pk", "task", 100);

    let nested = DelegationMarker {
        delegation_conversation_id: "grandchild-1".into(),
        recipient_pubkey: AGENT2.into(),
        parent_conversation_id: "grandparent-conv".into(), // not CONVO_ID
        initiated_at: Some(101),
        completed_at: Some(200),
        status: DelegationStatus::Completed,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONVO_ID, &nested, AGENT1, None)
        .unwrap();

    let resolver = StubNameResolver;
    let projection = project_with_options(
        &store, CONVO_ID, AGENT1, SYSTEM_PROMPT, &profile(),
        &[], None, Some(&resolver), opts(),
    )
    .await
    .unwrap();

    let one_liner = projection
        .messages
        .iter()
        .find_map(|m| match m {
            Message::User { content, .. } if content.starts_with("[Delegation to ") => Some(content.as_str()),
            _ => None,
        })
        .expect("nested marker should render one-liner");
    assert_eq!(
        one_liner,
        "[Delegation to @agent2 (conv: grandchild...) — completed]"
    );
}

#[tokio::test]
async fn system_anchor_breakpoint_still_emitted_for_cached_profiles() {
    let store = open_store_with_conv();
    append_user(&store, "event:t1", Some("t1"), "user-pk", "hi", 100);
    let profile = ModelProfile {
        prompt_cache: true,
        ..profile()
    };
    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT1,
        SYSTEM_PROMPT,
        &profile,
        &[],
        None,
        None,
        opts(),
    )
    .await
    .unwrap();
    let has_system_anchor = projection
        .cache_breakpoints
        .iter()
        .any(|b: &BreakpointHint| b.kind == BreakpointKind::SystemAnchor);
    assert!(has_system_anchor);
}

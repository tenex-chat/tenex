//! Integration tests for `tenex-context` against an in-memory
//! `tenex-conversations` store.

use serde_json::json;
use tenex_context::{
    project, record_turn, BreakpointKind, CacheObservation, Message, ModelProfile, ToolDef,
    TurnRecord,
};
use tenex_conversations::{ConversationStore, NewMessage, NewToolMessage};

const CONVO_ID: &str = "conv-test";
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

fn no_cache_profile() -> ModelProfile {
    ModelProfile {
        provider: "openrouter".into(),
        model_id: "some-model".into(),
        prompt_cache: false,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 200_000,
    }
}

fn append_user(store: &ConversationStore, record_id: &str, content: &str) {
    let msg = NewMessage {
        record_id: record_id.into(),
        nostr_event_id: None,
        author_pubkey: USER_PUBKEY.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "message".into(),
        role: Some("user".into()),
        content: content.into(),
        timestamp: None,
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

/// Append an assistant message owned by `AGENT_PUBKEY`. Tool messages
/// only project when paired with an assistant message in `messages` —
/// this helper is what tests use to anchor a turn.
fn append_assistant(store: &ConversationStore, record_id: &str, content: &str) {
    let msg = NewMessage {
        record_id: record_id.into(),
        nostr_event_id: None,
        author_pubkey: AGENT_PUBKEY.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "message".into(),
        role: Some("assistant".into()),
        content: content.into(),
        timestamp: None,
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

fn append_tool_result(store: &ConversationStore, call_id: &str, tool_name: &str, body: &str) {
    let tool = NewToolMessage {
        tool_call_id: call_id.into(),
        parent_message_id: None,
        agent_pubkey: AGENT_PUBKEY.into(),
        tool_name: tool_name.into(),
        call_input: json!({}),
        result_output: Some(json!(body)),
        is_error: false,
        timestamp: None,
    };
    store.record_tool_message(CONVO_ID, &tool).expect("tool");
}

#[test]
fn basic_projection_emits_system_prompt_and_anchor() {
    let store = open_store();
    let profile = cacheable_profile();

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "you are a helpful assistant",
        &profile,
        &[],
    )
    .expect("project");

    assert!(matches!(
        projection.messages.first(),
        Some(Message::System { content }) if content == "you are a helpful assistant"
    ));

    let has_system_anchor = projection
        .cache_breakpoints
        .iter()
        .any(|b| b.kind == BreakpointKind::SystemAnchor);
    assert!(has_system_anchor, "system anchor must be emitted");
}

#[test]
fn no_decay_tagging_preserves_load_skill_and_delegate_results() {
    let store = open_store();
    let profile = cacheable_profile();

    // Anchor the tool messages on an assistant turn — projection only
    // emits tool results that pair with an assistant in `messages`.
    append_assistant(&store, "asst-1", "I will gather context");

    // Build a fixture: 21 tool results — alternating load_skill, delegate,
    // and fs_read. fs_read is decay-eligible; load_skill and delegate are
    // preserved.
    let mut load_skill_calls = Vec::new();
    let mut delegate_calls = Vec::new();
    let mut fs_read_calls = Vec::new();
    for i in 0..7 {
        let ls_id = format!("ls-{i}");
        append_tool_result(&store, &ls_id, "load_skill", &format!("skill body {i}"));
        load_skill_calls.push(ls_id);

        let dl_id = format!("dl-{i}");
        append_tool_result(&store, &dl_id, "delegate", &format!("delegated work {i}"));
        delegate_calls.push(dl_id);

        let fr_id = format!("fr-{i}");
        append_tool_result(&store, &fr_id, "fs_read", &format!("file body {i}"));
        fs_read_calls.push(fr_id);
    }

    let tool_defs = vec![
        ToolDef {
            name: "load_skill".into(),
            preserve_results: true,
        },
        ToolDef {
            name: "delegate".into(),
            preserve_results: true,
        },
        ToolDef {
            name: "fs_read".into(),
            preserve_results: false,
        },
    ];

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &tool_defs,
    )
    .expect("project");

    // Every load_skill and delegate result must remain verbatim (not
    // replaced by a placeholder).
    for id in &load_skill_calls {
        let surviving = projection.messages.iter().any(|m| {
            matches!(m, Message::ToolResult { tool_call_id, content, .. }
                if tool_call_id == id && !content.starts_with("[tool result decayed"))
        });
        assert!(surviving, "load_skill result {id} must survive decay");
    }
    for id in &delegate_calls {
        let surviving = projection.messages.iter().any(|m| {
            matches!(m, Message::ToolResult { tool_call_id, content, .. }
                if tool_call_id == id && !content.starts_with("[tool result decayed"))
        });
        assert!(surviving, "delegate result {id} must survive decay");
    }

    // Most fs_read results should have been replaced with placeholders;
    // the strategy keeps a small trailing window of recent eligible
    // results.
    let fs_decayed = projection
        .messages
        .iter()
        .filter(|m| {
            matches!(m, Message::ToolResult { tool_name, content, .. }
                if tool_name == "fs_read" && content.starts_with("[tool result decayed"))
        })
        .count();
    assert!(
        fs_decayed >= 4,
        "expected at least 4 fs_read results to decay, got {fs_decayed}"
    );
}

#[test]
fn unknown_tool_results_are_decay_eligible() {
    let store = open_store();
    let profile = cacheable_profile();

    // Anchor on an assistant message so the tool results project.
    append_assistant(&store, "asst-1", "calling deactivated_tool");

    // 6 results from a tool not present in tool_defs at all.
    for i in 0..6 {
        append_tool_result(
            &store,
            &format!("unk-{i}"),
            "deactivated_tool",
            &format!("body {i}"),
        );
    }

    // Empty tool_defs: the tool is unknown.
    let projection = project(&store, CONVO_ID, AGENT_PUBKEY, "system", &profile, &[]).expect("p");

    let decayed = projection
        .messages
        .iter()
        .filter(|m| {
            matches!(m, Message::ToolResult { content, .. }
                if content.starts_with("[tool result decayed"))
        })
        .count();
    assert!(
        decayed > 0,
        "tool results from unknown tools must be decay-eligible"
    );
}

#[test]
fn record_turn_round_trip_writes_prompt_history() {
    let store = open_store();
    append_user(&store, "rec-1", "hello");

    let turn = TurnRecord {
        messages_visible: vec![
            Message::System {
                content: "system prompt".into(),
            },
            Message::User {
                content: "hello".into(),
            },
            Message::Assistant {
                content: "hi back".into(),
                tool_calls: Vec::new(),
            },
        ],
        reminders_applied: vec!["stay-on-task".into()],
        compaction_decisions: vec!["no-op".into()],
        cache_observed: CacheObservation {
            hit_tokens: 10,
            miss_tokens: 5,
            written_tokens: 5,
        },
        breakpoint_hints: Vec::new(),
    };

    record_turn(&store, CONVO_ID, AGENT_PUBKEY, turn).expect("record");

    let history = store
        .list_prompt_history(CONVO_ID, AGENT_PUBKEY)
        .expect("history");
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].role, "system");
    assert_eq!(history[1].role, "user");
    assert_eq!(history[2].role, "assistant");

    // The persisted content carries the role-tagged Message JSON we wrote.
    let user_content = &history[1].content;
    assert_eq!(user_content["role"], "user");
    assert_eq!(user_content["content"], "hello");

    // Context state was upserted with the bumped sequence and cache observation.
    let state = store
        .get_agent_context_state(CONVO_ID, AGENT_PUBKEY)
        .expect("state")
        .expect("state row exists");
    assert_eq!(state.next_prompt_sequence, 3);
    assert!(
        state.cache_anchored,
        "cache_anchored set when hit_tokens > 0"
    );
    let compaction = state.compaction_state.expect("compaction state set");
    assert_eq!(compaction["cache_observed"]["hit_tokens"], 10);
}

#[test]
fn no_prompt_cache_emits_no_message_stream_breakpoint() {
    let store = open_store();
    // Add some real message stream content so the test isn't trivial.
    append_user(&store, "rec-1", "first");
    append_user(&store, "rec-2", "second");
    append_user(&store, "rec-3", "third");

    let profile = no_cache_profile();
    let projection =
        project(&store, CONVO_ID, AGENT_PUBKEY, "system", &profile, &[]).expect("project");

    assert!(projection.messages.len() > 1, "stream is non-trivial");
    let stream_anchors = projection
        .cache_breakpoints
        .iter()
        .filter(|b| b.kind == BreakpointKind::MessageStream)
        .count();
    assert_eq!(
        stream_anchors, 0,
        "no MessageStream breakpoints when prompt_cache is disabled"
    );
    let has_system_anchor = projection
        .cache_breakpoints
        .iter()
        .any(|b| b.kind == BreakpointKind::SystemAnchor);
    assert!(has_system_anchor, "SystemAnchor still emitted");
}

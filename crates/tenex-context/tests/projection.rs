//! Integration tests for `tenex-context` against an in-memory
//! `tenex-conversations` store.

use serde_json::json;
use tenex_context::{
    BreakpointKind, CacheObservation, DisplayNameResolver, Message, ModelProfile,
    ProjectionOptions, ToolCall, ToolDef, TurnRecord, project, project_with_options, record_turn,
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

fn tiny_profile() -> ModelProfile {
    ModelProfile {
        provider: "anthropic".into(),
        model_id: "claude-test".into(),
        prompt_cache: true,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 40,
    }
}

fn append_user(store: &ConversationStore, record_id: &str, content: &str) {
    append_user_with_event(store, record_id, None, content);
}

fn append_user_with_event(
    store: &ConversationStore,
    record_id: &str,
    nostr_event_id: Option<&str>,
    content: &str,
) {
    let msg = NewMessage {
        record_id: record_id.into(),
        nostr_event_id: nostr_event_id.map(str::to_string),
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

/// Append an assistant message owned by `AGENT_PUBKEY` and return the
/// new row's `messages.id`. Tool messages need this id as their
/// `parent_message_id` so projection can pair them with the assistant
/// turn that emitted them.
fn append_assistant(store: &ConversationStore, record_id: &str, content: &str) -> i64 {
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
    store.append_message(CONVO_ID, &msg).expect("append")
}

fn append_tool_result(
    store: &ConversationStore,
    parent_message_id: i64,
    call_id: &str,
    tool_name: &str,
    body: &str,
) {
    let tool = NewToolMessage {
        tool_call_id: call_id.into(),
        parent_message_id: Some(parent_message_id),
        agent_pubkey: AGENT_PUBKEY.into(),
        tool_name: tool_name.into(),
        call_input: json!({}),
        result_output: Some(json!(body)),
        is_error: false,
        timestamp: None,
    };
    store.record_tool_message(CONVO_ID, &tool).expect("tool");
}

#[tokio::test]
async fn basic_projection_emits_system_prompt_and_anchor() {
    let store = open_store();
    let profile = cacheable_profile();

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "you are a helpful assistant",
        &profile,
        &[],
        None,
        None,
    )
    .await
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

#[tokio::test]
async fn in_turn_tail_is_ignored_after_splice_removal() {
    // Under the single-source-of-truth architecture, `in_turn_tail` is
    // retained on `ProjectionOptions` only for serialization stability
    // — projection itself ignores it. The conversation store is the
    // sole source of truth; callers that want messages to appear in
    // projection must persist rows.
    let store = open_store();
    append_user(&store, "stored-user", "stored user");

    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        None,
        ProjectionOptions {
            excluded_event_id: None,
            in_turn_tail: vec![Message::User {
                content: "this MUST NOT appear in projection".into(),
                attachments: Vec::new(),
            }],
            compaction_override: None,
            proactive_context: None,
        },
    )
    .await
    .expect("project");

    let user_messages: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_messages,
        vec!["stored user"],
        "in_turn_tail must be silently dropped — only stored rows project"
    );
}

#[tokio::test]
async fn no_decay_tagging_preserves_load_skill_and_delegate_results() {
    let store = open_store();
    let profile = cacheable_profile();

    // Anchor the tool messages on an assistant turn — projection only
    // emits tool results that pair with an assistant in `messages`.
    let asst_id = append_assistant(&store, "asst-1", "I will gather context");

    // Build a fixture: 21 tool results — alternating load_skill, delegate,
    // and fs_read. fs_read is decay-eligible; load_skill and delegate are
    // preserved.
    let mut load_skill_calls = Vec::new();
    let mut delegate_calls = Vec::new();
    let mut fs_read_calls = Vec::new();
    for i in 0..7 {
        let ls_id = format!("ls-{i}");
        append_tool_result(&store, asst_id, &ls_id, "load_skill", &format!("skill body {i}"));
        load_skill_calls.push(ls_id);

        let dl_id = format!("dl-{i}");
        append_tool_result(&store, asst_id, &dl_id, "delegate", &format!("delegated work {i}"));
        delegate_calls.push(dl_id);

        let fr_id = format!("fr-{i}");
        append_tool_result(&store, asst_id, &fr_id, "fs_read", &format!("file body {i}"));
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
        None,
        None,
    )
    .await
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

#[tokio::test]
async fn unknown_tool_results_are_decay_eligible() {
    let store = open_store();
    let profile = cacheable_profile();

    // Anchor on an assistant message so the tool results project.
    let asst_id = append_assistant(&store, "asst-1", "calling deactivated_tool");

    // 6 results from a tool not present in tool_defs at all.
    for i in 0..6 {
        append_tool_result(
            &store,
            asst_id,
            &format!("unk-{i}"),
            "deactivated_tool",
            &format!("body {i}"),
        );
    }

    // Empty tool_defs: the tool is unknown.
    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
    )
    .await
    .expect("p");

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

#[tokio::test]
async fn compaction_keeps_tool_call_pairs_atomic() {
    let store = open_store();

    append_user(&store, "old-1", &"older user context ".repeat(20));
    append_user(&store, "old-2", &"more old context ".repeat(20));
    let asst_tools_id = append_assistant(&store, "asst-tools", "I will inspect files");
    append_tool_result(&store, asst_tools_id, "call-a", "shell", "first result");
    append_tool_result(&store, asst_tools_id, "call-b", "shell", "second result");
    append_user(&store, "tail-1", "recent user 1");
    append_assistant(&store, "tail-2", "recent assistant 2");
    append_user(&store, "tail-3", "recent user 3");
    append_assistant(&store, "tail-4", "recent assistant 4");
    append_user(&store, "tail-5", "recent user 5");

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &tiny_profile(),
        &[],
        None,
        None,
    )
    .await
    .expect("project");

    assert!(
        projection.telemetry.compacted_count > 0,
        "fixture should trigger compaction"
    );

    let mut visible_tool_calls = std::collections::HashSet::new();
    for msg in &projection.messages {
        match msg {
            Message::Assistant { tool_calls, .. } => {
                for tool_call in tool_calls {
                    visible_tool_calls.insert(tool_call.id.as_str());
                }
            }
            Message::ToolResult { tool_call_id, .. } => assert!(
                visible_tool_calls.contains(tool_call_id.as_str()),
                "tool result {tool_call_id} must not survive without its assistant tool call"
            ),
            _ => {}
        }
    }
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
                content: "hello".into(), attachments: Vec::new(),
            },
            Message::Assistant {
                content: "hi back".into(),
                reasoning: Vec::new(),
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

#[tokio::test]
async fn no_prompt_cache_emits_no_message_stream_breakpoint() {
    let store = open_store();
    // Add some real message stream content so the test isn't trivial.
    append_user(&store, "rec-1", "first");
    append_user(&store, "rec-2", "second");
    append_user(&store, "rec-3", "third");

    let profile = no_cache_profile();
    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
    )
    .await
    .expect("project");

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

#[tokio::test]
async fn excluded_event_id_is_ignored_storage_is_truth() {
    // Under the single-source-of-truth architecture, the trigger event row
    // is just another row in storage — there is no in-memory replay path
    // that would duplicate it. `excluded_event_id` is retained on the
    // options struct for serialization stability but no longer filters.
    let store = open_store();
    append_user_with_event(
        &store,
        "event:old-event",
        Some("old-event"),
        "prior user message",
    );
    append_user_with_event(
        &store,
        "event:current-event",
        Some("current-event"),
        "current user message",
    );

    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        None,
        ProjectionOptions {
            excluded_event_id: Some("current-event".into()),
            in_turn_tail: Vec::new(),
            proactive_context: None,
            compaction_override: None,
        },
    )
    .await
    .expect("project");

    let user_msgs: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_msgs,
        vec!["prior user message", "current user message"],
        "trigger row stays in projection — single source of truth"
    );
}

// ── Author attribution ────────────────────────────────────────────────────────

struct TestNameResolver(std::collections::HashMap<String, String>);

impl DisplayNameResolver for TestNameResolver {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        self.0.get(pubkey).cloned()
    }
}

fn append_user_from(store: &ConversationStore, record_id: &str, author: &str, content: &str) {
    let msg = NewMessage {
        record_id: record_id.into(),
        nostr_event_id: None,
        author_pubkey: author.into(),
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

#[tokio::test]
async fn single_author_user_messages_are_not_prefixed() {
    let store = open_store();
    append_user(&store, "rec-1", "first");
    append_user(&store, "rec-2", "second");

    let resolver = TestNameResolver(
        [(USER_PUBKEY.to_string(), "alice".to_string())]
            .into_iter()
            .collect(),
    );

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        Some(&resolver),
    )
    .await
    .expect("project");

    let users: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(users, vec!["first", "second"]);
}

#[tokio::test]
async fn multi_author_user_messages_get_name_prefix() {
    let store = open_store();
    let alice = "alice-pubkey-aaaaaa";
    let bob = "bob-pubkey-bbbbbb";
    append_user_from(&store, "rec-1", alice, "hi from alice");
    append_user_from(&store, "rec-2", bob, "and from bob");

    let resolver = TestNameResolver(
        [
            (alice.to_string(), "alice".to_string()),
            (bob.to_string(), "bob".to_string()),
        ]
        .into_iter()
        .collect(),
    );

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        Some(&resolver),
    )
    .await
    .expect("project");

    let users: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(users, vec!["[alice] hi from alice", "[bob] and from bob"]);
}

#[tokio::test]
async fn multi_author_falls_back_to_short_pubkey_when_resolver_misses() {
    let store = open_store();
    let alice = "alice-pubkey-aaaaaa";
    let unknown = "unknown-pubkey-cccccc";
    append_user_from(&store, "rec-1", alice, "known");
    append_user_from(&store, "rec-2", unknown, "unknown");

    let resolver = TestNameResolver(
        [(alice.to_string(), "alice".to_string())]
            .into_iter()
            .collect(),
    );

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &cacheable_profile(),
        &[],
        None,
        Some(&resolver),
    )
    .await
    .expect("project");

    let users: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();

    // First 8 chars of the unknown pubkey form the fallback.
    assert_eq!(users, vec!["[alice] known", "[unknown-] unknown"]);
}

#[tokio::test]
async fn multi_author_without_resolver_does_not_prefix() {
    let store = open_store();
    append_user_from(&store, "rec-1", "alice-pubkey", "one");
    append_user_from(&store, "rec-2", "bob-pubkey", "two");

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

    let users: Vec<&str> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(users, vec!["one", "two"]);
}

/// Reproduces production trace `1bbd7e35a80d91c739195701f04e3fbe`
/// (human-replica agent on kimi-k2.6:cloud via ollama). After the fix,
/// step.rs no longer accumulates step state in `in_turn_tail` when a
/// store is present — `in_turn_tail` only carries the live user prompt
/// and the supervisor `prefix_tail`, and the store is the sole source
/// for prior steps' assistant + tool messages.
///
/// This test exercises step 2's projection call directly: store has the
/// user prompt plus step 1's assistant row (with role=assistant) and
/// step 1's tool message (parent_message_id set to the assistant row).
/// The provided `in_turn_tail` mirrors the post-fix shape — `[User]`
/// only. Projection must emit each tool_call_id exactly once, with the
/// tool result anchored to its parent assistant via parent_message_id.
///
/// Uses the real production shape: trigger has a nostr_event_id and is
/// excluded via `excluded_event_id` (the trigger is provided live as the
/// turn prompt, not duplicated from history).
#[tokio::test]
async fn step_loop_in_turn_tail_does_not_duplicate_persisted_messages() {
    let store = open_store();
    let profile = no_cache_profile();

    let user_text =
        "Ensure Claude and developer and developer macOS are all in the same commit/branch";
    // Real production shape: trigger has a nostr_event_id; excluded so it
    // isn't duplicated alongside the live in_turn_tail copy.
    append_user_with_event(&store, "event:trigger-rec", Some("trigger-rec"), user_text);

    // Step 1 has just finished. `record_step_assistant` wrote an
    // assistant row (returning its id), and `record_step_tool_messages`
    // wrote a tool row linked to that id via `parent_message_id`.
    let asst_id = append_assistant(&store, "step:abc:1234:0", "");
    let call_id = "8xxbfD_wUDVJk9SGkRbSD"; // verbatim from the trace
    append_tool_result(&store, asst_id, call_id, "todo_write", "Todo list updated (4 items)");

    // Step 2 is about to call the provider. With a store present,
    // `in_turn_tail` carries only the live user prompt — no step
    // accumulation.
    let in_turn_tail = vec![Message::User {
        content: user_text.to_string(), attachments: Vec::new(),
            }];

    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
        ProjectionOptions {
            excluded_event_id: Some("trigger-rec".into()),
            in_turn_tail,
            proactive_context: None,
            compaction_override: None,
        },
    )
    .await
    .expect("project");

    // User trigger must appear before the step rows.
    assert!(
        matches!(&projection.messages[1], Message::User { content, .. } if content == user_text),
        "messages[1] must be the user trigger; got {:?}",
        &projection.messages[1]
    );

    let assistants_referencing_call = projection
        .messages
        .iter()
        .filter(|m| {
            matches!(m, Message::Assistant { tool_calls, .. }
                if tool_calls.iter().any(|tc| tc.id == call_id))
        })
        .count();

    let tool_results_for_call = projection
        .messages
        .iter()
        .filter(|m| {
            matches!(m, Message::ToolResult { tool_call_id, .. } if tool_call_id == call_id)
        })
        .count();

    assert_eq!(
        assistants_referencing_call, 1,
        "tool_call_id must appear in exactly one assistant tool_calls list, \
         found {assistants_referencing_call}"
    );
    assert_eq!(
        tool_results_for_call, 1,
        "tool_call_id must produce exactly one tool_result, found {tool_results_for_call}"
    );
}

/// Regression: before the fix, `project_with_options` appended `in_turn_tail`
/// at the very end — AFTER all step rows already persisted for this turn.
/// At step 2+ the user trigger therefore appeared after the LLM's own prior
/// step messages, which is nonsensical (user can't respond to something the
/// LLM said before the user spoke).
///
/// After the fix the user trigger from `in_turn_tail` is spliced BEFORE the
/// first in-turn step row so the final messages[] order is:
///   [system, …prior history…, user trigger, step1 assistant+tools, …]
#[tokio::test]
async fn step2_user_trigger_appears_before_step_messages() {
    let store = open_store();
    let profile = no_cache_profile();

    // Real production shape: trigger has a nostr_event_id; excluded so the
    // live in_turn_tail copy is the only instance in messages[].
    append_user_with_event(&store, "event:trigger-abc", Some("trigger-abc"), "do something");

    // Step 1 finished: record_step_assistant wrote this row (record_id
    // starts with "step:"), record_step_tool_messages wrote the linked tool.
    let step1_id = append_assistant(&store, "step:agent:1000:0", "");
    append_tool_result(&store, step1_id, "call-1", "shell", "shell result");

    // Step 2 projection: in_turn_tail carries only the live user prompt.
    let in_turn_tail = vec![Message::User {
        content: "do something".into(), attachments: Vec::new(),
            }];

    let projection = project_with_options(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
        ProjectionOptions {
            excluded_event_id: Some("trigger-abc".into()),
            in_turn_tail,
            proactive_context: None,
            compaction_override: None,
        },
    )
    .await
    .expect("project");

    // Expected order: [system, user trigger, step1 assistant, tool result]
    assert_eq!(
        projection.messages.len(),
        4,
        "expected exactly 4 messages; got {:?}",
        projection.messages
    );
    assert!(
        matches!(&projection.messages[0], Message::System { .. }),
        "messages[0] must be system; got {:?}",
        &projection.messages[0]
    );
    assert!(
        matches!(&projection.messages[1], Message::User { content, .. } if content == "do something"),
        "messages[1] must be the user trigger (not a step row); got {:?}",
        &projection.messages[1]
    );
    assert!(
        matches!(&projection.messages[2], Message::Assistant { tool_calls, .. } if !tool_calls.is_empty()),
        "messages[2] must be step 1 assistant with tool calls; got {:?}",
        &projection.messages[2]
    );
    assert!(
        matches!(&projection.messages[3], Message::ToolResult { .. }),
        "messages[3] must be the tool result; got {:?}",
        &projection.messages[3]
    );
}

/// Direct unit-style test of the new pairing contract: when two
/// consecutive assistant steps each emit their own tool calls within
/// one turn (no user message between them), each step's tool messages
/// pair with their own assistant via `parent_message_id`. The
/// previous timestamp-window bundling collapsed both steps' tool calls
/// onto the FIRST assistant; that behavior is gone.
#[tokio::test]
async fn projection_pairs_each_step_assistant_with_its_own_tool_calls() {
    let store = open_store();
    let profile = no_cache_profile();

    append_user(&store, "user-1", "do two things");

    let step1_id = append_assistant(&store, "step:agent:1000:0", "");
    append_tool_result(&store, step1_id, "call-1", "shell", "first result");

    let step2_id = append_assistant(&store, "step:agent:1001:1", "");
    append_tool_result(&store, step2_id, "call-2", "shell", "second result");

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
    )
    .await
    .expect("project");

    let assistants: Vec<&Vec<ToolCall>> = projection
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::Assistant { tool_calls, .. } => Some(tool_calls),
            _ => None,
        })
        .collect();
    assert_eq!(
        assistants.len(),
        2,
        "two assistant rows should produce two assistant messages, found {}",
        assistants.len()
    );
    assert_eq!(assistants[0].len(), 1, "step 1 carries its own tool call");
    assert_eq!(assistants[0][0].id, "call-1");
    assert_eq!(assistants[1].len(), 1, "step 2 carries its own tool call");
    assert_eq!(assistants[1][0].id, "call-2");
}

/// Tool messages without `parent_message_id` set are dropped: projection
/// has no anchor for them and emitting an orphan `tool_result` is a 400
/// from any provider. Legacy/migration rows fall into this bucket; we
/// chose to break them rather than keep timestamp-window fallback alive.
#[tokio::test]
async fn projection_drops_orphan_tool_messages_lacking_parent() {
    let store = open_store();
    let profile = no_cache_profile();

    append_user(&store, "user-1", "hello");
    append_assistant(&store, "asst-1", "I'll think about it");

    let orphan = NewToolMessage {
        tool_call_id: "orphan-call".into(),
        parent_message_id: None,
        agent_pubkey: AGENT_PUBKEY.into(),
        tool_name: "shell".into(),
        call_input: json!({}),
        result_output: Some(json!("orphan body")),
        is_error: false,
        timestamp: None,
    };
    store.record_tool_message(CONVO_ID, &orphan).expect("tool");

    let projection = project(
        &store,
        CONVO_ID,
        AGENT_PUBKEY,
        "system",
        &profile,
        &[],
        None,
        None,
    )
    .await
    .expect("project");

    let has_orphan = projection.messages.iter().any(|m| {
        matches!(m, Message::ToolResult { tool_call_id, .. } if tool_call_id == "orphan-call")
    });
    assert!(
        !has_orphan,
        "tool messages without parent_message_id must not appear in projection"
    );
    let assistant_with_orphan = projection.messages.iter().any(|m| {
        matches!(m, Message::Assistant { tool_calls, .. }
            if tool_calls.iter().any(|tc| tc.id == "orphan-call"))
    });
    assert!(
        !assistant_with_orphan,
        "orphan tool call must not be attached to any assistant"
    );
}

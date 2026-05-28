//! Side-effecting persistence helpers used by [`super::run_turn_loop`].
//!
//! These helpers are the only writers of the per-turn `messages` and
//! `tool_messages` rows the next step's projection reads. They return
//! `Result`; the step loop aborts on persistence failure rather than
//! continuing with state the next provider step cannot see.

use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use tenex_accounting::{LlmUsage, RecordLlmCall, RootKind, record_llm_call};
use tenex_context::{
    BreakpointHint, BreakpointKind, CacheObservation, Message as CtxMessage, TurnRecord,
};
use tenex_conversations::{ConversationStore, NewMessage, NewToolMessage};

use crate::agent_bootstrap::AgentBootstrap;
use crate::tools::recording::ToolCallRecord;

pub(super) use crate::tools::agent_context_state::save_context_state;

/// Monotonic counter used to disambiguate `record_id`s for step assistant
/// rows persisted within the same wall-clock millisecond (e.g., back-to-back
/// streamed steps). The `record_id` only needs uniqueness within a
/// conversation; pairing `(agent_pubkey, now_ms, counter)` is sufficient.
///
/// The counter is process-global. Two separate processes running the same
/// agent pubkey in the same conversation could theoretically generate the
/// same `(now_ms, counter)` pair if both start from zero in the same
/// millisecond — vanishingly unlikely in practice. `append_message` is
/// idempotent on `(conversation_id, record_id)`, so a collision would cause
/// the second writer's tool calls to attach to the first writer's
/// assistant row rather than corrupt data.
static STEP_RECORD_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Persist a supervision nudge ("Your original task was: …, you have
/// unfinished todos …") as a `role=user` row so the next iteration's
/// projection picks it up the same way it would pick up a real user
/// message. The agent loop only acts on user-role messages, so this is
/// the only role that produces a response.
///
/// `message_type = "supervision"` triggers the header guard in
/// `apply_message_to_header_tx` so `conversations.last_user_message`
/// is not corrupted by internal loop mechanics. The row is not
/// published to Nostr (`nostr_event_id = None`).
///
/// `nudge_seq` is a per-invocation monotonic counter. Together with
/// `execution_id` it produces a deterministic record id that cannot
/// collide across re-invocations (different execution_id) nor within
/// a single invocation (different seq). The `"supervision:"` prefix
/// keeps it cleanly distinct from `"event:<hex>"` and
/// `"step:..."` record_id namespaces.
pub(super) fn record_supervision_nudge(
    boot: &AgentBootstrap,
    store: &ConversationStore,
    nudge_seq: u64,
    content: &str,
) -> Result<i64> {
    write_supervision_nudge(
        store,
        &boot.conversation_id,
        &boot.pubkey_hex,
        &boot.execution_id,
        nudge_seq,
        content,
    )
}

/// Inner form of [`record_supervision_nudge`] that takes the identity
/// fields directly rather than reaching into [`AgentBootstrap`]. Public
/// to the agent crate so unit tests can drive the persistence layer
/// end-to-end without building a full bootstrap.
pub(crate) fn write_supervision_nudge(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    execution_id: &str,
    nudge_seq: u64,
    content: &str,
) -> Result<i64> {
    let record_id = format!("supervision:{execution_id}:{nudge_seq}");
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let new_msg = NewMessage {
        record_id,
        nostr_event_id: None,
        author_pubkey: agent_pubkey.to_string(),
        sender_pubkey: None,
        ral: None,
        message_type: "supervision".to_string(),
        role: Some("user".to_string()),
        content: content.to_string(),
        timestamp: Some(now_ms / 1000),
        targeted_pubkeys: None,
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    store
        .append_message(conversation_id, &new_msg)
        .context("write_supervision_nudge: messages row write failed")
}

/// Persist the tool calls captured during one provider step into
/// `tool_messages`, each linked to the assistant `messages` row that emitted
/// them via `parent_message_id`. Projection uses that link to pair tool
/// results with their originating assistant, so this is the only writer
/// that establishes the assistant↔tool-result relationship.
pub(super) fn record_step_tool_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    parent_message_id: i64,
    recorded_calls: &[ToolCallRecord],
) -> Result<()> {
    for rec in recorded_calls {
        if let Some(provider_call_id) = rec.provider_call_id.as_deref() {
            tracing::debug!(
                tool_call_id = %rec.call_id,
                provider_call_id,
                tool_name = %rec.tool_name,
                parent_message_id,
                "persisting tool message with provider call id"
            );
        }
        let new_tool = NewToolMessage {
            tool_call_id: rec.call_id.clone(),
            parent_message_id: Some(parent_message_id),
            agent_pubkey: agent_pubkey.to_string(),
            tool_name: rec.tool_name.clone(),
            call_input: rec.args.clone(),
            result_output: Some(rec.result.clone()),
            is_error: rec.is_error,
            timestamp: Some(rec.timestamp_ms),
        };
        store
            .record_tool_message(conversation_id, &new_tool)
            .with_context(|| {
                format!(
                    "record_step_tool_messages: failed to persist tool {} (call {})",
                    rec.tool_name, rec.call_id
                )
            })?;
    }
    Ok(())
}

/// Persist the assistant message emitted by one provider step. Writes both
/// the per-agent `agent_prompt_history` row (for telemetry/replay) and a
/// `messages` row that the next step's projection (and re-engagement
/// iterations) read back as a regular assistant turn. Returns the
/// inserted `messages.id` so the caller can use it as
/// `parent_message_id` for the step's tool messages and (for terminal
/// steps) stamp the `nostr_event_id` once the outbound publish succeeds.
///
/// Terminal steps are persisted just like tool-emitting steps. The row's
/// `nostr_event_id` starts as `None`; the caller is expected to call
/// [`stamp_step_assistant_event_id`] after the outbound channel returns
/// the published event id, so that the runtime's own writeback (which
/// reads the agent's stdout and inserts with `nostr_event_id`) finds
/// this row via the `nostr_event_id` partial unique index and is a
/// no-op rather than a second writer.
pub(super) fn record_step_assistant(
    boot: &AgentBootstrap,
    store: &ConversationStore,
    assistant_message: &CtxMessage,
    stream_usage: &rig_core::completion::Usage,
) -> Result<i64> {
    write_step_assistant(
        store,
        &boot.conversation_id,
        &boot.pubkey_hex,
        &boot.execution_id,
        assistant_message,
        stream_usage,
    )
}

/// Inner form of [`record_step_assistant`] usable without an
/// [`AgentBootstrap`]. Used by the persistence-layer unit tests below
/// to drive realistic multi-step / delegation-callback flows end-to-end.
pub(crate) fn write_step_assistant(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    execution_id: &str,
    assistant_message: &CtxMessage,
    stream_usage: &rig_core::completion::Usage,
) -> Result<i64> {
    let hit_tokens = stream_usage.cached_input_tokens;
    let breakpoint_hints = if hit_tokens > 0 {
        vec![BreakpointHint {
            position: 0,
            kind: BreakpointKind::MessageStream,
        }]
    } else {
        Vec::new()
    };
    let turn = TurnRecord {
        messages_visible: vec![assistant_message.clone()],
        reminders_applied: Vec::new(),
        compaction_decisions: Vec::new(),
        cache_observed: CacheObservation {
            hit_tokens,
            miss_tokens: 0,
            written_tokens: stream_usage.cache_creation_input_tokens,
        },
        breakpoint_hints,
    };
    tenex_context::record_turn(store, conversation_id, agent_pubkey, turn)
        .context("write_step_assistant: prompt_history write failed")?;

    let CtxMessage::Assistant { content, .. } = assistant_message else {
        anyhow::bail!("write_step_assistant called with non-assistant message");
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let counter = STEP_RECORD_COUNTER.fetch_add(1, Ordering::Relaxed);
    let record_id = format!("step:{execution_id}:{agent_pubkey}:{now_ms}:{counter}");
    let now_secs = now_ms / 1000;

    let new_msg = NewMessage {
        record_id,
        nostr_event_id: None,
        author_pubkey: agent_pubkey.to_string(),
        sender_pubkey: None,
        ral: None,
        message_type: "text".to_string(),
        role: Some("assistant".to_string()),
        content: content.clone(),
        timestamp: Some(now_secs),
        targeted_pubkeys: None,
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    let row_id = store
        .append_message(conversation_id, &new_msg)
        .context("write_step_assistant: messages row write failed")?;
    Ok(row_id)
}

/// Reconcile a locally-persisted terminal-step assistant row with the
/// Nostr event id assigned at publish time. Idempotent and race-safe.
///
/// Three cases, all handled inside a single `BEGIN IMMEDIATE`:
/// - Our row already has this `nostr_event_id` (idempotent retry).
/// - No row has the event id yet → stamp ours.
/// - The runtime already wrote a canonical `event:<hex>` row (the
///   runtime materializes the agent's stdout faster than this stamp
///   ran). Drop our synthetic `step:...` row; the canonical row is
///   the survivor. Terminal-step rows have no `tool_messages`
///   children so the deletion is safe.
///
/// Returns the row id of whichever row ended up representing this
/// assistant content in storage (may differ from the input `row_id`
/// when the runtime won the race).
pub(super) fn reconcile_step_assistant_event_id(
    store: &ConversationStore,
    row_id: i64,
    event_id_hex: &str,
) -> Result<i64> {
    store
        .reconcile_assistant_event_id(row_id, event_id_hex)
        .context("reconcile_step_assistant_event_id: store reconcile failed")
}

/// Record this turn's accounting row after the step loop has completed.
#[cfg(test)]
mod tests {
    //! End-to-end persistence + projection tests for the turn loop.
    //!
    //! These tests drive the *actual* persistence helpers
    //! (`write_step_assistant`, `record_step_tool_messages`,
    //! `write_supervision_nudge`, `reconcile_assistant_event_id`) and
    //! then project via `tenex_context::project_with_options`, so they
    //! prove the contract the agent runner depends on: when these
    //! helpers run with realistic inputs, the next projection produces
    //! the expected `messages[]` shape. This is the gap the
    //! projection-only integration tests in
    //! `crates/tenex-context/tests/projection_single_source.rs` could
    //! not close.
    use rig_core::completion::Usage;
    use serde_json::json;
    use tenex_context::{
        project_with_options, DisplayNameResolver, Message as CtxMessage, ModelProfile,
        ProjectionOptions, ToolCall as CtxToolCall,
    };
    use tenex_conversations::{ConversationStore, NewMessage};

    use super::*;

    /// Stub resolver that returns a fixed display name per pubkey. Mirrors
    /// what the production `IdentityServiceResolver` does — without it, the
    /// projection's multi-author `[name]` attribution is skipped (see
    /// `crates/tenex-context/src/projection.rs:66`).
    struct StubResolver(std::collections::HashMap<&'static str, &'static str>);
    impl DisplayNameResolver for StubResolver {
        fn display_name(&self, pubkey: &str) -> Option<String> {
            self.0.get(pubkey).map(|s| s.to_string())
        }
    }
    fn stub_resolver() -> StubResolver {
        StubResolver(
            [
                ("user-pk", "human"),
                (AGENT1, "agent1"),
                (AGENT2, "agent2"),
            ]
            .into_iter()
            .collect(),
        )
    }

    // The conversation_id IS the root event's hex id in production (see
    // agent_bootstrap/mod.rs:122). Tests use the same convention so the
    // `store.get_message_by_event(&conversation_id)` lookup that resolves
    // `original_task` actually succeeds and exercises Bug B's fix path.
    const CONV_ID: &str = "rootevent";
    const AGENT1: &str = "agent1-pk";
    const AGENT2: &str = "agent2-pk";
    const EXEC_INV1: &str = "exec-inv1";
    const EXEC_INV2: &str = "exec-inv2";
    const SYSTEM: &str = "SYS";

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

    fn opts() -> ProjectionOptions {
        ProjectionOptions::default()
    }

    fn open() -> ConversationStore {
        let s = ConversationStore::open_in_memory().unwrap();
        s.ensure_conversation(CONV_ID).unwrap();
        s
    }

    /// Simulate what the runtime does at `dispatch_pipeline.rs:626` when
    /// it materializes an inbound Nostr user event into the store.
    fn runtime_persist_user_event(
        store: &ConversationStore,
        event_id_hex: &str,
        author: &str,
        content: &str,
        ts_secs: i64,
    ) -> i64 {
        store
            .append_message(
                CONV_ID,
                &NewMessage {
                    record_id: format!("event:{event_id_hex}"),
                    nostr_event_id: Some(event_id_hex.to_string()),
                    author_pubkey: author.into(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".into(),
                    role: Some("user".into()),
                    content: content.into(),
                    timestamp: Some(ts_secs),
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

    async fn project_for(store: &ConversationStore, agent: &str) -> Vec<CtxMessage> {
        project_for_with_resolver(store, agent, None).await
    }

    async fn project_for_with_resolver(
        store: &ConversationStore,
        agent: &str,
        resolver: Option<&dyn DisplayNameResolver>,
    ) -> Vec<CtxMessage> {
        project_with_options(
            store,
            CONV_ID,
            agent,
            SYSTEM,
            &profile(),
            &[],
            None,
            resolver,
            opts(),
        )
        .await
        .unwrap()
        .messages
    }

    fn user_msg(content: &str) -> CtxMessage {
        CtxMessage::User {
            content: content.into(),
            attachments: Vec::new(),
        }
    }

    fn assistant_terminal(content: &str) -> CtxMessage {
        CtxMessage::Assistant {
            content: content.into(),
            reasoning: Vec::new(),
            tool_calls: Vec::new(),
        }
    }

    fn assistant_with_delegate(args: serde_json::Value, call_id: &str) -> CtxMessage {
        CtxMessage::Assistant {
            content: String::new(),
            reasoning: Vec::new(),
            tool_calls: vec![CtxToolCall {
                id: call_id.into(),
                provider_call_id: None,
                name: "delegate".into(),
                arguments: args,
            }],
        }
    }

    /// E2E: single-agent two-turn flow. Drives `write_step_assistant` for
    /// the terminal step and then asserts the next projection sees it.
    #[tokio::test]
    async fn e2e_single_agent_terminal_assistant_appears_in_next_projection() {
        let store = open();
        runtime_persist_user_event(&store, CONV_ID, "user-pk", "What's 2+2?", 100);

        write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_terminal("4"),
            &Usage::new(),
        )
        .unwrap();

        // Next projection (next iteration / next invocation) must see the
        // persisted terminal assistant — no in_turn_tail required.
        let projected = project_for(&store, AGENT1).await;
        assert_eq!(
            projected,
            vec![
                CtxMessage::System { content: SYSTEM.into() },
                user_msg("What's 2+2?"),
                assistant_terminal("4"),
            ]
        );

        // A second human turn lands.
        runtime_persist_user_event(&store, "next", "user-pk", "And 3*3?", 200);
        let projected2 = project_for(&store, AGENT1).await;
        assert_eq!(projected2.len(), 4);
        assert_eq!(projected2[3], user_msg("And 3*3?"));
    }

    /// E2E: the Bug A delegation-callback flow, end-to-end through the
    /// agent persistence helpers. Verifies that after `write_step_assistant`
    /// + `record_step_tool_messages` write the delegate row, agent2's
    /// reply (persisted by the runtime) lands AFTER those rows in
    /// projection — the seam where the splice used to mis-order.
    #[tokio::test]
    async fn e2e_delegation_callback_persists_and_projects_in_order() {
        let store = open();
        // 1. Human asks agent1.
        runtime_persist_user_event(
            &store,
            CONV_ID,
            "user-pk",
            "delegate to agent2, ask for a colour",
            100,
        );

        // 2. Agent1 invocation 1: writes step assistant + tool message.
        let agent1_step_row = write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_with_delegate(
                json!({"recipient": "agent2", "prompt": "pick a colour"}),
                "call-1",
            ),
            &Usage::new(),
        )
        .unwrap();
        record_step_tool_messages(
            &store,
            CONV_ID,
            AGENT1,
            agent1_step_row,
            &[crate::tools::recording::ToolCallRecord {
                call_id: "call-1".into(),
                provider_call_id: None,
                tool_name: "delegate".into(),
                args: json!({"recipient": "agent2", "prompt": "pick a colour"}),
                result: json!("Black — RGB(0,0,0)"),
                is_error: false,
                timestamp_ms: 101_000,
            }],
        )
        .unwrap();

        // 3. Agent2 publishes its reply; runtime materializes it into
        //    agent1's conversation as a new user-role row (the delegation
        //    callback trigger).
        runtime_persist_user_event(
            &store,
            "agent2-reply",
            AGENT2,
            "Black — RGB(0,0,0)",
            200,
        );

        // Bug B regression check: at this exact point, agent1's
        // delegation-callback subprocess would re-bootstrap. Bug B was
        // that bootstrap used `envelope.content` (= the delegatee reply,
        // "Black — RGB(0,0,0)") as the supervision `triggering_message`,
        // producing the nonsense "Your original task was: **Black**..."
        // nudge. The fix sources `original_task` from the conversation
        // root row via `get_message_by_event(&conversation_id)`. Verify
        // that lookup resolves correctly here.
        let root_row = store
            .get_message_by_event(CONV_ID)
            .unwrap()
            .expect("conversation root row must be present");
        assert_eq!(
            root_row.content, "delegate to agent2, ask for a colour",
            "original_task resolved from conversation root, not from \
             the delegatee's reply (this is Bug B's fix)"
        );

        // 4. Agent1 invocation 2 begins. BEFORE its step runs, projection
        //    must show the timeline in strict storage order. This is the
        //    exact seam where the splice used to put the in-memory
        //    re_engage_tail BEFORE the prior step rows, causing Bug A.
        let pre_callback = project_for(&store, AGENT1).await;
        assert_eq!(
            pre_callback,
            vec![
                CtxMessage::System { content: SYSTEM.into() },
                user_msg("delegate to agent2, ask for a colour"),
                assistant_with_delegate(
                    json!({"recipient": "agent2", "prompt": "pick a colour"}),
                    "call-1",
                ),
                CtxMessage::ToolResult {
                    tool_call_id: "call-1".into(),
                    tool_name: "delegate".into(),
                    content: "Black — RGB(0,0,0)".into(),
                    provider_call_id: None,
                    is_error: false,
                },
                user_msg("Black — RGB(0,0,0)"),
            ],
            "delegation callback timeline must follow storage sequence — Bug A seam"
        );

        // 5. Agent1 invocation 2 writes its terminal: a poem.
        write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV2,
            &assistant_terminal("Black like the night sky."),
            &Usage::new(),
        )
        .unwrap();

        let post_callback = project_for(&store, AGENT1).await;
        assert_eq!(
            post_callback.last(),
            Some(&assistant_terminal("Black like the night sky.")),
            "the inv-2 terminal lands at the tail; no duplication of inv-1's delegate"
        );
        assert_eq!(post_callback.len(), 6);
    }

    /// E2E: delegation completion projects with `[agent2]` attribution when
    /// a name resolver is configured (which is always the case in
    /// production — `agent_bootstrap` passes an `IdentityServiceResolver`).
    ///
    /// The mechanism: when more than one distinct pubkey has authored a
    /// `role=user` row in the conversation, projection prefixes every
    /// user message with `[name]` via the multi-author branch at
    /// `crates/tenex-context/src/projection.rs:66`. The delegate tool
    /// returns immediately with the ACK ("Delegated to @agent2.
    /// Delegation event ID: ..."), agent1 stops its turn, and when
    /// agent2 eventually completes its own work the runtime materializes
    /// agent2's reply as a new user row authored by agent2's pubkey —
    /// which is the second distinct user-author and triggers attribution.
    #[tokio::test]
    async fn e2e_delegation_completion_attributed_to_replying_agent() {
        let store = open();
        // Human triggers agent1.
        runtime_persist_user_event(
            &store,
            CONV_ID,
            "user-pk",
            "delegate to agent2 and report back",
            100,
        );

        // Agent1 invocation 1: emits the delegate tool call (non-blocking),
        // then a terminal "Waiting..." text, then exits. The tool result
        // is the ACK string the delegate tool itself returned — no value
        // ever replaces this row's content; the eventual reply arrives as
        // a fresh user row.
        let agent1_inv1_assistant = write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_with_delegate(
                json!({"recipient": "agent2", "prompt": "pick a colour"}),
                "call-1",
            ),
            &Usage::new(),
        )
        .unwrap();
        record_step_tool_messages(
            &store,
            CONV_ID,
            AGENT1,
            agent1_inv1_assistant,
            &[crate::tools::recording::ToolCallRecord {
                call_id: "call-1".into(),
                provider_call_id: None,
                tool_name: "delegate".into(),
                args: json!({"recipient": "agent2", "prompt": "pick a colour"}),
                // Real delegate-tool return value — agent2 hasn't replied
                // yet, this is the immediate ACK.
                result: json!(
                    "Delegated to @agent2. Delegation event ID: bb7bd910. \
                     Use this ID with delegate_followup if you need to send corrections before they finish. \
                     Stop here — do not take further actions this turn."
                ),
                is_error: false,
                timestamp_ms: 101_000,
            }],
        )
        .unwrap();
        // Terminal text from inv1 — agent1 stops here.
        write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_terminal("Waiting for agent2 to respond with a colour."),
            &Usage::new(),
        )
        .unwrap();

        // (Time passes. Agent2 does its work in its own conversation.)

        // Agent2 publishes a CompletionIntent. The runtime sees the event
        // (status=completed, p-tagged to agent1) and routes it back into
        // agent1's conversation via persist_user_message — same code path
        // any user message takes.
        runtime_persist_user_event(
            &store,
            "agent2-reply-event-id",
            AGENT2,
            "Black — RGB(0,0,0)",
            500,
        );

        // Agent1 callback invocation projects. With a resolver, multi-author
        // attribution fires (human + agent2 = 2 distinct user-authors).
        let resolver = stub_resolver();
        let projected =
            project_for_with_resolver(&store, AGENT1, Some(&resolver)).await;

        assert_eq!(
            projected,
            vec![
                CtxMessage::System { content: SYSTEM.into() },
                user_msg("[human] delegate to agent2 and report back"),
                assistant_with_delegate(
                    json!({"recipient": "agent2", "prompt": "pick a colour"}),
                    "call-1",
                ),
                CtxMessage::ToolResult {
                    tool_call_id: "call-1".into(),
                    tool_name: "delegate".into(),
                    content: "Delegated to @agent2. Delegation event ID: bb7bd910. \
                              Use this ID with delegate_followup if you need to send corrections before they finish. \
                              Stop here — do not take further actions this turn."
                        .into(),
                    provider_call_id: None,
                    is_error: false,
                },
                assistant_terminal("Waiting for agent2 to respond with a colour."),
                user_msg("[agent2] Black — RGB(0,0,0)"),
            ],
            "delegation reply lands as a `[agent2]`-prefixed user message; \
             the model sees who sent it and can correlate to its earlier delegate(...)"
        );
    }

    /// E2E: supervision nudge persistence preserves header invariant and
    /// surfaces in the next projection as `Message::User`.
    #[tokio::test]
    async fn e2e_supervision_nudge_projects_as_user_and_preserves_header() {
        let store = open();
        runtime_persist_user_event(&store, CONV_ID, "user-pk", "do A and B", 100);

        write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_terminal("Started on A and B."),
            &Usage::new(),
        )
        .unwrap();

        write_supervision_nudge(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            0,
            "Your original task was: do A and B. You have unfinished todo items: t-b.",
        )
        .unwrap();

        let projected = project_for(&store, AGENT1).await;
        let user_contents: Vec<&str> = projected
            .iter()
            .filter_map(|m| match m {
                CtxMessage::User { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            user_contents,
            vec![
                "do A and B",
                "Your original task was: do A and B. You have unfinished todo items: t-b.",
            ],
            "supervision nudge appears in projection as a User message at the tail"
        );

        let header = store.get_conversation(CONV_ID).unwrap().unwrap();
        assert_eq!(
            header.last_user_message.as_deref(),
            Some("do A and B"),
            "supervision-typed rows must NOT clobber the UX header"
        );
    }

    /// E2E: reconcile_assistant_event_id dedups when the runtime materialized
    /// the canonical row before the agent could stamp.
    #[tokio::test]
    async fn e2e_reconcile_dedups_when_runtime_won_the_race() {
        let store = open();
        runtime_persist_user_event(&store, CONV_ID, "user-pk", "hi", 100);

        // Agent persists synthetic step:... row first.
        let synthetic_row = write_step_assistant(
            &store,
            CONV_ID,
            AGENT1,
            EXEC_INV1,
            &assistant_terminal("hello back"),
            &Usage::new(),
        )
        .unwrap();

        // Runtime materializes the relay echo first.
        let canonical_row = runtime_persist_assistant_event(
            &store,
            "agent1-reply",
            AGENT1,
            "hello back",
            101,
        );

        // Reconciliation: deletes synthetic, returns canonical.
        let winner =
            reconcile_step_assistant_event_id(&store, synthetic_row, "agent1-reply").unwrap();
        assert_eq!(winner, canonical_row);

        // Projection now sees exactly one terminal-assistant row.
        let projected = project_for(&store, AGENT1).await;
        let assistant_count = projected
            .iter()
            .filter(|m| matches!(m, CtxMessage::Assistant { content, .. } if content == "hello back"))
            .count();
        assert_eq!(assistant_count, 1, "no duplicate terminal-assistant rows");
    }

    fn runtime_persist_assistant_event(
        store: &ConversationStore,
        event_id_hex: &str,
        author: &str,
        content: &str,
        ts_secs: i64,
    ) -> i64 {
        store
            .append_message(
                CONV_ID,
                &NewMessage {
                    record_id: format!("event:{event_id_hex}"),
                    nostr_event_id: Some(event_id_hex.into()),
                    author_pubkey: author.into(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".into(),
                    role: Some("assistant".into()),
                    content: content.into(),
                    timestamp: Some(ts_secs),
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

}

pub(super) async fn record_turn_accounting(
    boot: &AgentBootstrap,
    current_message: &str,
    response: &str,
    stream_usage: &rig_core::completion::Usage,
) {
    record_llm_call(RecordLlmCall {
        root_kind: RootKind::UserMessage.into(),
        provider: boot.resolved.provider.clone(),
        provider_model_id: boot.resolved.model.clone(),
        operation: "stream".into(),
        agent_pubkey: Some(boot.pubkey_hex.clone()),
        agent_slug: Some(boot.agent_slug.clone()),
        conversation_id: Some(boot.conversation_id.clone()),
        project_id: Some(boot.project_id.clone()),
        user_message: Some(current_message.to_string()),
        assistant_response: Some(response.to_string()),
        usage: LlmUsage {
            input_tokens: stream_usage.input_tokens,
            output_tokens: stream_usage.output_tokens,
            cached_input_tokens: stream_usage.cached_input_tokens,
            cache_creation_input_tokens: stream_usage.cache_creation_input_tokens,
            reasoning_tokens: 0,
            total_tokens: Some(stream_usage.total_tokens),
        },
        ..Default::default()
    })
    .await;
}

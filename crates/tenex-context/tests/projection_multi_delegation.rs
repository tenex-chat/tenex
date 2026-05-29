//! Multi-delegation integration tests. Exercises the production code
//! paths (`add_delegation_marker`, `update_delegation_marker`,
//! `latest_delegation_markers`, projection's strategy stack, and the
//! storage-backed "is anything still pending" check) for scenarios
//! where the parent agent has multiple outstanding delegations
//! resolving at different times.
//!
//! The single-delegation case is end-to-end covered by the
//! `delegation-basic` runtime probe (real ollama LLM, real subprocess
//! pipeline) — see `scripts/tenex-runtime-probe.ts`. This file fills
//! the multi-delegation gap that probe doesn't reach today.

use tenex_context::{project, DisplayNameResolver, Message, ModelProfile};
use tenex_conversations::{
    ConversationStore, DelegationMarker, DelegationStatus, NewMessage,
};

const CONV: &str = "rooteventaaaaaaa";
const PM_PK: &str = "pm-pubkey";
const WORKER_A: &str = "worker-a-pubkey";
const WORKER_B: &str = "worker-b-pubkey";
const WORKER_C: &str = "worker-c-pubkey";

struct Names;
impl DisplayNameResolver for Names {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        match pubkey {
            PM_PK => Some("pm".into()),
            WORKER_A => Some("worker-a".into()),
            WORKER_B => Some("worker-b".into()),
            WORKER_C => Some("worker-c".into()),
            "user-pk" => Some("human".into()),
            _ => None,
        }
    }
}

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

fn open_with_trigger() -> ConversationStore {
    let s = ConversationStore::open_in_memory().unwrap();
    s.ensure_conversation(CONV).unwrap();
    s.append_message(
        CONV,
        &NewMessage {
            record_id: format!("event:{CONV}"),
            nostr_event_id: Some(CONV.into()),
            author_pubkey: "user-pk".into(),
            sender_pubkey: None,
            ral: None,
            message_type: "text".into(),
            role: Some("user".into()),
            content: "Delegate to workers a, b, c in parallel and report all colors.".into(),
            timestamp: Some(100),
            targeted_pubkeys: None,
            sender_principal: None,
            targeted_principals: None,
            tool_data: None,
            delegation_marker: None,
            human_readable: None,
            transcript_tool_attributes: None,
        },
    )
    .unwrap();
    s
}

fn add_pending(store: &ConversationStore, child_conv: &str, recipient_pk: &str, ts: i64) {
    let m = DelegationMarker {
        delegation_conversation_id: child_conv.into(),
        recipient_pubkey: recipient_pk.into(),
        parent_conversation_id: CONV.into(),
        initiated_at: Some(ts),
        completed_at: None,
        status: DelegationStatus::Pending,
        abort_reason: None,
    };
    store
        .add_delegation_marker(CONV, &m, PM_PK, Some(1))
        .unwrap();
}

fn complete(store: &ConversationStore, child_conv: &str, recipient_pk: &str, ts: i64) {
    store
        .update_delegation_marker(
            CONV,
            child_conv,
            recipient_pk,
            PM_PK,
            DelegationStatus::Completed,
            ts,
            None,
        )
        .unwrap();
}

fn write_child_reply(store: &ConversationStore, child_conv: &str, author: &str, content: &str, ts: i64) {
    store.ensure_conversation(child_conv).unwrap();
    store
        .append_message(
            child_conv,
            &NewMessage {
                record_id: format!("event:reply-{child_conv}"),
                nostr_event_id: Some(format!("reply-{child_conv}")),
                author_pubkey: author.into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
                content: content.into(),
                timestamp: Some(ts),
                targeted_pubkeys: Some(vec![PM_PK.into()]),
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

async fn project_pm(store: &ConversationStore) -> Vec<Message> {
    project(
        store,
        CONV,
        PM_PK,
        "<sys>",
        &profile(),
        &[],
        None,
        Some(&Names),
        None,
        None,
    )
    .await
    .unwrap()
    .messages
}

fn pending_count(store: &ConversationStore) -> usize {
    store
        .latest_delegation_markers(CONV)
        .unwrap()
        .values()
        .filter(|m| matches!(m.status, DelegationStatus::Pending))
        .count()
}

/// True iff at least one delegation in this conversation still has a
/// latest marker with `status = Pending`. Mirrors the in-tree
/// `has_pending_delegations_in_store` helper that gates completion
/// emission in `tenex-agent`'s `turn_loop/mod.rs`.
fn any_pending(store: &ConversationStore) -> bool {
    store
        .latest_delegation_markers(CONV)
        .unwrap()
        .values()
        .any(|m| matches!(m.status, DelegationStatus::Pending))
}

fn last_user_content(messages: &[Message]) -> &str {
    for m in messages.iter().rev() {
        if let Message::User { content, .. } = m {
            return content.as_str();
        }
    }
    ""
}

#[tokio::test]
async fn three_pending_delegations_show_as_single_reminder_block_with_all_entries() {
    // PM issued three delegations in parallel (mimics the LLM emitting
    // three tool_calls in one assistant turn). Each writes a Pending
    // marker. The projection must show a SINGLE `<system-reminder>`
    // overlay listing all three, not three separate user messages.

    let store = open_with_trigger();
    add_pending(&store, "child-a-12345aaa", WORKER_A, 101);
    add_pending(&store, "child-b-12345bbb", WORKER_B, 102);
    add_pending(&store, "child-c-12345ccc", WORKER_C, 103);

    assert_eq!(pending_count(&store), 3);
    assert!(any_pending(&store));

    let messages = project_pm(&store).await;

    // No standalone `# DELEGATION IN PROGRESS` user message — that
    // shape was rejected in favour of the reminder overlay.
    let standalone_progress = messages.iter().any(|m| matches!(
        m,
        Message::User { content, .. }
            if content.starts_with("# DELEGATION IN PROGRESS")
    ));
    assert!(!standalone_progress);

    // No leftover `Message::DelegationMarker` variants — the strategy
    // either rewrites them (terminal) or pulls them out (pending).
    assert!(!messages.iter().any(|m| matches!(m, Message::DelegationMarker { .. })));

    // The reminder lands on the last visible non-system message (the
    // trigger user message here).
    let tail = last_user_content(&messages);
    assert!(tail.contains("<system-reminder>\n<agent-delegations>"));
    assert!(tail.contains("Status: 3 pending"));
    assert!(tail.contains("[~] @worker-a (delegation: child-a-12...) — pending"));
    assert!(tail.contains("[~] @worker-b (delegation: child-b-12...) — pending"));
    assert!(tail.contains("[~] @worker-c (delegation: child-c-12...) — pending"));
    assert!(tail.contains("**ATTENTION:** You have 3 outstanding delegation"));
}

#[tokio::test]
async fn pending_reminder_shrinks_as_each_delegation_completes_in_order() {
    // Three workers complete at different times (different ts). After
    // each completion, the reminder must drop that entry and the
    // completed delegation must appear as its own
    // `# DELEGATION COMPLETED` user message at its sequence position.

    let store = open_with_trigger();
    add_pending(&store, "child-a", WORKER_A, 101);
    add_pending(&store, "child-b", WORKER_B, 102);
    add_pending(&store, "child-c", WORKER_C, 103);

    // Worker A completes first.
    write_child_reply(&store, "child-a", WORKER_A, "red", 200);
    complete(&store, "child-a", WORKER_A, 200);
    {
        let messages = project_pm(&store).await;
        // Suppression check: 2 still pending — completion must NOT fire.
        assert!(any_pending(&store), "two delegations still pending");

        // The completed marker appears as a User message in the array.
        let completed_blocks = messages
            .iter()
            .filter_map(|m| match m {
                Message::User { content, .. } if content.starts_with("# DELEGATION COMPLETED") => {
                    Some(content.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(completed_blocks.len(), 1, "exactly one completion so far");
        assert!(completed_blocks[0].contains("author=\"worker-a\""));
        assert!(completed_blocks[0].contains(">red</message>"));

        // The reminder now lists only the two remaining pending.
        let tail = last_user_content(&messages);
        assert!(tail.contains("Status: 2 pending"));
        assert!(tail.contains("[~] @worker-b"));
        assert!(tail.contains("[~] @worker-c"));
        assert!(!tail.contains("[~] @worker-a"), "completed marker must drop out");
    }

    // Worker B completes next.
    write_child_reply(&store, "child-b", WORKER_B, "blue", 300);
    complete(&store, "child-b", WORKER_B, 300);
    {
        let messages = project_pm(&store).await;
        assert!(any_pending(&store), "one delegation still pending");

        let completed_blocks = messages
            .iter()
            .filter(|m| matches!(m, Message::User { content, .. }
                if content.starts_with("# DELEGATION COMPLETED")))
            .count();
        assert_eq!(completed_blocks, 2);

        let tail = last_user_content(&messages);
        assert!(tail.contains("Status: 1 pending"));
        assert!(tail.contains("[~] @worker-c"));
    }

    // Worker C completes — all done.
    write_child_reply(&store, "child-c", WORKER_C, "green", 400);
    complete(&store, "child-c", WORKER_C, 400);
    {
        let messages = project_pm(&store).await;
        assert!(
            !any_pending(&store),
            "all delegations have completed; suppression must release so PM can emit CompletionIntent"
        );

        let completed_blocks = messages
            .iter()
            .filter(|m| matches!(m, Message::User { content, .. }
                if content.starts_with("# DELEGATION COMPLETED")))
            .count();
        assert_eq!(completed_blocks, 3);

        // No `<agent-delegations>` reminder when nothing is pending.
        let any_reminder = messages.iter().any(|m| match m {
            Message::User { content, .. } | Message::Assistant { content, .. } => {
                content.contains("<agent-delegations>")
            }
            _ => false,
        });
        assert!(
            !any_reminder,
            "reminder must vanish entirely when no pending delegations remain"
        );
    }
}

#[tokio::test]
async fn completed_delegations_land_at_their_own_sequence_positions_independently() {
    // Pin the sequence-ordering property for multi-delegation:
    // each completion lands at the conversation-sequence position
    // where its marker upsert was written, NOT at the position of
    // the original delegate. Intervening messages (e.g., user
    // follow-ups during the pending window) keep their relative
    // order to BOTH the delegate and the completion.

    let store = open_with_trigger();

    // PM issues 2 delegations at sequence positions 1, 2.
    add_pending(&store, "child-a", WORKER_A, 101);
    add_pending(&store, "child-b", WORKER_B, 102);

    // 3 human follow-ups arrive while workers are working.
    for (i, txt) in ["follow-up-1", "follow-up-2", "follow-up-3"].iter().enumerate() {
        let event_id = format!("evt-{i}");
        store
            .append_message(
                CONV,
                &NewMessage {
                    record_id: format!("event:{event_id}"),
                    nostr_event_id: Some(event_id),
                    author_pubkey: "user-pk".into(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".into(),
                    role: Some("user".into()),
                    content: txt.to_string(),
                    timestamp: Some(110 + i as i64),
                    targeted_pubkeys: None,
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

    // Worker A completes BEFORE worker B (after the 3 follow-ups).
    write_child_reply(&store, "child-a", WORKER_A, "red", 200);
    complete(&store, "child-a", WORKER_A, 200);

    // Worker B completes LATER (still after follow-ups).
    write_child_reply(&store, "child-b", WORKER_B, "blue", 300);
    complete(&store, "child-b", WORKER_B, 300);

    let messages = project_pm(&store).await;
    let user_contents: Vec<&str> = messages
        .iter()
        .filter_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    let pos = |needle: &str| -> usize {
        user_contents
            .iter()
            .position(|c| c.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} missing in {user_contents:#?}"))
    };

    // Expected ordering:
    //   trigger → follow-up-1 → follow-up-2 → follow-up-3 → A completed → B completed
    let trigger = pos("Delegate to workers");
    let f1 = pos("follow-up-1");
    let f2 = pos("follow-up-2");
    let f3 = pos("follow-up-3");
    let comp_a_idx = user_contents.iter().position(|c|
        c.contains(">red</message>")
    ).expect("# DELEGATION COMPLETED for A missing");
    let comp_b_idx = user_contents.iter().position(|c|
        c.contains(">blue</message>")
    ).expect("# DELEGATION COMPLETED for B missing");

    assert!(trigger < f1 && f1 < f2 && f2 < f3, "follow-ups in order");
    assert!(
        f3 < comp_a_idx,
        "completion lands AFTER the follow-ups, not at the delegate's position"
    );
    assert!(comp_a_idx < comp_b_idx, "A completed before B");
}

#[tokio::test]
async fn one_aborted_among_completed_renders_with_reason_alongside_others() {
    // Aborted delegations get the `# DELEGATION ABORTED` framing
    // with the reason. The other completed delegations still get
    // their `# DELEGATION COMPLETED` blocks; aborted is just a
    // different terminal state.

    let store = open_with_trigger();
    add_pending(&store, "child-a", WORKER_A, 101);
    add_pending(&store, "child-b", WORKER_B, 102);

    write_child_reply(&store, "child-a", WORKER_A, "red", 200);
    complete(&store, "child-a", WORKER_A, 200);

    store
        .update_delegation_marker(
            CONV,
            "child-b",
            WORKER_B,
            PM_PK,
            DelegationStatus::Aborted,
            300,
            Some("agent killed".into()),
        )
        .unwrap();

    assert!(!any_pending(&store));
    let messages = project_pm(&store).await;

    let completed = messages.iter().any(|m| matches!(m,
        Message::User { content, .. }
            if content.starts_with("# DELEGATION COMPLETED")
            && content.contains(">red</message>")
    ));
    let aborted = messages.iter().any(|m| matches!(m,
        Message::User { content, .. }
            if content.starts_with("# DELEGATION ABORTED")
            && content.contains("**Reason:** agent killed")
    ));
    assert!(completed, "A's # DELEGATION COMPLETED must appear");
    assert!(aborted, "B's # DELEGATION ABORTED with reason must appear");
}

#[tokio::test]
async fn upserts_to_the_same_delegation_keep_only_the_latest_status() {
    // If the runtime re-emits the same completion (idempotency
    // retry), `add_delegation_marker`'s record_id-based dedup keeps
    // only one row per (delegation, status). The projection
    // filter then keeps only the LATEST status per delegation.
    // Three writes (Pending → Pending again [no-op] → Completed)
    // must collapse to exactly one Completed render with no
    // Pending leaks.

    let store = open_with_trigger();
    add_pending(&store, "child-a", WORKER_A, 101);
    add_pending(&store, "child-a", WORKER_A, 101); // idempotent retry
    write_child_reply(&store, "child-a", WORKER_A, "yellow", 200);
    complete(&store, "child-a", WORKER_A, 200);
    complete(&store, "child-a", WORKER_A, 200); // idempotent retry

    assert!(!any_pending(&store));
    let messages = project_pm(&store).await;
    let completed_count = messages
        .iter()
        .filter(|m| matches!(m, Message::User { content, .. }
            if content.starts_with("# DELEGATION COMPLETED")))
        .count();
    assert_eq!(completed_count, 1);
    let pending_in_reminder = messages.iter().any(|m| match m {
        Message::User { content, .. } | Message::Assistant { content, .. } => {
            content.contains("Status: 1 pending")
        }
        _ => false,
    });
    assert!(
        !pending_in_reminder,
        "idempotent retry must not leave stale pending state in projection"
    );
}

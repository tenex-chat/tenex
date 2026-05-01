//! End-to-end integration tests for tenex-conversations.

use std::path::PathBuf;

use serde_json::json;
use tempfile::TempDir;
use tenex_conversations::model::{AgentContextState, CompletionStatus, ConversationRow};
use tenex_conversations::{
    ConversationListFilter, ConversationStore, MessageQuery, NewCompletion, NewMessage,
    NewPromptHistoryEntry, NewToolMessage, Project,
};

fn make_conversation(store: &ConversationStore, id: &str, last_activity: i64) {
    store
        .upsert_conversation(&ConversationRow {
            id: id.to_owned(),
            title: Some(format!("Conversation {id}")),
            summary: None,
            last_user_message: Some("hello".into()),
            status_label: None,
            status_current_activity: None,
            owner_pubkey: Some("alice".into()),
            created_at: Some(last_activity - 100),
            last_activity: Some(last_activity),
            metadata: json!({"tag": "v1"}),
            runtime_state: json!({}),
            updated_at: 1,
        })
        .unwrap();
}

#[test]
fn open_creates_db_and_runs_migrations() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("conversation.db");
    let store = ConversationStore::open(&path).unwrap();
    drop(store);
    assert!(path.is_file());
    let store = ConversationStore::open(&path).unwrap();
    assert!(store
        .list_recent(ConversationListFilter::default())
        .unwrap()
        .is_empty());
}

#[test]
fn append_message_maintains_conversation_header_and_metadata() {
    let store = ConversationStore::open_in_memory().unwrap();

    store
        .append_message(
            "conv-header",
            &NewMessage {
                record_id: "record:user-new".into(),
                nostr_event_id: None,
                author_pubkey: "alice".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
                content: "new request".into(),
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
    store
        .append_message(
            "conv-header",
            &NewMessage {
                record_id: "record:assistant".into(),
                nostr_event_id: None,
                author_pubkey: "bob".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("assistant".into()),
                content: "response".into(),
                timestamp: Some(120),
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
    store
        .append_message(
            "conv-header",
            &NewMessage {
                record_id: "record:user-old".into(),
                nostr_event_id: None,
                author_pubkey: "alice".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
                content: "old request".into(),
                timestamp: Some(90),
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

    store
        .update_metadata(
            "conv-header",
            Some("Generated Title"),
            Some("Generated summary."),
            Some("In Progress"),
            Some("Maintaining headers."),
        )
        .unwrap();

    let conversation = store.get_conversation("conv-header").unwrap().unwrap();
    assert_eq!(conversation.owner_pubkey.as_deref(), Some("alice"));
    assert_eq!(conversation.created_at, Some(90));
    assert_eq!(conversation.last_activity, Some(120));
    assert_eq!(
        conversation.last_user_message.as_deref(),
        Some("new request")
    );
    assert_eq!(conversation.title.as_deref(), Some("Generated Title"));
    assert_eq!(conversation.summary.as_deref(), Some("Generated summary."));
    assert_eq!(
        conversation.metadata.get("statusCurrentActivity").unwrap(),
        "Maintaining headers."
    );
}

#[test]
fn round_trip_messages_tool_messages_prompt_history_completion() {
    let store = ConversationStore::open_in_memory().unwrap();
    store.ensure_conversation("conv-1").unwrap();

    let m1 = store
        .append_message(
            "conv-1",
            &NewMessage {
                record_id: "record:1".into(),
                nostr_event_id: Some("event-1".into()),
                author_pubkey: "alice".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: None,
                content: "hello".into(),
                timestamp: Some(100),
                targeted_pubkeys: Some(vec!["bob".into()]),
                sender_principal: None,
                targeted_principals: None,
                tool_data: None,
                delegation_marker: None,
                human_readable: None,
                transcript_tool_attributes: None,
            },
        )
        .unwrap();
    assert!(m1 > 0);

    // Idempotency by record_id.
    let m1_again = store
        .append_message(
            "conv-1",
            &NewMessage {
                record_id: "record:1".into(),
                nostr_event_id: None,
                author_pubkey: "alice".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: None,
                content: "different content".into(),
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
    assert_eq!(m1, m1_again);

    // Idempotency by nostr_event_id.
    let m1_again2 = store
        .append_message(
            "conv-1",
            &NewMessage {
                record_id: "record:1-other".into(),
                nostr_event_id: Some("event-1".into()),
                author_pubkey: "alice".into(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: None,
                content: "x".into(),
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
    assert_eq!(m1, m1_again2);

    let m2 = store
        .append_message(
            "conv-1",
            &NewMessage {
                record_id: "record:2".into(),
                nostr_event_id: None,
                author_pubkey: "bob".into(),
                sender_pubkey: None,
                ral: Some(1),
                message_type: "text".into(),
                role: None,
                content: "world".into(),
                timestamp: Some(200),
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
    assert!(m2 > m1);

    let messages = store
        .list_messages("conv-1", MessageQuery::default())
        .unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].sequence, 0);
    assert_eq!(messages[1].sequence, 1);
    assert_eq!(messages[1].author_pubkey, "bob");

    let bob_only = store
        .list_messages(
            "conv-1",
            MessageQuery {
                agent_pubkey: Some("bob".into()),
                ..MessageQuery::default()
            },
        )
        .unwrap();
    assert_eq!(bob_only.len(), 1);
    assert_eq!(bob_only[0].author_pubkey, "bob");

    // Tool message round-trip.
    let tm_id = store
        .record_tool_message(
            "conv-1",
            &NewToolMessage {
                tool_call_id: "tc-1".into(),
                parent_message_id: Some(m2),
                agent_pubkey: "bob".into(),
                tool_name: "shell".into(),
                call_input: json!({"command": "ls"}),
                result_output: None,
                is_error: false,
                timestamp: Some(201),
            },
        )
        .unwrap();
    // Insert result by re-record.
    let tm_id2 = store
        .record_tool_message(
            "conv-1",
            &NewToolMessage {
                tool_call_id: "tc-1".into(),
                parent_message_id: None,
                agent_pubkey: "bob".into(),
                tool_name: "shell".into(),
                call_input: json!({"command": "ls"}),
                result_output: Some(json!({"stdout": "a\nb\n"})),
                is_error: false,
                timestamp: Some(202),
            },
        )
        .unwrap();
    assert_eq!(tm_id, tm_id2);

    let tools = store.list_tool_messages("conv-1").unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool_name, "shell");
    assert!(tools[0].result_output.is_some());

    // Prompt history.
    store
        .append_prompt_history(
            "conv-1",
            &NewPromptHistoryEntry {
                agent_pubkey: "bob".into(),
                prompt_id: "prompt:1".into(),
                sequence: 0,
                role: "user".into(),
                source_kind: "canonical".into(),
                source_message_id: Some("record:1".into()),
                source_record_id: None,
                source_event_id: Some("event-1".into()),
                overlay_type: None,
                content: json!("hello"),
            },
        )
        .unwrap();
    store
        .append_prompt_history(
            "conv-1",
            &NewPromptHistoryEntry {
                agent_pubkey: "bob".into(),
                prompt_id: "prompt:2".into(),
                sequence: 1,
                role: "assistant".into(),
                source_kind: "canonical".into(),
                source_message_id: None,
                source_record_id: None,
                source_event_id: None,
                overlay_type: None,
                content: json!("hi"),
            },
        )
        .unwrap();

    let prompt = store.list_prompt_history("conv-1", "bob").unwrap();
    assert_eq!(prompt.len(), 2);
    assert_eq!(prompt[0].role, "user");
    assert_eq!(prompt[1].role, "assistant");

    // Agent context state.
    let state = AgentContextState {
        conversation_id: "conv-1".into(),
        agent_pubkey: "bob".into(),
        next_prompt_sequence: 2,
        cache_anchored: true,
        seen_message_ids: vec!["record:1".into(), "record:2".into()],
        compaction_state: None,
        reminder_state: Some(json!({"providers": {}})),
        reminder_delta_state: None,
        todos: None,
        self_applied_skills: Some(json!(["skill-a"])),
        meta_model_variant: Some("gpt-4o".into()),
        is_blocked: false,
        todo_nudged: false,
        updated_at: 999,
    };
    store.upsert_agent_context_state(&state).unwrap();
    let read = store
        .get_agent_context_state("conv-1", "bob")
        .unwrap()
        .unwrap();
    assert_eq!(read.next_prompt_sequence, 2);
    assert!(read.cache_anchored);
    assert_eq!(read.seen_message_ids.len(), 2);
    assert_eq!(read.meta_model_variant.as_deref(), Some("gpt-4o"));

    // Completion.
    let cid = store
        .record_completion(
            "conv-1",
            &NewCompletion {
                root_event_id: Some("event-root".into()),
                completed_by_pubkey: "bob".into(),
                recipient_pubkey: Some("alice".into()),
                status: CompletionStatus::Completed,
                abort_reason: None,
                nostr_event_id: Some("event-completion-1".into()),
                completed_at: 1000,
                metadata: None,
            },
        )
        .unwrap();
    // Idempotency on nostr_event_id.
    let cid_again = store
        .record_completion(
            "conv-1",
            &NewCompletion {
                root_event_id: None,
                completed_by_pubkey: "bob".into(),
                recipient_pubkey: None,
                status: CompletionStatus::Completed,
                abort_reason: None,
                nostr_event_id: Some("event-completion-1".into()),
                completed_at: 1000,
                metadata: None,
            },
        )
        .unwrap();
    assert_eq!(cid, cid_again);
    let completions = store.list_completions("conv-1").unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status, CompletionStatus::Completed);
}

#[test]
fn list_messages_supports_pagination() {
    let store = ConversationStore::open_in_memory().unwrap();
    store.ensure_conversation("paged").unwrap();
    for i in 0..5 {
        store
            .append_message(
                "paged",
                &NewMessage {
                    record_id: format!("r:{i}"),
                    nostr_event_id: None,
                    author_pubkey: "alice".into(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".into(),
                    role: None,
                    content: format!("msg {i}"),
                    timestamp: Some(i),
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

    let page1 = store
        .list_messages(
            "paged",
            MessageQuery {
                limit: Some(2),
                offset: Some(0),
                ..MessageQuery::default()
            },
        )
        .unwrap();
    assert_eq!(page1.len(), 2);
    assert_eq!(page1[0].sequence, 0);
    assert_eq!(page1[1].sequence, 1);

    let page2 = store
        .list_messages(
            "paged",
            MessageQuery {
                limit: Some(2),
                offset: Some(2),
                ..MessageQuery::default()
            },
        )
        .unwrap();
    assert_eq!(page2.len(), 2);
    assert_eq!(page2[0].sequence, 2);
    assert_eq!(page2[1].sequence, 3);
}

#[test]
fn list_recent_orders_by_last_activity_desc() {
    let store = ConversationStore::open_in_memory().unwrap();
    make_conversation(&store, "older", 100);
    make_conversation(&store, "middle", 200);
    make_conversation(&store, "newest", 300);

    let rows = store
        .list_recent(ConversationListFilter {
            limit: Some(10),
            ..ConversationListFilter::default()
        })
        .unwrap();
    let ids: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
    assert_eq!(ids, vec!["newest", "middle", "older"]);
}

#[test]
fn list_by_participant_returns_conversations_with_author_or_target() {
    let store = ConversationStore::open_in_memory().unwrap();
    store.ensure_conversation("c1").unwrap();
    store.ensure_conversation("c2").unwrap();
    store.ensure_conversation("c3").unwrap();

    let dummy = |conv: &str, author: &str, targeted: Option<Vec<String>>| NewMessage {
        record_id: format!("r:{conv}:{author}"),
        nostr_event_id: None,
        author_pubkey: author.into(),
        sender_pubkey: None,
        ral: None,
        message_type: "text".into(),
        role: None,
        content: "hi".into(),
        timestamp: Some(1),
        targeted_pubkeys: targeted,
        sender_principal: None,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    };
    store
        .append_message("c1", &dummy("c1", "alice", None))
        .unwrap();
    store
        .append_message("c2", &dummy("c2", "bob", Some(vec!["alice".into()])))
        .unwrap();
    store
        .append_message("c3", &dummy("c3", "carol", None))
        .unwrap();

    let rows = store.list_by_participant("alice", None).unwrap();
    let ids: std::collections::HashSet<_> = rows.iter().map(|r| r.id.clone()).collect();
    assert!(ids.contains("c1"));
    assert!(ids.contains("c2"));
    assert!(!ids.contains("c3"));
}

#[test]
fn project_open_resolves_both_id_forms_to_same_db() {
    let tmp = TempDir::new().unwrap();
    let base = tmp.path();
    let pubkey = "a".repeat(64);
    let coord = format!("31933:{pubkey}:my-project");

    let store_a = Project::open_conversations(&coord, base).unwrap();
    drop(store_a);
    let store_b = Project::open_conversations("my-project", base).unwrap();
    drop(store_b);

    let expected: PathBuf = base.join("projects/my-project/conversation.db");
    assert!(expected.is_file());
}

#[test]
fn migration_from_legacy_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let base = tmp.path();
    let d_tag = "demo-project";
    let project_dir = base.join("projects").join(d_tag);
    let conversations_dir = project_dir.join("conversations");
    std::fs::create_dir_all(&conversations_dir).unwrap();

    let conversation_id = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    let transcript = json!({
        "messages": [
            {
                "id": "record:msg-1",
                "pubkey": "alice",
                "content": "git pull",
                "messageType": "text",
                "eventId": conversation_id,
                "timestamp": 100,
                "targetedPubkeys": ["bob"],
            },
            {
                "id": "record:msg-2",
                "pubkey": "bob",
                "ral": 1,
                "content": "pulling",
                "messageType": "text",
                "timestamp": 110,
            },
        ],
        "metadata": {
            "title": "Git Pull",
            "summary": "ran git pull",
            "lastUserMessage": "git pull",
        },
        "agentPromptHistories": {
            "bob": {
                "messages": [
                    {
                        "id": "prompt:1",
                        "role": "user",
                        "content": "git pull",
                        "source": {
                            "kind": "canonical",
                            "sourceMessageId": "record:msg-1",
                        }
                    }
                ],
                "seenMessageIds": ["record:msg-1"],
                "nextSequence": 1,
                "cacheAnchored": true,
            }
        },
        "blockedAgents": [],
        "executionTime": {"totalSeconds": 2, "isActive": false, "lastUpdated": 1},
    });
    std::fs::write(
        conversations_dir.join(format!("{conversation_id}.json")),
        serde_json::to_string(&transcript).unwrap(),
    )
    .unwrap();

    // Tool message in nested form.
    let tool_dir = base.join("tool-messages").join(conversation_id);
    std::fs::create_dir_all(&tool_dir).unwrap();
    let tool_payload = json!({
        "conversationId": conversation_id,
        "toolCallId": "call-1",
        "agentPubkey": "bob",
        "timestamp": 120,
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool-call",
                        "toolCallId": "call-1",
                        "toolName": "shell",
                        "input": {"command": "git pull"}
                    }
                ]
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "toolCallId": "call-1",
                        "toolName": "shell",
                        "output": {"type": "text", "value": "ok"}
                    }
                ]
            }
        ]
    });
    std::fs::write(
        tool_dir.join("call-1.json"),
        serde_json::to_string(&tool_payload).unwrap(),
    )
    .unwrap();

    // Flat-format tool-message: at the top level of tool-messages/, payload's
    // outer `eventId` is the conversation id (older shape).
    let flat_payload = json!({
        "eventId": conversation_id,
        "agentPubkey": "bob",
        "timestamp": 130,
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool-call",
                        "toolCallId": "call-2",
                        "toolName": "shell",
                        "input": {"command": "git status"}
                    }
                ]
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "toolCallId": "call-2",
                        "toolName": "shell",
                        "output": {"type": "text", "value": "clean"}
                    }
                ]
            }
        ]
    });
    std::fs::write(
        base.join("tool-messages")
            .join(format!("{conversation_id}.json")),
        serde_json::to_string(&flat_payload).unwrap(),
    )
    .unwrap();

    let report = Project::migrate_from_legacy(d_tag, base).unwrap();
    assert_eq!(report.conversations_migrated, 1);
    assert_eq!(report.messages_migrated, 2);
    assert_eq!(report.prompt_history_entries_migrated, 1);
    assert_eq!(report.agent_context_states_migrated, 1);
    assert_eq!(report.tool_messages_migrated, 2);

    // Flat file archived after migration.
    assert!(!base
        .join("tool-messages")
        .join(format!("{conversation_id}.json"))
        .exists());
    assert!(base
        .join("tool-messages")
        .join(format!(
            "{conversation_id}.json{}",
            tenex_conversations::paths::LEGACY_BAK_SUFFIX
        ))
        .exists());

    // Re-running yields no duplicates.
    let report2 = Project::migrate_from_legacy(d_tag, base).unwrap();

    let store = Project::open_conversations(d_tag, base).unwrap();
    let messages = store
        .list_messages(conversation_id, MessageQuery::default())
        .unwrap();
    assert_eq!(messages.len(), 2);
    let tools = store.list_tool_messages(conversation_id).unwrap();
    assert_eq!(tools.len(), 2);
    let prompt = store.list_prompt_history(conversation_id, "bob").unwrap();
    assert_eq!(prompt.len(), 1);
    let conv = store.get_conversation(conversation_id).unwrap().unwrap();
    assert_eq!(conv.title.as_deref(), Some("Git Pull"));
    assert_eq!(conv.owner_pubkey.as_deref(), Some("alice"));

    // Originals archived, not deleted.
    assert!(!project_dir.join("conversations").exists());
    assert!(project_dir
        .join(format!(
            "conversations{}",
            tenex_conversations::paths::LEGACY_BAK_SUFFIX
        ))
        .exists());

    let _ = report2;
}

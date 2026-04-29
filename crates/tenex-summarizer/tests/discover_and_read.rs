//! End-to-end happy-path: build a fixture `~/.tenex/projects/<dTag>/` layout,
//! point `TENEX_BASE_DIR` at it, and verify the daemon's read path picks up
//! the project, lists the candidate from `conversation.db`, fetches the
//! transcript, and writes metadata back to the same database. The LLM call is
//! the next step after `fetch_content` in `process_inner`; this test stops at
//! the LLM boundary, since rig-core's provider clients are out of scope.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tempfile::tempdir;
use tenex_conversations::{ConversationStore, NewMessage};
use tenex_summarizer::{source, state};

#[test]
fn discovers_project_lists_candidate_reads_transcript() {
    let tmp = tempdir().unwrap();
    let base = tmp.path();
    // SAFETY: env var manipulation is process-global; this test runs serially
    // because no other test in this crate touches TENEX_BASE_DIR.
    unsafe { std::env::set_var("TENEX_BASE_DIR", base) };

    let d_tag = "FixtureProject-1234";
    let project_dir = base.join("projects").join(d_tag);
    fs::create_dir_all(&project_dir).unwrap();

    let pubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let event_json = json!({
        "id": "rooteventid",
        "pubkey": pubkey,
        "kind": 31933,
        "created_at": 1_700_000_000,
        "tags": [["d", d_tag], ["title", "Fixture"]],
        "content": "",
    });
    fs::write(
        project_dir.join("event.json"),
        serde_json::to_vec_pretty(&event_json).unwrap(),
    )
    .unwrap();

    let conversation_id = "abc123def4567890abc123def4567890abc123def4567890abc123def4567890";
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let last_activity = now_secs - 60;

    let db_path = project_dir.join("conversation.db");
    let store = ConversationStore::open(&db_path).unwrap();
    store.ensure_conversation(conversation_id).unwrap();
    store
        .append_message(
            conversation_id,
            &message(
                "record:1",
                pubkey,
                Some("user"),
                "text",
                "How does the summarizer work?",
                Some(json!({ "displayName": "Pablo" })),
                Some(last_activity - 10),
            ),
        )
        .unwrap();
    store
        .append_message(
            conversation_id,
            &message(
                "record:2",
                pubkey,
                Some("system"),
                "text",
                "It polls every five seconds.",
                None,
                Some(last_activity),
            ),
        )
        .unwrap();
    store
        .append_message(
            conversation_id,
            &message(
                "record:3",
                pubkey,
                Some("assistant"),
                "tool-call",
                "ignored",
                None,
                Some(last_activity),
            ),
        )
        .unwrap();
    drop(store);

    let projects = source::discover_projects().unwrap();
    assert_eq!(projects.len(), 1);
    let project = &projects[0];
    assert_eq!(project.d_tag, d_tag);

    let project_event = source::load_project_event(project).unwrap();
    assert_eq!(project_event.pubkey, pubkey);
    assert_eq!(project_event.d_tag, d_tag);
    assert_eq!(project_event.tag_id(), format!("31933:{pubkey}:{d_tag}"));

    let candidates = source::list_candidates(project, 10, 3_600).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].conversation_id, conversation_id);
    assert_eq!(candidates[0].last_activity, last_activity);

    let content = source::fetch_content(project, &project_event, conversation_id)
        .unwrap()
        .unwrap();
    assert!(content
        .transcript
        .contains("Pablo: How does the summarizer work?"));
    assert!(content
        .transcript
        .contains("system: It polls every five seconds."));
    assert!(!content.transcript.contains("ignored"));

    let state_db_path = base.join("summarizer").join("state.db");
    let store = state::SummaryStateStore::open(&state_db_path).unwrap();
    assert!(store.get(conversation_id).unwrap().is_none());
    let now_ms = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()) as i64;
    store
        .record(conversation_id, last_activity, now_ms)
        .unwrap();
    let s = store.get(conversation_id).unwrap().unwrap();
    assert_eq!(s.last_activity_summarized, last_activity);

    let update = source::MetadataUpdate {
        title: Some("New title".into()),
        summary: Some("Concise summary.".into()),
        status_label: Some("In Progress".into()),
        status_current_activity: Some("Investigating polling cadence.".into()),
    };
    source::write_metadata(project, conversation_id, &update).unwrap();
    let store = ConversationStore::open(&db_path).unwrap();
    let conversation = store.get_conversation(conversation_id).unwrap().unwrap();
    assert_eq!(conversation.title.as_deref(), Some("New title"));
    assert_eq!(conversation.summary.as_deref(), Some("Concise summary."));
    assert_eq!(conversation.status_label.as_deref(), Some("In Progress"));
    let metadata = conversation.metadata;
    assert_eq!(metadata.get("title").unwrap(), "New title");
    assert_eq!(metadata.get("summary").unwrap(), "Concise summary.");
    assert_eq!(metadata.get("statusLabel").unwrap(), "In Progress");
    assert_eq!(
        metadata.get("statusCurrentActivity").unwrap(),
        "Investigating polling cadence."
    );
}

fn message(
    record_id: &str,
    author_pubkey: &str,
    role: Option<&str>,
    message_type: &str,
    content: &str,
    sender_principal: Option<serde_json::Value>,
    timestamp: Option<i64>,
) -> NewMessage {
    NewMessage {
        record_id: record_id.to_string(),
        nostr_event_id: None,
        author_pubkey: author_pubkey.to_string(),
        sender_pubkey: None,
        ral: None,
        message_type: message_type.to_string(),
        role: role.map(str::to_string),
        content: content.to_string(),
        timestamp,
        targeted_pubkeys: None,
        sender_principal,
        targeted_principals: None,
        tool_data: None,
        delegation_marker: None,
        human_readable: None,
        transcript_tool_attributes: None,
    }
}

//! End-to-end happy-path: build a fixture `~/.tenex/projects/<dTag>/` layout
//! that mirrors a real host, point `TENEX_BASE_DIR` at it, and verify the
//! daemon's read path picks up the project, lists the candidate, fetches the
//! transcript, and serializes the metadata writeback. The LLM call is the
//! next step after `fetch_content` in `process_inner`; this test stops at
//! the LLM boundary, since rig-core's provider clients are out of scope.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::json;
use tempfile::tempdir;
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
    fs::create_dir_all(project_dir.join("conversations")).unwrap();

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

    let catalog_path = project_dir.join("conversation-catalog.db");
    init_catalog(&catalog_path, conversation_id, last_activity);

    let conv_path = project_dir
        .join("conversations")
        .join(format!("{conversation_id}.json"));
    let conv_json = json!({
        "messages": [
            {
                "messageType": "text",
                "content": "How does the summarizer work?",
                "senderPubkey": pubkey,
                "senderPrincipal": { "displayName": "Pablo" },
            },
            {
                "messageType": "text",
                "role": "system",
                "content": "It polls every five seconds.",
            },
            {
                "messageType": "tool-call",
                "content": "ignored",
            },
        ],
        "metadata": { "title": "old title" },
    });
    fs::write(&conv_path, serde_json::to_vec_pretty(&conv_json).unwrap()).unwrap();

    let projects = source::discover_projects().unwrap();
    assert_eq!(projects.len(), 1);
    let project = &projects[0];
    assert_eq!(project.d_tag, d_tag);

    let project_event = source::load_project_event(project).unwrap();
    assert_eq!(project_event.pubkey, pubkey);
    assert_eq!(project_event.d_tag, d_tag);
    assert_eq!(project_event.tag_id(), format!("31933:{pubkey}:{d_tag}"));

    let candidates = source::list_candidates(project, 10).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].conversation_id, conversation_id);
    assert_eq!(candidates[0].last_activity, last_activity);

    let content = source::fetch_content(project, &project_event, conversation_id)
        .unwrap()
        .unwrap();
    assert!(content.transcript.contains("Pablo: How does the summarizer work?"));
    assert!(content.transcript.contains("system: It polls every five seconds."));
    assert!(!content.transcript.contains("ignored"));

    let state_db_path = base.join("summarizer").join("state.db");
    let store = state::SummaryStateStore::open(&state_db_path).unwrap();
    assert!(store.get(conversation_id).unwrap().is_none());
    let now_ms = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()) as i64;
    store.record(conversation_id, last_activity, now_ms).unwrap();
    let s = store.get(conversation_id).unwrap().unwrap();
    assert_eq!(s.last_activity_summarized, last_activity);

    let update = source::MetadataUpdate {
        title: Some("New title".into()),
        summary: Some("Concise summary.".into()),
        status_label: Some("In Progress".into()),
        status_current_activity: Some("Investigating polling cadence.".into()),
    };
    source::write_metadata(project, conversation_id, &update).unwrap();
    let rewritten: serde_json::Value =
        serde_json::from_slice(&fs::read(&conv_path).unwrap()).unwrap();
    let metadata = rewritten.get("metadata").unwrap();
    assert_eq!(metadata.get("title").unwrap(), "New title");
    assert_eq!(metadata.get("summary").unwrap(), "Concise summary.");
    assert_eq!(metadata.get("statusLabel").unwrap(), "In Progress");
    assert_eq!(
        metadata.get("statusCurrentActivity").unwrap(),
        "Investigating polling cadence."
    );
}

fn init_catalog(path: &Path, conversation_id: &str, last_activity: i64) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (
             conversation_id TEXT PRIMARY KEY,
             title TEXT,
             summary TEXT,
             last_user_message TEXT,
             status_label TEXT,
             status_current_activity TEXT,
             created_at INTEGER,
             last_activity INTEGER,
             message_count INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             source_mtime_ms INTEGER NOT NULL,
             source_size_bytes INTEGER NOT NULL
         );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversations
            (conversation_id, title, last_activity, message_count, updated_at, source_mtime_ms, source_size_bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            conversation_id,
            "old title",
            last_activity,
            3i64,
            last_activity * 1000,
            last_activity * 1000,
            1024i64,
        ],
    )
    .unwrap();
}

//! Metadata authority is project-wide for ingest, but per-conversation
//! for publishing: the first project agent p-tagged by the opening
//! message signs kind:513 when that agent is local.

use std::fs;

use serde_json::json;
use tempfile::tempdir;
use tenex_conversations::{ConversationStore, NewMessage};
use tenex_summarizer::authority;

fn write_project_event(base: &std::path::Path, d_tag: &str, p_tags: &[&str]) {
    let project_dir = base.join("projects").join(d_tag);
    fs::create_dir_all(&project_dir).unwrap();
    let mut tags: Vec<Vec<String>> = vec![vec!["d".into(), d_tag.into()]];
    for pk in p_tags {
        tags.push(vec!["p".into(), (*pk).into()]);
    }
    let event = json!({
        "id": "rooteventid",
        "pubkey": "0".repeat(64),
        "kind": 31933,
        "created_at": 1_700_000_000,
        "tags": tags,
        "content": "",
    });
    fs::write(
        project_dir.join("event.json"),
        serde_json::to_vec_pretty(&event).unwrap(),
    )
    .unwrap();
}

fn write_agent(base: &std::path::Path, pubkey: &str, with_nsec: bool) {
    let agents_dir = base.join("agents");
    fs::create_dir_all(&agents_dir).unwrap();
    let body = if with_nsec {
        json!({
            "slug": "agent",
            "name": "Agent",
            "nsec": "nsec125v964gu6u6ncqdkczwjq7pdtu0adj03sjfcm3lsj67ljk7v2hrsr2juay",
        })
    } else {
        json!({
            "slug": "agent",
            "name": "Agent",
        })
    };
    fs::write(
        agents_dir.join(format!("{pubkey}.json")),
        serde_json::to_vec_pretty(&body).unwrap(),
    )
    .unwrap();
}

fn write_conversation(
    base: &std::path::Path,
    d_tag: &str,
    conversation_id: &str,
    targets: &[&str],
) {
    let db_path = base.join("projects").join(d_tag).join("conversation.db");
    let store = ConversationStore::open(&db_path).unwrap();
    store
        .append_message(
            conversation_id,
            &NewMessage {
                record_id: "record:root".into(),
                nostr_event_id: None,
                author_pubkey: "f".repeat(64),
                sender_pubkey: None,
                ral: None,
                message_type: "text".into(),
                role: Some("user".into()),
                content: "Hello".into(),
                timestamp: Some(1_700_000_000),
                targeted_pubkeys: Some(targets.iter().map(|s| (*s).to_string()).collect()),
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

#[test]
fn project_authority_accepts_any_31933_agent_and_marks_local_subset() {
    let tmp = tempdir().unwrap();
    let local = "1".repeat(64);
    let remote = "2".repeat(64);
    write_project_event(tmp.path(), "Project-A", &[&remote, &local]);
    write_agent(tmp.path(), &local, true);

    let authority = authority::project_authority("Project-A", tmp.path())
        .unwrap()
        .unwrap();
    assert!(authority.authorized_pubkeys.contains(&local));
    assert!(authority.authorized_pubkeys.contains(&remote));
    assert!(authority.local_pubkeys.contains(&local));
    assert!(!authority.local_pubkeys.contains(&remote));
}

#[test]
fn conversation_publisher_uses_op_targeted_local_agent_not_project_pm() {
    let tmp = tempdir().unwrap();
    let remote_pm = "1".repeat(64);
    let local_agent = "2".repeat(64);
    let conversation_id = "a".repeat(64);
    write_project_event(tmp.path(), "Project-B", &[&remote_pm, &local_agent]);
    write_agent(tmp.path(), &local_agent, true);
    write_conversation(tmp.path(), "Project-B", &conversation_id, &[&local_agent]);

    let project_ref = tenex_conversations::ProjectRef {
        d_tag: "Project-B".into(),
        root: tmp.path().join("projects").join("Project-B"),
        conversation_db: tmp
            .path()
            .join("projects")
            .join("Project-B")
            .join("conversation.db"),
    };
    assert!(
        authority::conversation_publisher(&project_ref, &conversation_id, tmp.path())
            .unwrap()
            .is_some()
    );
}

#[test]
fn conversation_publisher_skips_remote_or_non_member_op_targets() {
    let tmp = tempdir().unwrap();
    let local = "1".repeat(64);
    let remote = "2".repeat(64);
    let outsider = "3".repeat(64);
    write_project_event(tmp.path(), "Project-C", &[&local, &remote]);
    write_agent(tmp.path(), &local, true);
    write_conversation(tmp.path(), "Project-C", "b", &[&remote]);
    write_conversation(tmp.path(), "Project-C", "c", &[&outsider]);

    let project_ref = tenex_conversations::ProjectRef {
        d_tag: "Project-C".into(),
        root: tmp.path().join("projects").join("Project-C"),
        conversation_db: tmp
            .path()
            .join("projects")
            .join("Project-C")
            .join("conversation.db"),
    };
    assert!(
        authority::conversation_publisher(&project_ref, "b", tmp.path())
            .unwrap()
            .is_none()
    );
    assert!(
        authority::conversation_publisher(&project_ref, "c", tmp.path())
            .unwrap()
            .is_none()
    );
}

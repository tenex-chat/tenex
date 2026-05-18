use super::*;
mod probe;
mod support;

use support::{emit_state, message_count, messages_xml, resolved, seed_db, seed_tool};
use tempfile::TempDir;

#[test]
fn test_conversation_get_tool_creation() {
    let db_path = PathBuf::from("/home/user/.tenex/projects/myproject/conversation.db");
    let base_dir = PathBuf::from("/home/user/.tenex");
    let tool = ConversationGetTool::new(emit_state(), db_path.clone(), base_dir, resolved());
    assert_eq!(tool.db_path, db_path);
}

#[tokio::test]
async fn returns_xml_conversation_for_existing_conversation() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    let cid = "a".repeat(64);
    seed_db(
        &db,
        &cid,
        &[
            (
                "event:1111111111111111111111111111111111111111111111111111111111111111",
                "alice0000aaaa",
                "hello",
                10,
            ),
            (
                "event:2222222222222222222222222222222222222222222222222222222222222222",
                "bob0000bbbb",
                "world",
                12,
            ),
        ],
    );

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: cid,
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");

    assert!(out.starts_with("<conversation"), "got: {out}");
    assert_eq!(message_count(&out), 2);
    let xml = messages_xml(&out);
    assert!(
        xml.contains("<conversation id=\"aaaaaaaaaa\" t0=\"10\">"),
        "got: {xml}"
    );
    assert!(
        xml.contains(
            "<message id=\"1111111111\" author=\"alice0000a\" time=\"+0\">hello</message>"
        ),
        "got: {xml}"
    );
    assert!(
        xml.contains(
            "<message id=\"2222222222\" author=\"bob0000bbb\" time=\"+2\">world</message>"
        ),
        "got: {xml}"
    );
}

#[tokio::test]
async fn resolves_unique_conversation_prefix() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    let cid = "208825626d1f07c393b944dd6cb82b051128d24b9b65b6c30da6613103b7a23d";
    seed_db(
        &db,
        cid,
        &[("event:abc", "alice0000aaaa", "phantom data", 0)],
    );

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: "208825626d1f07c393".to_string(),
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");

    let xml = messages_xml(&out);
    assert!(
        xml.contains("<conversation id=\"208825626d\" t0=\"0\">"),
        "got: {xml}"
    );
    assert!(xml.contains("phantom data"));
}

#[tokio::test]
async fn rejects_ambiguous_conversation_prefix() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    seed_db(
        &db,
        "eeeeeeee11111111111111111111111111111111111111111111111111111111",
        &[("rec1", "alice0000aaaa", "first", 0)],
    );
    seed_db(
        &db,
        "eeeeeeee22222222222222222222222222222222222222222222222222222222",
        &[("rec1", "alice0000aaaa", "second", 0)],
    );

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let err = tool
        .call(ConversationGetArgs {
            conversation_id: "eeeeeeee".to_string(),
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect_err("ambiguous prefix should fail");

    assert!(err.to_string().contains("ambiguous"), "got: {err}");
}

#[tokio::test]
async fn reports_missing_conversation_as_xml() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    ConversationStore::open(&db).unwrap();

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: "f".repeat(64),
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");

    assert!(
        out.contains("<conversation id=\"ffffffffff\" t0=\"0\" found=\"false\"></conversation>"),
        "got: {out}"
    );
}

#[tokio::test]
async fn until_id_includes_matching_message() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    let cid = "b".repeat(64);
    seed_db(
        &db,
        &cid,
        &[
            ("rec1", "alice0000", "first", 0),
            ("rec2", "alice0000", "second", 1),
            ("rec3", "alice0000", "third", 2),
        ],
    );

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: cid,
            description: "test".to_string(),
            limit: None,
            until_id: Some("rec2".to_string()),
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");

    let xml = messages_xml(&out);
    assert_eq!(message_count(&out), 2);
    assert!(xml.contains("first"));
    assert!(xml.contains("second"));
    assert!(!xml.contains("third"));
}

#[tokio::test]
async fn include_tool_calls_controls_tool_xml() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    let cid = "c".repeat(64);
    seed_db(
        &db,
        &cid,
        &[
            ("rec1", "user0000aa", "before", 1_700_000_000),
            ("rec2", "agent0000bb", "after", 1_700_000_004),
        ],
    );
    seed_tool(&db, &cid, 1_700_000_003_000);

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let without_tools = tool
        .call(ConversationGetArgs {
            conversation_id: cid.clone(),
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");
    assert!(!messages_xml(&without_tools).contains("<tool"));

    let with_tools = tool
        .call(ConversationGetArgs {
            conversation_id: cid,
            description: "test".to_string(),
            limit: None,
            until_id: None,
            prompt: None,
            include_tool_calls: true,
        })
        .await
        .expect("tool call should succeed");
    let xml = messages_xml(&with_tools);
    assert!(xml.contains("<tool id=\"toolcall12\" user=\"agent0000a\" name=\"conversation_get\" description=\"Retrieve full conversation content\" time=\"+3\" />"), "got: {xml}");
    assert!(!xml.contains("hidden result payload"));
}

#[tokio::test]
async fn limit_caps_returned_messages() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("conversation.db");
    let cid = "d".repeat(64);
    seed_db(
        &db,
        &cid,
        &[
            ("rec1", "alice0000", "one", 0),
            ("rec2", "alice0000", "two", 1),
            ("rec3", "alice0000", "three", 2),
        ],
    );

    let tool = ConversationGetTool::new(emit_state(), db, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: cid,
            description: "test".to_string(),
            limit: Some(2),
            until_id: None,
            prompt: None,
            include_tool_calls: false,
        })
        .await
        .expect("tool call should succeed");

    let xml = messages_xml(&out);
    assert_eq!(message_count(&out), 2);
    assert!(xml.contains("one"));
    assert!(xml.contains("two"));
    assert!(!xml.contains("three"));
}

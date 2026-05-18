use super::super::*;
use super::support::{emit_state, resolved};
use tempfile::TempDir;

/// E2E probe against a copy of the live project DB.
///
/// Run with:
///   TENEX_PROBE_DB=$HOME/.tenex/projects/TENEX-ff3ssq/conversation.db \
///   TENEX_PROBE_CID=410a9661ec26252aac23a81a4100052a0a80e659e71d18d2aa4277692f7f63cb \
///   cargo test -p tenex-agent --bins -- conversation_get::tests::probe::probe_real_database --ignored --nocapture
#[tokio::test]
#[ignore]
async fn probe_real_database() {
    let src =
        std::env::var("TENEX_PROBE_DB").expect("set TENEX_PROBE_DB to a conversation.db path");
    let cid = std::env::var("TENEX_PROBE_CID").expect("set TENEX_PROBE_CID to a conversation id");
    let dir = TempDir::new().unwrap();
    let copy = dir.path().join("conversation.db");
    std::fs::copy(&src, &copy).expect("copy db");

    let tool = ConversationGetTool::new(emit_state(), copy, dir.path().to_path_buf(), resolved());
    let out = tool
        .call(ConversationGetArgs {
            conversation_id: cid,
            description: "test".to_string(),
            limit: Some(5),
            until_id: None,
            prompt: None,
            include_tool_calls: true,
        })
        .await
        .expect("tool call should succeed");

    eprintln!("=== probe output ({} bytes) ===\n{}", out.len(), out);
    assert!(
        out.starts_with("<conversation"),
        "expected XML conversation"
    );
}

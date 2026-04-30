use std::path::PathBuf;

use serde_json::{json, Value};

use super::*;

/// Build a `RuntimeStateHandle` whose `db_path` cannot be opened: the parent
/// path component points at a regular file rather than a directory, so
/// `ConversationStore::open` errors with `NotADirectory` on every attempt.
fn unopenable_handle() -> (tempfile::TempDir, RuntimeStateHandle) {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("not-a-directory");
    std::fs::write(&blocker, b"").unwrap();
    let bad_db = blocker.join("conversation.db");
    let handle = RuntimeStateHandle::new(
        bad_db,
        "conv1".to_string(),
        "agent1".to_string(),
        "exec1".to_string(),
    );
    (dir, handle)
}

fn handle(db_path: PathBuf, execution_id: &str) -> RuntimeStateHandle {
    RuntimeStateHandle::new(
        db_path,
        "conv1".to_string(),
        "agent1".to_string(),
        execution_id.to_string(),
    )
}

#[test]
fn driver_claim_is_exclusive_until_released() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("conversation.db");
    let exec1 = handle(db_path.clone(), "exec1");
    let exec2 = handle(db_path, "exec2");
    assert!(exec1.try_acquire_driver_once().unwrap());
    assert!(!exec2.try_acquire_driver_once().unwrap());
    exec1.release_driver();
    assert!(exec2.try_acquire_driver_once().unwrap());
}

#[test]
fn active_tool_reminder_reports_other_execution_only() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("conversation.db");
    let exec1 = handle(db_path.clone(), "exec1");
    let exec2 = handle(db_path, "exec2");
    exec1.start_tool("tool1", "shell", &json!({ "command": "sleep 60" }));
    assert!(exec1.render_active_tools_reminder().is_none());
    let reminder = exec2.render_active_tools_reminder().unwrap();
    assert!(reminder.contains("active-tool-executions"));
    assert!(reminder.contains("shell call tool1"));
    assert!(reminder.contains("sleep 60"));
    exec1.finish_tool("tool1");
    assert!(exec2.render_active_tools_reminder().is_none());
}

#[tokio::test(start_paused = true)]
async fn acquire_driver_returns_error_after_bounded_db_failures() {
    // The handle points at an unopenable DB path: every `try_acquire_driver_once`
    // returns `Err`. With `start_paused = true` the runtime auto-advances time
    // through the exponential backoff sleeps, so the test completes
    // instantly while still exercising the full retry budget.
    let (_keep, handle) = unopenable_handle();
    let result = handle.acquire_driver().await;
    let err = result.expect_err("expected acquire_driver to give up after retry budget exhausted");
    let chain = format!("{err:#}");
    assert!(
        chain.contains("gave up after"),
        "error chain should describe retry exhaustion, got: {chain}"
    );
}

#[test]
fn consumed_messages_are_recorded_by_event_id() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("conversation.db");
    let exec = handle(db_path.clone(), "exec1");
    exec.mark_messages_consumed(&["event1".to_string()]);
    let state = exec.read_state().unwrap();
    let consumed = state
        .get(ROOT_KEY)
        .and_then(|v| v.get(CONSUMED_MESSAGES_KEY))
        .and_then(Value::as_object)
        .unwrap();
    assert!(consumed.contains_key("event1"));
    assert!(exec.consumed_message_ids().contains("event1"));
}

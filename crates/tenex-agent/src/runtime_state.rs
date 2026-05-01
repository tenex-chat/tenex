use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::runtime_state_json::{
    active_tools_object_mut, compact_json, consumed_messages_object_mut, driver_matches,
    root_object_mut, ACTIVE_TOOLS_KEY, CONSUMED_MESSAGES_KEY, DRIVER_KEY, ROOT_KEY,
};
use serde_json::{json, Value};
use tenex_conversations::ConversationStore;
use tokio::time::sleep;

const DRIVER_STALE_AFTER_MS: i64 = 10 * 60 * 1000;
/// Maximum number of consecutive database errors tolerated while trying
/// to acquire the driver lease before giving up. With the exponential
/// backoff below this caps the worst-case wait at ≈31s
/// (1 + 2 + 4 + 8 + 16 = 31s of sleep before the 6th attempt errors out).
const MAX_DRIVER_DB_ATTEMPTS: u32 = 6;
/// Base delay (in ms) for the exponential backoff between database-error
/// retries. Doubled on each successive failure.
const DRIVER_DB_BACKOFF_BASE_MS: u64 = 1_000;

#[derive(Clone)]
pub struct RuntimeStateHandle {
    db_path: PathBuf,
    conversation_id: String,
    agent_pubkey: String,
    execution_id: String,
}

impl RuntimeStateHandle {
    pub fn new(
        db_path: PathBuf,
        conversation_id: String,
        agent_pubkey: String,
        execution_id: String,
    ) -> Self {
        Self {
            db_path,
            conversation_id,
            agent_pubkey,
            execution_id,
        }
    }

    /// Block until this execution holds the runtime driver lease.
    ///
    /// `Ok(false)` from `try_acquire_driver_once` is the cooperative-wait
    /// path (another execution holds it) and is polled indefinitely with a
    /// short interval — that is the design.
    ///
    /// Database-level errors are bounded: each failure backs off with
    /// exponential delay and after `MAX_DRIVER_DB_ATTEMPTS` consecutive
    /// failures the function returns the last error so the caller can
    /// decide how to proceed.
    pub async fn acquire_driver(&self) -> anyhow::Result<()> {
        if std::env::var_os("TENEX_RUNTIME_DRIVER_PREEMPT").is_some() {
            return Ok(());
        }

        let mut db_failures: u32 = 0;
        loop {
            match self.try_acquire_driver_once() {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    db_failures = 0;
                    sleep(Duration::from_millis(100)).await;
                }
                Err(e) => {
                    db_failures += 1;
                    if db_failures >= MAX_DRIVER_DB_ATTEMPTS {
                        return Err(e.context(format!(
                            "acquire_driver: gave up after {MAX_DRIVER_DB_ATTEMPTS} database errors"
                        )));
                    }
                    let backoff_ms =
                        DRIVER_DB_BACKOFF_BASE_MS * 2u64.saturating_pow(db_failures - 1);
                    tracing::warn!(
                        attempt = db_failures,
                        max_attempts = MAX_DRIVER_DB_ATTEMPTS,
                        backoff_ms,
                        error = %e,
                        "acquire_driver: database error, backing off"
                    );
                    sleep(Duration::from_millis(backoff_ms)).await;
                }
            }
        }
    }

    pub fn release_driver(&self) {
        if let Err(e) = self.with_state(|state| {
            if driver_matches(
                state,
                &self.agent_pubkey,
                &self.conversation_id,
                &self.execution_id,
            ) {
                root_object_mut(state).remove(DRIVER_KEY);
            }
        }) {
            eprintln!("[tenex-agent] Failed to release runtime driver: {e}");
        }
    }

    pub fn start_tool(&self, tool_call_id: &str, tool_name: &str, args: &Value) {
        let tool_key = self.tool_key(tool_call_id);
        if let Err(e) = self.with_state(|state| {
            let tools = active_tools_object_mut(state);
            tools.insert(
                tool_key,
                json!({
                    "agentPubkey": self.agent_pubkey,
                    "conversationId": self.conversation_id,
                    "executionId": self.execution_id,
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "args": args,
                    "startedAt": now_ms(),
                }),
            );
        }) {
            eprintln!("[tenex-agent] Failed to record active tool: {e}");
        }
    }

    pub fn finish_tool(&self, tool_call_id: &str) {
        let tool_key = self.tool_key(tool_call_id);
        if let Err(e) = self.with_state(|state| {
            active_tools_object_mut(state).remove(&tool_key);
        }) {
            eprintln!("[tenex-agent] Failed to clear active tool: {e}");
        }
    }

    pub fn render_active_tools_reminder(&self) -> Option<String> {
        let state = self.read_state().ok()?;
        let root = state.get(ROOT_KEY)?.as_object()?;
        let tools = root.get(ACTIVE_TOOLS_KEY)?.as_object()?;
        let mut lines = Vec::new();

        for tool in tools.values() {
            if tool.get("agentPubkey").and_then(Value::as_str) != Some(&self.agent_pubkey) {
                continue;
            }
            if tool.get("conversationId").and_then(Value::as_str) != Some(&self.conversation_id) {
                continue;
            }
            if tool.get("executionId").and_then(Value::as_str) == Some(&self.execution_id) {
                continue;
            }

            let name = tool
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let id = tool
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let started = tool.get("startedAt").and_then(Value::as_i64).unwrap_or(0);
            let args = tool
                .get("args")
                .map(compact_json)
                .unwrap_or_else(|| "{}".to_string());
            lines.push(format!(
                "- {name} call {id} started {age}s ago with args: {args}",
                age = ((now_ms() - started).max(0) / 1000)
            ));
        }

        if lines.is_empty() {
            None
        } else {
            Some(format!(
                "<system-reminder type=\"active-tool-executions\">\nAnother execution of this agent is still waiting on these tool calls in this conversation. Account for them before reporting completion.\n{}\n</system-reminder>",
                lines.join("\n")
            ))
        }
    }

    pub fn mark_messages_consumed(&self, event_ids: &[String]) {
        if event_ids.is_empty() {
            return;
        }
        if let Err(e) = self.with_state(|state| {
            let now = now_ms();
            let consumed = consumed_messages_object_mut(state);
            for event_id in event_ids {
                consumed.insert(
                    event_id.clone(),
                    json!({
                        "agentPubkey": self.agent_pubkey,
                        "conversationId": self.conversation_id,
                        "executionId": self.execution_id,
                        "eventId": event_id,
                        "consumedAt": now,
                    }),
                );
            }
        }) {
            eprintln!("[tenex-agent] Failed to record consumed messages: {e}");
        }
    }

    pub fn consumed_message_ids(&self) -> HashSet<String> {
        self.read_state()
            .ok()
            .and_then(|state| {
                state
                    .get(ROOT_KEY)?
                    .get(CONSUMED_MESSAGES_KEY)?
                    .as_object()
                    .map(|messages| {
                        messages
                            .iter()
                            .filter_map(|(event_id, meta)| {
                                let same_agent = meta.get("agentPubkey").and_then(Value::as_str)
                                    == Some(self.agent_pubkey.as_str());
                                let same_conversation =
                                    meta.get("conversationId").and_then(Value::as_str)
                                        == Some(self.conversation_id.as_str());
                                if same_agent && same_conversation {
                                    Some(event_id.clone())
                                } else {
                                    None
                                }
                            })
                            .collect()
                    })
            })
            .unwrap_or_default()
    }

    fn try_acquire_driver_once(&self) -> anyhow::Result<bool> {
        self.with_state(|state| {
            let now = now_ms();
            let root = root_object_mut(state);
            let driver = root.get(DRIVER_KEY).cloned();
            let can_acquire = driver.as_ref().is_none_or(|d| {
                let same_agent = d.get("agentPubkey").and_then(Value::as_str)
                    == Some(self.agent_pubkey.as_str());
                let same_conversation = d.get("conversationId").and_then(Value::as_str)
                    == Some(self.conversation_id.as_str());
                let same_execution = d.get("executionId").and_then(Value::as_str)
                    == Some(self.execution_id.as_str());
                let stale = d
                    .get("acquiredAt")
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| now.saturating_sub(ts) > DRIVER_STALE_AFTER_MS);
                !same_agent || !same_conversation || same_execution || stale
            });

            if can_acquire {
                root.insert(
                    DRIVER_KEY.to_string(),
                    json!({
                        "agentPubkey": self.agent_pubkey,
                        "conversationId": self.conversation_id,
                        "executionId": self.execution_id,
                        "acquiredAt": now,
                    }),
                );
                true
            } else {
                false
            }
        })
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut Value) -> T) -> anyhow::Result<T> {
        let mut store = ConversationStore::open(&self.db_path)?;
        Ok(store.update_runtime_state(&self.conversation_id, f)?)
    }

    fn read_state(&self) -> anyhow::Result<Value> {
        let store = ConversationStore::open(&self.db_path)?;
        Ok(store
            .get_conversation(&self.conversation_id)?
            .map(|row| row.runtime_state)
            .unwrap_or_else(|| json!({})))
    }

    fn tool_key(&self, tool_call_id: &str) -> String {
        format!("{}:{tool_call_id}", self.execution_id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "runtime_state_tests.rs"]
mod tests;

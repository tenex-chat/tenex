//! Projection: history → `Vec<Message>`.
//!
//! Reads materialized messages and tool messages from storage, then
//! converts them into the role-tagged [`Message`] enum the strategy
//! pipeline operates on. The system prompt is injected at index 0.
//!
//! Tool messages pair with their originating assistant via
//! `tool_messages.parent_message_id`, which references `messages.id`. The
//! step loop sets this on every tool message it persists, and projection
//! uses it to reconstruct the `tool_use` → `tool_result` pairing providers
//! require. Tool messages without a parent are dropped — projection has no
//! way to position them, and emitting an orphan `tool_result` is a 400
//! from the provider.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use tenex_conversations::{ConversationStore, MessageQuery, MessageRecord, ToolMessage};

use crate::types::{ImageAttachment, Message, ToolCall};

fn drain_tools_for_parent(
    by_parent: &mut HashMap<i64, Vec<ToolMessage>>,
    parent_id: i64,
) -> Vec<ToolMessage> {
    by_parent.remove(&parent_id).unwrap_or_default()
}

/// Resolve a Nostr pubkey to a human-readable display name.
///
/// Used by [`project_messages`] to prefix user messages with `[name]`
/// when a conversation has user-role messages from more than one
/// distinct author. Implementations are typically thin wrappers around
/// the host's `tenex-identity` Unix socket.
pub trait DisplayNameResolver: Send + Sync {
    fn display_name(&self, pubkey: &str) -> Option<String>;
}

/// Build the initial message vector from storage. Index 0 is always the
/// system prompt.
///
/// The conversation store is the single source of truth: every message
/// the LLM sees corresponds to either a row in `messages` (or its
/// `tool_messages` siblings) or to an overlay produced by a downstream
/// projection strategy (reminders, proactive context, active-tool
/// pending pairs). No in-memory splicing, no exclusion filter — the
/// trigger event row is just another row.
pub(crate) fn project_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    name_resolver: Option<&dyn DisplayNameResolver>,
) -> anyhow::Result<Vec<Message>> {
    let history: Vec<MessageRecord> =
        store.list_messages(conversation_id, MessageQuery::default())?;
    // Attribution: when more than one distinct pubkey has authored a
    // user-role message in this conversation, prefix each user message
    // with `[name]` so the agent can disambiguate authors. Single-author
    // conversations stay un-prefixed to keep simple cases clean.
    let user_author_set: HashSet<&str> = history
        .iter()
        .filter(|r| r.role.as_deref() == Some("user"))
        .map(|r| r.author_pubkey.as_str())
        .collect();
    let attribute_users = user_author_set.len() > 1 && name_resolver.is_some();
    let mut name_cache: HashMap<String, String> = HashMap::new();
    // Only include tool messages owned by *this* agent. Conversations
    // can host multiple agents; splicing another agent's tool calls
    // into this projection would emit unmatched `tool_use` blocks.
    //
    // Tool messages must carry `parent_message_id` (set by the step
    // loop's `record_step_tool_messages`) so we can pair them with the
    // assistant row that emitted them. Rows without a parent have no
    // home in the prompt and are dropped — emitting an orphan
    // `tool_result` triggers a 400 from the provider.
    let mut tools_by_parent: HashMap<i64, Vec<ToolMessage>> = HashMap::new();
    let mut completed_tool_ids: HashSet<String> = HashSet::new();
    for tool in store
        .list_tool_messages(conversation_id)?
        .into_iter()
        .filter(|t| t.agent_pubkey == agent_pubkey)
        // Drop in-flight tool calls (no result yet); they have no
        // `ToolResult` to emit, and their `tool_use` would be orphaned.
        .filter(|t| t.result_output.is_some())
    {
        let Some(parent_id) = tool.parent_message_id else {
            tracing::debug!(
                tool_call_id = %tool.tool_call_id,
                tool_name = %tool.tool_name,
                "dropping unparented tool message from projection"
            );
            continue;
        };
        completed_tool_ids.insert(tool.tool_call_id.clone());
        tools_by_parent.entry(parent_id).or_default().push(tool);
    }
    // Preserve per-parent emission order by id (i.e. insertion order in
    // `tool_messages`), so a step's calls appear in the same sequence
    // the step loop issued them.
    for tools in tools_by_parent.values_mut() {
        tools.sort_by_key(|t| t.id);
    }
    let mut active_tools =
        load_active_tools(store, conversation_id, agent_pubkey, &completed_tool_ids)?;

    let estimated_tool_count: usize = tools_by_parent.values().map(Vec::len).sum();
    let mut out = Vec::with_capacity(history.len() + estimated_tool_count + active_tools.len() * 2 + 1);
    out.push(Message::System {
        content: system_prompt.to_string(),
    });

    // Bulk-load image attachments for user-role rows. The sidecar table
    // `message_attachments` is the single source of truth for trigger-event
    // image content; loading them here lets every step's projection see them
    // without re-fetching from the network.
    let user_row_ids: Vec<i64> = history
        .iter()
        .filter(|r| r.role.as_deref() == Some("user"))
        .map(|r| r.id)
        .collect();
    let mut attachments_by_message: HashMap<i64, Vec<ImageAttachment>> = store
        .list_attachments_by_message_ids(&user_row_ids)?
        .into_iter()
        .map(|(msg_id, records)| {
            (
                msg_id,
                records
                    .into_iter()
                    .map(|rec| ImageAttachment {
                        media_type: rec.media_type,
                        data: rec.data,
                        source_url: rec.source_url,
                    })
                    .collect(),
            )
        })
        .collect();

    // Pre-compute the latest delegation marker per
    // `delegation_conversation_id` so we only surface the final
    // state to projection. Each state transition appends a fresh
    // row, so the highest-sequence row wins. We also identify
    // which messages.id values correspond to those latest rows so
    // we can skip older marker rows in the iteration below.
    let mut latest_marker_row_id_per_delegation: HashMap<String, i64> = HashMap::new();
    for record in &history {
        if record.message_type != "delegation-marker" {
            continue;
        }
        let Some(raw) = record.delegation_marker.as_ref() else {
            continue;
        };
        let Ok(marker) =
            serde_json::from_value::<tenex_conversations::DelegationMarker>(raw.clone())
        else {
            continue;
        };
        latest_marker_row_id_per_delegation.insert(
            marker.delegation_conversation_id.clone(),
            record.id,
        );
    }
    let latest_marker_row_ids: HashSet<i64> = latest_marker_row_id_per_delegation
        .values()
        .copied()
        .collect();

    for (idx, record) in history.iter().enumerate() {
        let Some(role) = record.role.as_deref() else {
            anyhow::bail!(
                "message record {} in conversation {} has no role",
                record.id,
                conversation_id
            );
        };

        // Delegation markers: only the latest row per delegation surfaces,
        // and it emits as the `Message::DelegationMarker` variant for the
        // `ExpandDelegationMarkersStrategy` to render. Older rows of the
        // same delegation are silently dropped — they're just lifecycle
        // history, not what the model should see.
        if record.message_type == "delegation-marker" {
            if !latest_marker_row_ids.contains(&record.id) {
                continue;
            }
            let Some(raw) = record.delegation_marker.as_ref() else {
                continue;
            };
            let marker = match serde_json::from_value::<tenex_conversations::DelegationMarker>(
                raw.clone(),
            ) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        record_id = %record.record_id,
                        "malformed delegation_marker payload; skipping"
                    );
                    continue;
                }
            };
            out.push(Message::DelegationMarker {
                marker,
                ral_number: record.ral,
            });
            let next_record_ts = next_record_timestamp_ms(&history, idx);
            push_active_tools_before(&mut out, &mut active_tools, next_record_ts);
            continue;
        }

        match role {
            "system" => out.push(Message::System {
                content: record.content.clone(),
            }),
            "user" => {
                let content = if attribute_users {
                    let name = name_cache
                        .entry(record.author_pubkey.clone())
                        .or_insert_with(|| {
                            name_resolver
                                .and_then(|r| r.display_name(&record.author_pubkey))
                                .unwrap_or_else(|| tenex_utils::pubkey::shorten_for_display(&record.author_pubkey))
                        })
                        .clone();
                    format!("[{name}] {}", record.content)
                } else {
                    record.content.clone()
                };
                let attachments = attachments_by_message.remove(&record.id).unwrap_or_default();
                out.push(Message::User {
                    content,
                    attachments,
                });
            }
            "assistant" => {
                let paired = drain_tools_for_parent(&mut tools_by_parent, record.id);
                let tool_calls: Vec<ToolCall> = paired
                    .iter()
                    .map(|t| ToolCall {
                        id: t.tool_call_id.clone(),
                        provider_call_id: None,
                        name: t.tool_name.clone(),
                        arguments: t.call_input.clone(),
                    })
                    .collect();

                out.push(Message::Assistant {
                    content: record.content.clone(),
                    reasoning: Vec::new(),
                    tool_calls,
                });
                for tool in paired {
                    push_tool_result(&mut out, tool);
                }
            }
            other => anyhow::bail!(
                "message record {} in conversation {} has unknown role {:?}",
                record.id,
                conversation_id,
                other
            ),
        }

        let next_record_ts = next_record_timestamp_ms(&history, idx);
        push_active_tools_before(&mut out, &mut active_tools, next_record_ts);
    }

    // Any tools still in `tools_by_parent` reference assistant rows that
    // haven't appeared in `messages` yet (race with materialization, or
    // the parent was filtered out by `excluded_event_id`). Dropping them
    // is correct: emitting orphan `tool_result`s is a 400 from the
    // provider, and they'll re-slot on the next projection once the
    // parent assistant row lands.
    drop(tools_by_parent);
    push_active_tools_before(&mut out, &mut active_tools, i64::MAX);

    Ok(out)
}

#[derive(Debug, Clone)]
struct ActiveTool {
    tool_call_id: String,
    tool_name: String,
    args: Value,
    started_at_ms: i64,
}

fn load_active_tools(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    completed_tool_ids: &HashSet<String>,
) -> anyhow::Result<VecDeque<ActiveTool>> {
    let Some(conversation) = store.get_conversation(conversation_id)? else {
        return Ok(VecDeque::new());
    };
    let Some(tools) = conversation
        .runtime_state
        .get("rustRuntime")
        .and_then(|root| root.get("activeTools"))
        .and_then(Value::as_object)
    else {
        return Ok(VecDeque::new());
    };

    let mut active = tools
        .values()
        .filter_map(|tool| active_tool(tool, conversation_id, agent_pubkey, completed_tool_ids))
        .collect::<Vec<_>>();
    active.sort_by_key(|tool| tool.started_at_ms);
    Ok(active.into())
}

fn active_tool(
    tool: &Value,
    conversation_id: &str,
    agent_pubkey: &str,
    completed_tool_ids: &HashSet<String>,
) -> Option<ActiveTool> {
    if tool.get("agentPubkey").and_then(Value::as_str) != Some(agent_pubkey) {
        return None;
    }
    if tool.get("conversationId").and_then(Value::as_str) != Some(conversation_id) {
        return None;
    }

    let tool_call_id = tool.get("toolCallId")?.as_str()?.to_string();
    if completed_tool_ids.contains(&tool_call_id) {
        return None;
    }
    let tool_name = tool.get("toolName")?.as_str()?.to_string();
    let args = tool
        .get("args")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let started_at_ms = timestamp_value_ms(tool.get("startedAt")?.as_i64()?);
    Some(ActiveTool {
        tool_call_id,
        tool_name,
        args,
        started_at_ms,
    })
}

fn push_active_tools_before(
    out: &mut Vec<Message>,
    active_tools: &mut VecDeque<ActiveTool>,
    before_ms: i64,
) {
    while active_tools
        .front()
        .is_some_and(|tool| tool.started_at_ms < before_ms)
    {
        let Some(tool) = active_tools.pop_front() else {
            break;
        };
        push_active_tool(out, tool);
    }
}

fn push_active_tool(out: &mut Vec<Message>, tool: ActiveTool) {
    let content = pending_tool_result_content(&tool);
    out.push(Message::Assistant {
        content: String::new(),
        reasoning: Vec::new(),
        tool_calls: vec![ToolCall {
            id: tool.tool_call_id.clone(),
            provider_call_id: None,
            name: tool.tool_name.clone(),
            arguments: tool.args.clone(),
        }],
    });
    out.push(Message::ToolResult {
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
        content,
        provider_call_id: None,
        is_error: false,
    });
}

fn pending_tool_result_content(tool: &ActiveTool) -> String {
    format!(
        "<system-reminder type=\"pending-tool-result\">\nTool call {} ({}) is still running.\nArguments: {}\nDo not repeat this same tool call just because its final result is not available yet. Account for this pending execution before deciding the next action.\n</system-reminder>",
        tool.tool_call_id,
        tool.tool_name,
        compact_json(&tool.args),
    )
}

fn next_record_timestamp_ms(history: &[MessageRecord], idx: usize) -> i64 {
    history
        .get(idx + 1)
        .and_then(|record| timestamp_ms(record.timestamp))
        .unwrap_or(i64::MAX)
}

fn timestamp_ms(timestamp: Option<i64>) -> Option<i64> {
    timestamp.map(timestamp_value_ms)
}

fn timestamp_value_ms(timestamp: i64) -> i64 {
    if timestamp.abs() < 10_000_000_000 {
        timestamp.saturating_mul(1000)
    } else {
        timestamp
    }
}

fn compact_json(value: &Value) -> String {
    let raw = value.to_string();
    const MAX: usize = 500;
    if raw.len() <= MAX {
        return raw;
    }
    // `&raw[..MAX]` would panic if byte index `MAX` lands inside a
    // multi-byte UTF-8 character. Walk backward to the nearest char
    // boundary (at most 3 bytes for valid UTF-8) so this stays safe
    // regardless of what Unicode the JSON value carries.
    let mut end = MAX;
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &raw[..end])
}

fn push_tool_result(out: &mut Vec<Message>, tool: ToolMessage) {
    let content = match tool.result_output {
        Some(serde_json::Value::String(s)) => s,
        Some(other) => other.to_string(),
        None => String::new(),
    };
    out.push(Message::ToolResult {
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
        content,
        provider_call_id: None,
        is_error: tool.is_error,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_json_passes_through_short_value() {
        let v = json!({"k": "v"});
        let out = compact_json(&v);
        assert_eq!(out, r#"{"k":"v"}"#);
    }

    #[test]
    fn compact_json_truncates_long_value_with_ellipsis() {
        let long = "a".repeat(1000);
        let v = json!({"x": long});
        let out = compact_json(&v);
        assert!(out.ends_with("..."));
        // 500 bytes plus the 3-char ellipsis (max).
        assert!(out.len() <= 503);
    }

    #[test]
    fn compact_json_does_not_panic_when_byte_500_is_mid_multibyte() {
        // Regression: compact_json sliced `raw[..500]` by byte index. If
        // the JSON serialization happens to put a multi-byte UTF-8
        // character across byte 500, the slice would panic with "byte
        // index 500 is not a char boundary". Tool args are arbitrary
        // user/agent input — easy to hit with realistic Unicode content.
        //
        // Build a JSON object whose `to_string()` puts a 4-byte emoji
        // straddling byte 500. JSON quoting adds 8 bytes of overhead
        // (`{"a":"..."}`), so 491 ASCII bytes + emoji = 491 + 4 = 495
        // payload bytes; with the 8-byte JSON wrapper the emoji's
        // bytes land at indices 499..503 of the serialized form,
        // bracketing byte 500.
        let mut payload = String::new();
        payload.push_str(&"a".repeat(491));
        payload.push('😀'); // 4 UTF-8 bytes
        payload.push_str(&"b".repeat(100));
        let v = json!({ "a": payload });
        let serialized = v.to_string();
        // Sanity-check that the test actually exercises the boundary —
        // if the JSON encoding ever changes, the assertion below will
        // catch it.
        assert!(
            serialized.len() > 500,
            "test setup must produce >500 bytes"
        );
        assert!(
            !serialized.is_char_boundary(500),
            "test setup must straddle byte 500 with a multi-byte char"
        );

        // Must not panic.
        let out = compact_json(&v);
        assert!(out.ends_with("..."));
    }
}

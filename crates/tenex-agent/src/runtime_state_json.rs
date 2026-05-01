use serde_json::{json, Map, Value};

pub const ROOT_KEY: &str = "rustRuntime";
pub const DRIVER_KEY: &str = "driver";
pub const ACTIVE_TOOLS_KEY: &str = "activeTools";
pub const CONSUMED_MESSAGES_KEY: &str = "consumedMessages";

/// Replace `slot` with an empty JSON object if it is anything else,
/// then return a mutable reference to its `Map`. The match arm cannot fail
/// because we just normalized the value to `Value::Object` on the line above.
fn ensure_object(slot: &mut Value) -> &mut Map<String, Value> {
    if !slot.is_object() {
        *slot = json!({});
    }
    let Value::Object(map) = slot else {
        unreachable!("value was just normalized to Value::Object")
    };
    map
}

pub fn root_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    let root = ensure_object(state)
        .entry(ROOT_KEY.to_string())
        .or_insert_with(|| json!({}));
    ensure_object(root)
}

pub fn active_tools_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    let tools = root_object_mut(state)
        .entry(ACTIVE_TOOLS_KEY.to_string())
        .or_insert_with(|| json!({}));
    ensure_object(tools)
}

pub fn consumed_messages_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    let consumed = root_object_mut(state)
        .entry(CONSUMED_MESSAGES_KEY.to_string())
        .or_insert_with(|| json!({}));
    ensure_object(consumed)
}

pub fn driver_matches(
    state: &Value,
    agent_pubkey: &str,
    conversation_id: &str,
    execution_id: &str,
) -> bool {
    state
        .get(ROOT_KEY)
        .and_then(|v| v.get(DRIVER_KEY))
        .is_some_and(|d| {
            d.get("agentPubkey").and_then(Value::as_str) == Some(agent_pubkey)
                && d.get("conversationId").and_then(Value::as_str) == Some(conversation_id)
                && d.get("executionId").and_then(Value::as_str) == Some(execution_id)
        })
}

pub fn compact_json(value: &Value) -> String {
    let raw = value.to_string();
    const MAX: usize = 500;
    if raw.len() <= MAX {
        raw
    } else {
        format!("{}...", &raw[..MAX])
    }
}

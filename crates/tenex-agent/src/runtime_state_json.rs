use serde_json::{json, Map, Value};

pub const ROOT_KEY: &str = "rustRuntime";
pub const DRIVER_KEY: &str = "driver";
pub const ACTIVE_TOOLS_KEY: &str = "activeTools";
pub const CONSUMED_MESSAGES_KEY: &str = "consumedMessages";

pub fn root_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = json!({});
    }
    let root = state
        .as_object_mut()
        .expect("state was normalized to object")
        .entry(ROOT_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !root.is_object() {
        *root = json!({});
    }
    root.as_object_mut()
        .expect("runtime root was normalized to object")
}

pub fn active_tools_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    let root = root_object_mut(state);
    let tools = root
        .entry(ACTIVE_TOOLS_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !tools.is_object() {
        *tools = json!({});
    }
    tools
        .as_object_mut()
        .expect("active tools was normalized to object")
}

pub fn consumed_messages_object_mut(state: &mut Value) -> &mut Map<String, Value> {
    let root = root_object_mut(state);
    let consumed = root
        .entry(CONSUMED_MESSAGES_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !consumed.is_object() {
        *consumed = json!({});
    }
    consumed
        .as_object_mut()
        .expect("consumed messages was normalized to object")
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

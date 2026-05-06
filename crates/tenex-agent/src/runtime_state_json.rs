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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_json_passes_through_short_value() {
        let v = json!({"k": "v"});
        assert_eq!(compact_json(&v), r#"{"k":"v"}"#);
    }

    #[test]
    fn compact_json_truncates_long_value_with_ellipsis() {
        let v = json!({"x": "a".repeat(1000)});
        let out = compact_json(&v);
        assert!(out.ends_with("..."));
        assert!(out.len() <= 503);
    }

    #[test]
    fn compact_json_does_not_panic_when_byte_500_is_mid_multibyte() {
        // Regression: `&raw[..500]` panics when byte 500 lands inside a
        // multi-byte UTF-8 character. `compact_json` renders tool-call
        // args (arbitrary agent input) into a system reminder shown to
        // the agent, so realistic Unicode payloads can hit this.
        let mut payload = String::new();
        payload.push_str(&"a".repeat(491));
        payload.push('😀'); // 4 UTF-8 bytes
        payload.push_str(&"b".repeat(100));
        let v = json!({ "a": payload });
        let serialized = v.to_string();
        assert!(serialized.len() > 500);
        assert!(
            !serialized.is_char_boundary(500),
            "test setup must straddle byte 500"
        );
        let out = compact_json(&v);
        assert!(out.ends_with("..."));
    }
}

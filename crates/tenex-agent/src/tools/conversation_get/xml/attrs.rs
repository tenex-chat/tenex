use serde_json::Value;

const MAX_TOOL_DESCRIPTION_LENGTH: usize = 150;
const MAX_TOOL_INPUT_JSON_LENGTH: usize = 200;

pub fn build_tool_attrs(
    tool_name: &str,
    input: &Value,
    transcript_attrs: Option<&Value>,
) -> Vec<(String, String)> {
    let mut attrs = Vec::<(String, String)>::new();
    if let Some(object) = transcript_attrs.and_then(Value::as_object) {
        for (key, value) in object {
            push_attr(&mut attrs, key, value_to_attr(value));
        }
    }

    if let Some(description) = input.get("description").and_then(Value::as_str) {
        push_attr(
            &mut attrs,
            "description",
            truncate_with_suffix(description, MAX_TOOL_DESCRIPTION_LENGTH),
        );
    }

    for (key, attr) in [
        ("path", "file_path"),
        ("pattern", "pattern"),
        ("query", "query"),
        ("glob", "glob"),
        ("file_path", "file_path"),
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            push_attr(&mut attrs, attr, value.to_string());
        }
    }

    if tool_name.starts_with("mcp_") && !has_attr(&attrs, "args") {
        push_attr(
            &mut attrs,
            "args",
            truncate_with_suffix(&safe_stringify(input), MAX_TOOL_INPUT_JSON_LENGTH),
        );
    }

    attrs
}

fn push_attr(attrs: &mut Vec<(String, String)>, key: &str, value: String) {
    if !has_attr(attrs, key) && !value.is_empty() {
        attrs.push((key.to_string(), value));
    }
}

fn has_attr(attrs: &[(String, String)], key: &str) -> bool {
    attrs.iter().any(|(existing, _)| existing == key)
}

fn value_to_attr(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| safe_stringify(value))
}

fn safe_stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[Unserializable]".to_string())
}

fn truncate_with_suffix(value: &str, max_length: usize) -> String {
    if value.chars().count() <= max_length {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_length).collect();
    let truncated_chars = value.chars().count().saturating_sub(max_length);
    format!("{truncated}... [truncated {truncated_chars} chars]")
}

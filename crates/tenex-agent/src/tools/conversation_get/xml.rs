mod attrs;
mod display;
mod ids;

use attrs::build_tool_attrs;
use display::{
    display_author, format_delegation_marker, message_author_pubkey, recipients_for_message,
};
use ids::{
    escape_xml, event_id_for_message, get_string, id_matches, is_full_hex_id, message_matches,
    message_timestamp_seconds, normalize_lookup_id, short_id, tool_timestamp_seconds, ShortIds,
};
use serde_json::Value;
use tenex_conversations::{MessageRecord, ToolMessage};

enum TimelineItem<'a> {
    Message(&'a MessageRecord),
    Tool(&'a ToolMessage),
}

struct TimelineEntry<'a> {
    item: TimelineItem<'a>,
    timestamp: Option<i64>,
    order: usize,
}

pub fn render_conversation_xml(
    conversation_id: &str,
    messages: &[MessageRecord],
    tool_messages: &[ToolMessage],
    include_tool_calls: bool,
) -> String {
    let mut entries = timeline_entries(messages, tool_messages, include_tool_calls);
    let t0 = entries
        .iter()
        .filter_map(|entry| entry.timestamp)
        .min()
        .unwrap_or(0);

    entries.sort_by(|left, right| {
        left.timestamp
            .unwrap_or(t0)
            .cmp(&right.timestamp.unwrap_or(t0))
            .then(left.order.cmp(&right.order))
    });

    let mut short_ids = ShortIds::new();
    let root_id = short_ids.get_or_create(conversation_id);
    let mut lines = vec![format!(
        "<conversation id=\"{}\" t0=\"{}\">",
        escape_xml(&root_id),
        t0
    )];

    let mut last_known_timestamp = t0;
    for entry in entries {
        let effective_timestamp = entry.timestamp.unwrap_or(last_known_timestamp);
        if let Some(timestamp) = entry.timestamp {
            last_known_timestamp = timestamp;
        }
        let relative = effective_timestamp.saturating_sub(t0);
        match entry.item {
            TimelineItem::Message(message) => {
                if let Some(line) = render_message(message, relative, &mut short_ids) {
                    lines.push(line);
                }
            }
            TimelineItem::Tool(tool) => {
                lines.push(render_tool(
                    &tool.tool_call_id,
                    &tool.agent_pubkey,
                    &tool.tool_name,
                    &tool.call_input,
                    None,
                    relative,
                    &mut short_ids,
                ));
            }
        }
    }

    lines.push("</conversation>".to_string());
    lines.join("\n")
}

pub fn render_missing_conversation_xml(conversation_id: &str) -> String {
    format!(
        "<conversation id=\"{}\" t0=\"0\" found=\"false\"></conversation>",
        escape_xml(&short_id(conversation_id))
    )
}

pub fn truncate_until(
    messages: &mut Vec<MessageRecord>,
    tool_messages: &mut Vec<ToolMessage>,
    until_id: &str,
) {
    let needle = normalize_lookup_id(until_id);
    if let Some(idx) = messages
        .iter()
        .position(|message| message_matches(message, &needle))
    {
        let bound = message_timestamp_seconds(&messages[idx]);
        messages.truncate(idx + 1);
        if let Some(bound) = bound {
            tool_messages.retain(|tool| tool_timestamp_seconds(tool).is_some_and(|ts| ts <= bound));
        }
        return;
    }

    if let Some(idx) = tool_messages
        .iter()
        .position(|tool| id_matches(&tool.tool_call_id, &needle))
    {
        let bound = tool_timestamp_seconds(&tool_messages[idx]);
        tool_messages.truncate(idx + 1);
        if let Some(bound) = bound {
            messages
                .retain(|message| message_timestamp_seconds(message).is_some_and(|ts| ts <= bound));
        }
    }
}

pub fn truncate_message_limit(
    messages: &mut Vec<MessageRecord>,
    tool_messages: &mut Vec<ToolMessage>,
    limit: usize,
) {
    if limit == 0 {
        messages.clear();
        tool_messages.clear();
        return;
    }
    if messages.len() <= limit {
        return;
    }
    let bound = messages
        .get(limit.saturating_sub(1))
        .and_then(message_timestamp_seconds);
    messages.truncate(limit);
    if let Some(bound) = bound {
        tool_messages.retain(|tool| tool_timestamp_seconds(tool).is_some_and(|ts| ts <= bound));
    }
}

fn timeline_entries<'a>(
    messages: &'a [MessageRecord],
    tool_messages: &'a [ToolMessage],
    include_tool_calls: bool,
) -> Vec<TimelineEntry<'a>> {
    let mut entries = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message.message_type == "tool-result" {
            continue;
        }
        if message.message_type == "tool-call" && !include_tool_calls {
            continue;
        }
        entries.push(TimelineEntry {
            item: TimelineItem::Message(message),
            timestamp: message_timestamp_seconds(message),
            order: index,
        });
    }

    if include_tool_calls {
        let offset = entries.len();
        for (index, tool) in tool_messages.iter().enumerate() {
            entries.push(TimelineEntry {
                item: TimelineItem::Tool(tool),
                timestamp: tool_timestamp_seconds(tool),
                order: offset + index,
            });
        }
    }

    entries
}

fn render_message(
    message: &MessageRecord,
    relative: i64,
    short_ids: &mut ShortIds,
) -> Option<String> {
    if message.message_type == "tool-call" {
        let part = extract_message_tool_part(message)?;
        let event_id = event_id_for_message(message);
        let transcript_attrs = message.transcript_tool_attributes.as_ref();
        return Some(render_tool(
            event_id.as_deref().unwrap_or(&part.tool_call_id),
            &message_author_pubkey(message),
            &part.tool_name,
            &part.input,
            transcript_attrs,
            relative,
            short_ids,
        ));
    }

    let message_text = if message.message_type == "delegation-marker" {
        format_delegation_marker(message)?
    } else if message.content.is_empty() {
        "(empty)".to_string()
    } else {
        message.content.clone()
    };

    let id_attr = event_id_for_message(message)
        .map(|event_id| {
            format!(
                " id=\"{}\"",
                escape_xml(&short_ids.get_or_create(&event_id))
            )
        })
        .unwrap_or_default();
    let recipient_attr = recipients_for_message(message)
        .filter(|recipients| !recipients.is_empty())
        .map(|recipients| format!(" recipient=\"{}\"", escape_xml(&recipients.join(", "))))
        .unwrap_or_default();
    Some(format!(
        "  <message{} author=\"{}\"{} time=\"+{}\">{}</message>",
        id_attr,
        escape_xml(&display_author(message)),
        recipient_attr,
        relative,
        escape_xml(&message_text)
    ))
}

fn render_tool(
    candidate_id: &str,
    author_pubkey: &str,
    tool_name: &str,
    input: &Value,
    transcript_attrs: Option<&Value>,
    relative: i64,
    short_ids: &mut ShortIds,
) -> String {
    let tool_id = if is_full_hex_id(candidate_id) {
        candidate_id.to_string()
    } else {
        short_ids.get_or_create(candidate_id)
    };
    let attrs = build_tool_attrs(tool_name, input, transcript_attrs)
        .into_iter()
        .map(|(key, value)| format!(" {}=\"{}\"", key, escape_xml(&value)))
        .collect::<String>();

    format!(
        "  <tool id=\"{}\" user=\"{}\" name=\"{}\"{} time=\"+{}\" />",
        escape_xml(&tool_id),
        escape_xml(&short_id(author_pubkey)),
        escape_xml(tool_name),
        attrs,
        relative
    )
}

struct MessageToolPart {
    tool_call_id: String,
    tool_name: String,
    input: Value,
}

fn extract_message_tool_part(message: &MessageRecord) -> Option<MessageToolPart> {
    let tools = message.tool_data.as_ref()?.as_array()?;
    for tool in tools {
        if tool
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "tool-result")
        {
            continue;
        }
        let tool_call_id = get_string(tool, &["toolCallId", "tool_call_id", "id"])
            .or_else(|| event_id_for_message(message))
            .unwrap_or_else(|| message.record_id.clone());
        let tool_name = get_string(tool, &["toolName", "tool_name", "name"])?;
        let input = tool
            .get("input")
            .or_else(|| tool.get("args"))
            .or_else(|| tool.get("arguments"))
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        return Some(MessageToolPart {
            tool_call_id,
            tool_name,
            input,
        });
    }
    None
}

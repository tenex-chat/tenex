use super::ids::{get_string, short_id};
use serde_json::Value;
use tenex_conversations::MessageRecord;

pub(super) fn format_delegation_marker(message: &MessageRecord) -> Option<String> {
    let marker = message.delegation_marker.as_ref()?;
    let conversation_id = get_string(
        marker,
        &["delegationConversationId", "delegation_conversation_id"],
    )?;
    let recipient = get_string(marker, &["recipientPubkey", "recipient_pubkey"])?;
    let status = get_string(marker, &["status"])?;
    let symbol = match status.as_str() {
        "pending" => "⏳",
        "completed" => "✅",
        _ => "⚠️",
    };
    let label = match status.as_str() {
        "pending" => "in progress",
        "completed" => "completed",
        _ => "aborted",
    };
    Some(format!(
        "{symbol} Delegation {} → {} {label}",
        short_id(&conversation_id),
        short_id(&recipient)
    ))
}

pub(super) fn recipients_for_message(message: &MessageRecord) -> Option<Vec<String>> {
    let pubkeys = message.targeted_pubkeys.as_ref()?;
    let principals = message
        .targeted_principals
        .as_ref()
        .and_then(Value::as_array);
    Some(
        pubkeys
            .iter()
            .enumerate()
            .map(|(index, pubkey)| {
                let principal = principals.and_then(|items| items.get(index));
                display_principal(Some(pubkey), principal)
            })
            .collect(),
    )
}

pub(super) fn display_author(message: &MessageRecord) -> String {
    display_principal(
        Some(&message_author_pubkey(message)),
        message.sender_principal.as_ref(),
    )
}

pub(super) fn message_author_pubkey(message: &MessageRecord) -> String {
    message
        .sender_principal
        .as_ref()
        .and_then(|value| get_string(value, &["linkedPubkey", "linked_pubkey"]))
        .or_else(|| message.sender_pubkey.clone())
        .unwrap_or_else(|| message.author_pubkey.clone())
}

fn display_principal(pubkey: Option<&String>, principal: Option<&Value>) -> String {
    if let Some(value) = principal {
        for key in [
            "displayName",
            "display_name",
            "username",
            "id",
            "linkedPubkey",
            "linked_pubkey",
        ] {
            if let Some(display) = value.get(key).and_then(Value::as_str) {
                if !display.trim().is_empty() {
                    return display.to_string();
                }
            }
        }
    }
    pubkey
        .map(|value| short_id(value))
        .unwrap_or_else(|| "unknown".to_string())
}

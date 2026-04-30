/// A single conversation shown in the reminders overlay.
pub struct ConversationSummary {
    /// First 8 hex chars of the conversation ID.
    pub id_short: String,
    /// Human-readable title, if available.
    pub title: Option<String>,
    /// Human-readable relative time string, e.g. "3 minutes ago".
    pub last_active_human: String,
}

/// The delegation parent for the current conversation, if any.
pub struct DelegationParentRef {
    /// First 8 hex chars of the parent conversation ID.
    pub id_short: String,
    /// Human-readable title, if available.
    pub title: Option<String>,
}

/// Data needed to render the `<conversation-reminders>` block.
pub struct ConversationRemindersForPrompt {
    /// Other active/recent conversations in this project (excludes current).
    pub active_conversations: Vec<ConversationSummary>,
    /// The parent conversation when this agent was delegated to.
    pub delegation_parent: Option<DelegationParentRef>,
}

pub fn render_conversation_reminders(
    reminders: &ConversationRemindersForPrompt,
) -> Option<String> {
    let has_active = !reminders.active_conversations.is_empty();
    let has_parent = reminders.delegation_parent.is_some();
    if !has_active && !has_parent {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("<conversation-reminders>".to_string());

    if has_active {
        lines.push("Active conversations in this project:".to_string());
        for conv in &reminders.active_conversations {
            let title = conv.title.as_deref().unwrap_or("(untitled)");
            lines.push(format!(
                "- {} [id: {}] — last activity {}",
                title, conv.id_short, conv.last_active_human
            ));
        }
    }

    if let Some(parent) = &reminders.delegation_parent {
        let title = parent.title.as_deref().unwrap_or("(untitled)");
        lines.push(format!(
            "Delegation parent: {} [id: {}]",
            title, parent.id_short
        ));
    }

    lines.push("</conversation-reminders>".to_string());
    Some(lines.join("\n"))
}

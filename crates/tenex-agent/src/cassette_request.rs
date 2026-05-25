use rig_core::completion::CompletionRequest;
use rig_core::message::{AssistantContent, Message, ToolResultContent, UserContent};

pub(crate) fn request_debug(request: &CompletionRequest) -> String {
    let mut latest = None;
    for message in request.chat_history.iter() {
        if let Some(text) = message_text(message) {
            latest = Some(text);
        }
    }
    latest.unwrap_or_else(|| format!("{:?}", request))
}

fn message_text(message: &Message) -> Option<String> {
    match message {
        Message::System { content } => Some(content.clone()),
        Message::User { content } => {
            let text = content
                .iter()
                .filter_map(user_content_text)
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Message::Assistant { content, .. } => {
            let text = content
                .iter()
                .filter_map(|item| match item {
                    AssistantContent::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
    }
}

fn user_content_text(content: &UserContent) -> Option<&str> {
    match content {
        UserContent::Text(text) => Some(text.text.as_str()),
        UserContent::ToolResult(tool_result) => tool_result.content.iter().find_map(|content| {
            if let ToolResultContent::Text(text) = content {
                Some(text.text.as_str())
            } else {
                None
            }
        }),
        _ => None,
    }
}

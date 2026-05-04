use rig::completion::CompletionRequest;
use rig::message::{AssistantContent, Message, ReasoningContent, UserContent};
use rig::OneOrMany;

pub(crate) fn sanitize_completion_request(mut request: CompletionRequest) -> CompletionRequest {
    let mut messages: Vec<Message> = request
        .chat_history
        .clone()
        .into_iter()
        .filter_map(sanitize_message)
        .collect();

    while matches!(messages.last(), Some(Message::Assistant { .. })) {
        messages.pop();
    }

    if let Ok(chat_history) = OneOrMany::many(messages) {
        request.chat_history = chat_history;
    }

    request
}

fn sanitize_message(message: Message) -> Option<Message> {
    match message {
        Message::System { content } => {
            if content.trim().is_empty() {
                None
            } else {
                Some(Message::System { content })
            }
        }
        Message::User { content } => {
            sanitize_user_content(content).map(|content| Message::User { content })
        }
        Message::Assistant { id, content } => {
            sanitize_assistant_content(content).map(|content| Message::Assistant { id, content })
        }
    }
}

fn sanitize_user_content(content: OneOrMany<UserContent>) -> Option<OneOrMany<UserContent>> {
    let items: Vec<UserContent> = content
        .into_iter()
        .filter_map(|item| match item {
            UserContent::Text(text) if text.text.trim().is_empty() => None,
            UserContent::ToolResult(result) => Some(UserContent::ToolResult(result)),
            other => Some(other),
        })
        .collect();
    OneOrMany::many(items).ok()
}

fn sanitize_assistant_content(
    content: OneOrMany<AssistantContent>,
) -> Option<OneOrMany<AssistantContent>> {
    let items: Vec<AssistantContent> = content
        .into_iter()
        .filter(|item| match item {
            AssistantContent::Text(text) => !text.text.trim().is_empty(),
            AssistantContent::Reasoning(reasoning) => {
                reasoning.content.iter().any(|content| match content {
                    ReasoningContent::Text { text, .. } => !text.trim().is_empty(),
                    ReasoningContent::Summary(summary) => !summary.trim().is_empty(),
                    ReasoningContent::Redacted { data } => !data.trim().is_empty(),
                    ReasoningContent::Encrypted(data) => !data.trim().is_empty(),
                    _ => true,
                })
            }
            AssistantContent::ToolCall(_) | AssistantContent::Image(_) => true,
        })
        .collect();
    OneOrMany::many(items).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig::message::{Text, ToolCall, ToolFunction, ToolResult, ToolResultContent};

    fn request(messages: Vec<Message>) -> CompletionRequest {
        CompletionRequest {
            model: None,
            preamble: None,
            chat_history: OneOrMany::many(messages).unwrap(),
            documents: Vec::new(),
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
        }
    }

    fn user(text: &str) -> Message {
        Message::User {
            content: OneOrMany::one(UserContent::Text(Text {
                text: text.to_string(),
            })),
        }
    }

    fn assistant_text(text: &str) -> Message {
        Message::Assistant {
            id: None,
            content: OneOrMany::one(AssistantContent::Text(Text {
                text: text.to_string(),
            })),
        }
    }

    #[test]
    fn removes_empty_text_messages() {
        let sanitized = sanitize_completion_request(request(vec![
            Message::System {
                content: String::new(),
            },
            user(""),
            user("keep"),
        ]));
        let messages: Vec<Message> = sanitized.chat_history.into_iter().collect();

        assert_eq!(messages.len(), 1);
        assert!(matches!(&messages[0], Message::User { .. }));
    }

    #[test]
    fn preserves_tool_results_and_tool_calls() {
        let tool_result = Message::User {
            content: OneOrMany::one(UserContent::ToolResult(ToolResult {
                id: "result-1".to_string(),
                call_id: Some("call-1".to_string()),
                content: OneOrMany::one(ToolResultContent::Text(Text {
                    text: String::new(),
                })),
            })),
        };
        let tool_call = Message::Assistant {
            id: None,
            content: OneOrMany::one(AssistantContent::ToolCall(ToolCall::new(
                "tool-1".to_string(),
                ToolFunction::new("lookup".to_string(), serde_json::json!({})),
            ))),
        };

        let sanitized =
            sanitize_completion_request(request(vec![tool_call, tool_result, user("next")]));
        let messages: Vec<Message> = sanitized.chat_history.into_iter().collect();

        assert_eq!(messages.len(), 3);
        assert!(matches!(&messages[0], Message::Assistant { .. }));
        assert!(matches!(&messages[1], Message::User { .. }));
    }

    #[test]
    fn strips_trailing_assistant_messages() {
        let sanitized = sanitize_completion_request(request(vec![
            Message::System {
                content: "system".to_string(),
            },
            user("prompt"),
            assistant_text("stale draft"),
        ]));
        let messages: Vec<Message> = sanitized.chat_history.into_iter().collect();

        assert_eq!(messages.len(), 2);
        assert!(matches!(messages.last(), Some(Message::User { .. })));
    }
}

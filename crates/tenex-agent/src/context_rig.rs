use rig::completion::message::{Text, ToolCall as RigToolCall, ToolFunction, ToolResult};
use rig::completion::message::{ToolResultContent, UserContent};
use rig::completion::{AssistantContent, Message as RigMessage};
use rig::OneOrMany;
use tenex_context::Message as CtxMessage;

/// Convert a `tenex_context::Message` to `rig::completion::Message` for passing
/// as history to `stream_chat`. System messages are excluded at the call site
/// because the preamble handles them.
pub fn ctx_msg_to_rig(msg: CtxMessage) -> RigMessage {
    match msg {
        CtxMessage::System { content } => RigMessage::System { content },
        CtxMessage::User { content } => RigMessage::User {
            content: OneOrMany::one(UserContent::Text(Text { text: content })),
        },
        CtxMessage::Assistant {
            content,
            tool_calls,
        } => {
            let mut parts: Vec<AssistantContent> = Vec::new();
            if !content.is_empty() {
                parts.push(AssistantContent::Text(Text { text: content }));
            }
            for tc in tool_calls {
                parts.push(AssistantContent::ToolCall(RigToolCall::new(
                    tc.id,
                    ToolFunction::new(tc.name, tc.arguments),
                )));
            }
            if parts.is_empty() {
                parts.push(AssistantContent::Text(Text {
                    text: String::new(),
                }));
            }
            let content = if parts.len() == 1 {
                OneOrMany::one(parts.remove(0))
            } else {
                OneOrMany::many(parts).unwrap_or_else(|_| {
                    OneOrMany::one(AssistantContent::Text(Text {
                        text: String::new(),
                    }))
                })
            };
            RigMessage::Assistant { id: None, content }
        }
        CtxMessage::ToolResult {
            tool_call_id,
            content,
            ..
        } => RigMessage::User {
            content: OneOrMany::one(UserContent::ToolResult(ToolResult {
                id: tool_call_id,
                call_id: None,
                content: OneOrMany::one(ToolResultContent::Text(Text { text: content })),
            })),
        },
    }
}

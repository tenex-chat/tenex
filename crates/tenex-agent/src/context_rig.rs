use base64::Engine as _;
use rig_core::OneOrMany;
use rig_core::completion::message::{
    DocumentSourceKind, Image, ImageMediaType, MimeType as _, Reasoning, Text,
    ToolCall as RigToolCall, ToolFunction, ToolResult,
};
use rig_core::completion::message::{ToolResultContent, UserContent};
use rig_core::completion::{AssistantContent, Message as RigMessage};
use tenex_context::Message as CtxMessage;

/// Convert a `tenex_context::Message` to `rig_core::completion::Message` for the
/// provider request assembled by the TENEX step loop.
pub fn ctx_msg_to_rig(msg: CtxMessage) -> RigMessage {
    match msg {
        CtxMessage::System { content } => RigMessage::System { content },
        CtxMessage::User {
            content,
            attachments,
        } => {
            if attachments.is_empty() {
                RigMessage::User {
                    content: OneOrMany::one(UserContent::Text(Text { text: content })),
                }
            } else {
                // Images first, then text — matches the order the in-memory
                // path produced via turn_loop/mod.rs:67-86 today.
                let mut parts: Vec<UserContent> = Vec::with_capacity(attachments.len() + 1);
                for att in attachments {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&att.data);
                    let media_type = ImageMediaType::from_mime_type(&att.media_type);
                    parts.push(UserContent::Image(Image {
                        data: DocumentSourceKind::Base64(encoded),
                        media_type,
                        detail: None,
                        additional_params: None,
                    }));
                }
                parts.push(UserContent::Text(Text { text: content }));
                RigMessage::User {
                    content: OneOrMany::many(parts).unwrap_or_else(|_| {
                        OneOrMany::one(UserContent::Text(Text { text: String::new() }))
                    }),
                }
            }
        }
        CtxMessage::Assistant {
            content,
            reasoning,
            tool_calls,
        } => {
            let mut parts: Vec<AssistantContent> = Vec::new();
            if !content.is_empty() {
                parts.push(AssistantContent::Text(Text { text: content }));
            }
            for block in reasoning {
                let reasoning = Reasoning::new_with_signature(&block.text, block.signature)
                    .optional_id(block.id);
                parts.push(AssistantContent::Reasoning(reasoning));
            }
            for tc in tool_calls {
                let mut tool_call =
                    RigToolCall::new(tc.id, ToolFunction::new(tc.name, tc.arguments));
                if let Some(call_id) = tc.provider_call_id {
                    tool_call = tool_call.with_call_id(call_id);
                }
                parts.push(AssistantContent::ToolCall(tool_call));
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
            provider_call_id,
            content,
            ..
        } => RigMessage::User {
            content: OneOrMany::one(UserContent::ToolResult(ToolResult {
                id: tool_call_id,
                call_id: provider_call_id,
                content: OneOrMany::one(ToolResultContent::Text(Text { text: content })),
            })),
        },
        // An un-expanded delegation marker shouldn't reach this point
        // under the default strategy stack (ExpandDelegationMarkersStrategy
        // converts these to `User` before the converter runs). If one
        // slips through, surface it as a visible-but-degraded note so
        // the model can still reason about it.
        CtxMessage::DelegationMarker { marker, .. } => RigMessage::User {
            content: OneOrMany::one(UserContent::Text(Text {
                text: format!(
                    "[Delegation to {} (conv: {}...) — {}]",
                    marker.recipient_pubkey.chars().take(8).collect::<String>(),
                    marker
                        .delegation_conversation_id
                        .chars()
                        .take(10)
                        .collect::<String>(),
                    marker.status.as_str(),
                ),
            })),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig_core::completion::message::ReasoningContent;
    use serde_json::json;
    use tenex_context::{ReasoningBlock, ToolCall};

    #[test]
    fn assistant_reasoning_precedes_tool_calls_and_preserves_provider_id() {
        let msg = CtxMessage::Assistant {
            content: "visible".into(),
            reasoning: vec![ReasoningBlock {
                id: Some("reasoning-1".into()),
                text: "hidden chain".into(),
                signature: Some("sig-1".into()),
            }],
            tool_calls: vec![ToolCall {
                id: "internal-call-1".into(),
                provider_call_id: Some("provider-call-1".into()),
                name: "shell".into(),
                arguments: json!({ "command": "true" }),
            }],
        };

        let RigMessage::Assistant { content, .. } = ctx_msg_to_rig(msg) else {
            panic!("expected assistant message");
        };
        let parts = content.iter().collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        assert!(matches!(parts[0], AssistantContent::Text(Text { text }) if text == "visible"));

        let AssistantContent::Reasoning(reasoning) = parts[1] else {
            panic!("expected reasoning before tool call");
        };
        assert_eq!(reasoning.id.as_deref(), Some("reasoning-1"));
        assert!(matches!(
            reasoning.content.first(),
            Some(ReasoningContent::Text { text, signature })
                if text == "hidden chain" && signature.as_deref() == Some("sig-1")
        ));

        let AssistantContent::ToolCall(tool_call) = parts[2] else {
            panic!("expected tool call after reasoning");
        };
        assert_eq!(tool_call.id, "internal-call-1");
        assert_eq!(tool_call.call_id.as_deref(), Some("provider-call-1"));
    }

    #[test]
    fn tool_result_preserves_provider_call_id() {
        let msg = CtxMessage::ToolResult {
            tool_call_id: "internal-call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            tool_name: "shell".into(),
            content: "ok".into(),
            is_error: false,
        };

        let RigMessage::User { content, .. } = ctx_msg_to_rig(msg) else {
            panic!("expected user message");
        };
        let UserContent::ToolResult(result) = content.first_ref() else {
            panic!("expected tool result content");
        };
        assert_eq!(result.id, "internal-call-1");
        assert_eq!(result.call_id.as_deref(), Some("provider-call-1"));
    }
}

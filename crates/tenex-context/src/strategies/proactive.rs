//! Proactive-context strategy.
//!
//! Overlays a pre-computed `<proactive-context>` block onto the last
//! *user* message in the projection — the message that frames the agent's
//! current task. Computed once per agent invocation (typically via RAG
//! over the trigger message) and threaded through every step's projection
//! unchanged — this keeps the system prompt stable so the prompt-cache
//! anchor remains valid across steps.
//!
//! It anchors to the real user message rather than the last message of any
//! role on purpose: a trailing message is often a `ToolResult`, which on
//! the wire is a role-`user` wrapper around a single tool call's output.
//! Retrieval context does not belong inside a tool result — it would
//! corrupt the `tool_use` → `tool_result` contract and attribute the RAG
//! hits to whatever tool happened to run last.
//!
//! Runs after decay and before reminders.

use async_trait::async_trait;

use super::{ProjectionContext, Strategy};
use crate::types::Message;

pub struct ProactiveContextStrategy;

const NAME: &str = "proactive_context";

#[async_trait]
impl Strategy for ProactiveContextStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        let Some(block) = ctx.proactive_context else {
            return Ok(());
        };
        if block.is_empty() {
            return Ok(());
        }

        let Some(content) = ctx.messages.iter_mut().rev().find_map(|m| match m {
            Message::User { content, .. } => Some(content),
            _ => None,
        }) else {
            return Ok(());
        };

        content.push_str("\n\n");
        content.push_str(block);

        ctx.telemetry.strategies_applied.push(NAME.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelProfile, ProjectionTelemetry};

    fn profile() -> ModelProfile {
        ModelProfile {
            provider: "test".into(),
            model_id: "model".into(),
            prompt_cache: false,
            ephemeral_reminders: false,
            image_support: false,
            max_context_tokens: 200_000,
        }
    }

    fn ctx<'a>(messages: Vec<Message>, p: &'a ModelProfile, block: Option<&'a str>) -> ProjectionContext<'a> {
        ProjectionContext {
            messages,
            telemetry: ProjectionTelemetry::default(),
            model_profile: p,
            tool_defs: &[],
            agent_todos: None,
            proactive_context: block,
            delegation_transcripts: ::std::collections::HashMap::new(),
            conversation_id: "test-conv",
            name_resolver: None,
        }
    }

    #[tokio::test]
    async fn no_op_when_block_is_none() {
        let p = profile();
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::User { content: "u".into(), attachments: Vec::new() },
            ],
            &p,
            None,
        );
        ProactiveContextStrategy.apply(&mut c).await.unwrap();
        assert!(c.telemetry.strategies_applied.is_empty());
        let Message::User { content, .. } = &c.messages[1] else { unreachable!() };
        assert_eq!(content, "u");
    }

    #[tokio::test]
    async fn no_op_when_block_is_empty() {
        let p = profile();
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::User { content: "u".into(), attachments: Vec::new() },
            ],
            &p,
            Some(""),
        );
        ProactiveContextStrategy.apply(&mut c).await.unwrap();
        assert!(c.telemetry.strategies_applied.is_empty());
    }

    #[tokio::test]
    async fn appends_to_last_non_system_user_message() {
        let p = profile();
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::User { content: "first".into(), attachments: Vec::new() },
                Message::User { content: "last".into(), attachments: Vec::new() },
            ],
            &p,
            Some("<proactive-context>\nhit 1\n</proactive-context>"),
        );
        ProactiveContextStrategy.apply(&mut c).await.unwrap();
        let Message::User { content, .. } = &c.messages[2] else { unreachable!() };
        assert!(
            content.starts_with("last\n\n<proactive-context>"),
            "block must be appended to the last message"
        );
        let Message::User { content, .. } = &c.messages[1] else { unreachable!() };
        assert_eq!(content, "first", "earlier messages must be untouched");
        assert_eq!(c.telemetry.strategies_applied, vec!["proactive_context"]);
    }

    #[tokio::test]
    async fn anchors_to_last_user_skipping_trailing_assistant_and_tool_result() {
        let p = profile();
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::User { content: "u".into(), attachments: Vec::new() },
                Message::Assistant {
                    content: "a".into(),
                    reasoning: Vec::new(),
                    tool_calls: Vec::new(),
                },
                Message::ToolResult {
                    tool_call_id: "call-1".into(),
                    tool_name: "shell".into(),
                    content: "output".into(),
                    provider_call_id: None,
                    is_error: false,
                },
            ],
            &p,
            Some("BLOCK"),
        );
        ProactiveContextStrategy.apply(&mut c).await.unwrap();
        let Message::User { content, .. } = &c.messages[1] else { unreachable!() };
        assert!(content.ends_with("BLOCK"), "block lands on the user message");
        let Message::Assistant { content, .. } = &c.messages[2] else { unreachable!() };
        assert_eq!(content, "a", "trailing assistant untouched");
        let Message::ToolResult { content, .. } = &c.messages[3] else { unreachable!() };
        assert_eq!(content, "output", "trailing tool result untouched");
    }

    #[tokio::test]
    async fn no_op_when_no_user_message() {
        let p = profile();
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::ToolResult {
                    tool_call_id: "call-1".into(),
                    tool_name: "shell".into(),
                    content: "output".into(),
                    provider_call_id: None,
                    is_error: false,
                },
            ],
            &p,
            Some("BLOCK"),
        );
        ProactiveContextStrategy.apply(&mut c).await.unwrap();
        assert!(c.telemetry.strategies_applied.is_empty());
        let Message::ToolResult { content, .. } = &c.messages[1] else { unreachable!() };
        assert_eq!(content, "output", "no user message → tool result untouched");
    }
}

//! Expand persisted delegation markers in the projection.
//!
//! Two distinct treatments by status:
//!
//! - **`Pending`**: drop the marker from the message stream and overlay a
//!   `<system-reminder>` block onto the last visible non-system message
//!   listing all currently-pending delegations. This mirrors how the
//!   todo list ([`super::reminders::RemindersStrategy`]) surfaces — the
//!   agent gets continuous status awareness without a freestanding
//!   user-role row that would look like fresh input. A pending
//!   delegation is *state*, not *content* the agent needs to respond to.
//!
//! - **`Completed` / `Aborted`**: rewrite the marker in place as a
//!   `Message::User { content: <# DELEGATION COMPLETED ...> }` block
//!   carrying the full child conversation transcript as XML. Once the
//!   delegation ends, the child's reply IS the content the parent
//!   agent must act on, so it deserves a first-class user-role message.
//!
//! Nested markers (this conversation is a grandparent or further, not
//! the direct delegator) collapse to a single-line reference regardless
//! of status, to keep multi-level delegation context bounded:
//!
//! ```text
//! [Delegation to @agent2 (conv: 1a2b3c4d5e...) — completed]
//! ```
//!
//! Mirrors `expandDelegationMarker()` in the deleted TypeScript code
//! (`src/conversations/MessageBuilder.ts:409-475` of commit `5908a1c9`),
//! adjusted so pending state is a reminder overlay rather than a
//! standalone user message.

use std::collections::HashMap;

use async_trait::async_trait;
use tenex_conversations::{DelegationMarker, DelegationStatus, MessageRecord};

use super::{ProjectionContext, Strategy};
use crate::projection::DisplayNameResolver;
use crate::transcript::render_conversation_xml;
use crate::types::Message;

pub struct ExpandDelegationMarkersStrategy;

const NAME: &str = "expand_delegation_markers";

#[async_trait]
impl Strategy for ExpandDelegationMarkersStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        // Pass 1: rewrite Completed/Aborted markers in place; collect
        // Pending markers (and remove their rows) for the reminder pass.
        let mut pending: Vec<DelegationMarker> = Vec::new();
        let mut expanded_terminal = 0usize;
        let mut new_messages: Vec<Message> = Vec::with_capacity(ctx.messages.len());
        for msg in std::mem::take(&mut ctx.messages) {
            match msg {
                Message::DelegationMarker { marker, .. }
                    if matches!(marker.status, DelegationStatus::Pending) =>
                {
                    pending.push(marker);
                }
                Message::DelegationMarker { marker, .. } => {
                    let rendered = expand_terminal_marker(
                        &marker,
                        &ctx.delegation_transcripts,
                        ctx.conversation_id,
                        ctx.name_resolver,
                    );
                    new_messages.push(Message::User {
                        content: rendered,
                        attachments: Vec::new(),
                    });
                    expanded_terminal += 1;
                }
                other => new_messages.push(other),
            }
        }
        ctx.messages = new_messages;

        // Pass 2: overlay a `<system-reminder>` block listing pending
        // delegations onto the last visible non-system message, mirroring
        // how `RemindersStrategy` surfaces the todo list.
        let pending_count = pending.len();
        if !pending.is_empty() {
            let reminder = build_pending_delegations_reminder(&pending, ctx.name_resolver);
            if let Some(target) = ctx
                .messages
                .iter_mut()
                .rev()
                .find(|m| !matches!(m, Message::System { .. }))
            {
                match target {
                    Message::User { content, .. } | Message::Assistant { content, .. } => {
                        content.push_str("\n\n");
                        content.push_str(&reminder);
                    }
                    Message::ToolResult { content, .. } => {
                        content.push_str("\n\n");
                        content.push_str(&reminder);
                    }
                    Message::System { .. } | Message::DelegationMarker { .. } => {
                        // System: skip (system prompt is intentionally stable).
                        // DelegationMarker: shouldn't exist post-pass-1.
                    }
                }
            }
        }

        if expanded_terminal > 0 || pending_count > 0 {
            ctx.telemetry.strategies_applied.push(NAME.to_string());
        }
        Ok(())
    }
}

/// Render the system-reminder block listing all pending delegations.
/// Shape mirrors [`super::reminders::build_todos_reminder`] —
/// `<system-reminder><agent-delegations>...</agent-delegations></system-reminder>`,
/// with a Status line, one entry per delegation, and a closing
/// ATTENTION line that nudges the agent not to busy-wait.
fn build_pending_delegations_reminder(
    pending: &[DelegationMarker],
    resolver: Option<&dyn DisplayNameResolver>,
) -> String {
    let mut lines = vec![
        "<system-reminder>".to_string(),
        "<agent-delegations>".to_string(),
        String::new(),
        format!("Status: {} pending", pending.len()),
        String::new(),
    ];
    for m in pending {
        let recipient = display_name(&m.recipient_pubkey, resolver);
        let short_conv: String = m.delegation_conversation_id.chars().take(10).collect();
        lines.push(format!(
            "[~] @{recipient} (delegation: {short_conv}...) — pending"
        ));
    }
    lines.push(String::new());
    lines.push(
        "These delegations are running asynchronously. Each runs in its own conversation; \
         you will be re-invoked with the result when each finishes. Do not poll or wait \
         — stop your turn after delegating."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(format!(
        "**ATTENTION:** You have {} outstanding delegation(s) awaiting completion.",
        pending.len()
    ));
    lines.push("</agent-delegations>".to_string());
    lines.push("</system-reminder>".to_string());
    lines.join("\n")
}

/// Render a `Completed`/`Aborted` marker as the user-message content
/// the parent agent will act on. Direct-child markers (own delegation)
/// get the full transcript; nested markers collapse to a one-liner to
/// keep transitive context bounded.
fn expand_terminal_marker(
    marker: &DelegationMarker,
    transcripts: &HashMap<String, Vec<MessageRecord>>,
    current_conversation_id: &str,
    name_resolver: Option<&dyn DisplayNameResolver>,
) -> String {
    let recipient_name = display_name(&marker.recipient_pubkey, name_resolver);
    let is_direct_child = marker.parent_conversation_id == current_conversation_id;

    if !is_direct_child {
        let short_conv: String = marker
            .delegation_conversation_id
            .chars()
            .take(10)
            .collect();
        return format!(
            "[Delegation to @{recipient_name} (conv: {short_conv}...) — {}]",
            marker.status.as_str()
        );
    }

    let transcript = match transcripts.get(&marker.delegation_conversation_id) {
        Some(child_messages) => render_conversation_xml(
            &marker.delegation_conversation_id,
            child_messages,
            name_resolver,
        ),
        None => empty_conversation_xml(&marker.delegation_conversation_id),
    };
    let header = match marker.status {
        DelegationStatus::Completed => "# DELEGATION COMPLETED".to_string(),
        DelegationStatus::Aborted => {
            let reason = marker
                .abort_reason
                .as_deref()
                .map(|r| format!("\n\n**Reason:** {r}"))
                .unwrap_or_default();
            format!("# DELEGATION ABORTED{reason}")
        }
        DelegationStatus::Pending => {
            // Caller routes Pending to the reminder pass; this branch
            // is defensive — if it ever fires, fall back to a harmless
            // status line rather than panicking.
            return format!(
                "[Delegation to @{recipient_name} (conv: {}...) — pending]",
                tenex_utils::ids::shorten_full_event_id(&marker.delegation_conversation_id)
            );
        }
    };
    format!("{header}\n\n### Transcript:\n{transcript}")
}

fn empty_conversation_xml(conv_id: &str) -> String {
    let short = tenex_utils::ids::shorten_full_event_id(conv_id);
    format!("<conversation id=\"{short}\" t0=\"0\"></conversation>")
}

fn display_name(pubkey: &str, resolver: Option<&dyn DisplayNameResolver>) -> String {
    if let Some(r) = resolver {
        if let Some(name) = r.display_name(pubkey) {
            return name;
        }
    }
    pubkey.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProjectionTelemetry;
    use tenex_conversations::ConversationStore;

    struct StubResolver;
    impl DisplayNameResolver for StubResolver {
        fn display_name(&self, pubkey: &str) -> Option<String> {
            match pubkey {
                "agent2-pk" => Some("agent2".into()),
                _ => None,
            }
        }
    }

    fn marker(status: DelegationStatus, parent: &str) -> DelegationMarker {
        DelegationMarker {
            delegation_conversation_id: "child-conv-xxxxxxxxxxxxxxxxxx".into(),
            recipient_pubkey: "agent2-pk".into(),
            parent_conversation_id: parent.into(),
            initiated_at: Some(100),
            completed_at: Some(200),
            status,
            abort_reason: None,
        }
    }

    fn ctx<'a>(
        messages: Vec<Message>,
        profile: &'a crate::types::ModelProfile,
        transcripts: HashMap<String, Vec<MessageRecord>>,
        conv: &'a str,
        resolver: Option<&'a dyn DisplayNameResolver>,
    ) -> ProjectionContext<'a> {
        ProjectionContext {
            messages,
            telemetry: ProjectionTelemetry::default(),
            model_profile: profile,
            tool_defs: &[],
            agent_todos: None,
            proactive_context: None,
            delegation_transcripts: transcripts,
            conversation_id: conv,
            name_resolver: resolver,
        }
    }

    fn p() -> crate::types::ModelProfile {
        crate::types::ModelProfile {
            provider: "test".into(),
            model_id: "model".into(),
            prompt_cache: false,
            ephemeral_reminders: false,
            image_support: false,
            max_context_tokens: 200_000,
        }
    }

    fn synthetic_child_message(author: &str, content: &str, ts: i64) -> MessageRecord {
        MessageRecord {
            id: 1,
            conversation_id: "child-conv-xxxxxxxxxxxxxxxxxx".into(),
            record_id: "msg1".into(),
            nostr_event_id: None,
            sequence: 0,
            author_pubkey: author.into(),
            sender_pubkey: None,
            ral: None,
            message_type: "text".into(),
            role: Some("user".into()),
            content: content.into(),
            timestamp: Some(ts),
            targeted_pubkeys: None,
            sender_principal: None,
            targeted_principals: None,
            tool_data: None,
            delegation_marker: None,
            human_readable: None,
            transcript_tool_attributes: None,
            created_at: 0,
        }
    }

    #[tokio::test]
    async fn pending_marker_becomes_system_reminder_overlay_not_user_message() {
        let profile = p();
        let m = marker(DelegationStatus::Pending, "parent-conv");
        // Pending marker sits between a User trigger and an Assistant
        // turn — same shape projection would produce after the agent
        // emitted `delegate` and a follow-up step.
        let mut c = ctx(
            vec![
                Message::System { content: "sys".into() },
                Message::User {
                    content: "go".into(),
                    attachments: Vec::new(),
                },
                Message::DelegationMarker { marker: m, ral_number: None },
                Message::Assistant {
                    content: "Waiting for agent2.".into(),
                    reasoning: Vec::new(),
                    tool_calls: Vec::new(),
                },
            ],
            &profile,
            HashMap::new(),
            "parent-conv",
            Some(&StubResolver),
        );
        ExpandDelegationMarkersStrategy.apply(&mut c).await.unwrap();

        // (1) The DelegationMarker row is gone from messages — pending
        // delegations are state, not content.
        assert!(
            !c.messages.iter().any(|m| matches!(m, Message::DelegationMarker { .. })),
            "pending marker row must be removed"
        );
        assert_eq!(c.messages.len(), 3, "no standalone user-message replacement");

        // (2) A `<system-reminder><agent-delegations>` block is
        // appended to the last visible non-system message (the
        // Assistant "Waiting..." in this case).
        let Message::Assistant { content, .. } = &c.messages[2] else {
            panic!("last message should be the Assistant from the input");
        };
        assert!(
            content.starts_with("Waiting for agent2.\n\n<system-reminder>\n<agent-delegations>"),
            "reminder block must overlay last message: {content}"
        );
        assert!(content.contains("[~] @agent2 (delegation: child-conv...) — pending"));
        assert!(content.contains("**ATTENTION:** You have 1 outstanding delegation"));
        assert!(content.ends_with("</agent-delegations>\n</system-reminder>"));
    }

    #[tokio::test]
    async fn direct_child_completed_renders_header_and_transcript() {
        let profile = p();
        let mut transcripts = HashMap::new();
        transcripts.insert(
            "child-conv-xxxxxxxxxxxxxxxxxx".to_string(),
            vec![synthetic_child_message(
                "agent2-pk",
                "Black — RGB(0,0,0)",
                150,
            )],
        );
        let m = marker(DelegationStatus::Completed, "parent-conv");
        let mut c = ctx(
            vec![Message::DelegationMarker { marker: m, ral_number: None }],
            &profile,
            transcripts,
            "parent-conv",
            Some(&StubResolver),
        );
        ExpandDelegationMarkersStrategy.apply(&mut c).await.unwrap();
        let Message::User { content, .. } = &c.messages[0] else {
            panic!("expected expansion");
        };
        assert!(
            content.starts_with("# DELEGATION COMPLETED\n\n### Transcript:\n"),
            "{content}"
        );
        assert!(content.contains("<conversation id=\"child-conv\""));
        assert!(content.contains("Black — RGB(0,0,0)"));
        assert!(content.contains("author=\"agent2\""));
    }

    #[tokio::test]
    async fn direct_child_aborted_renders_reason_when_present() {
        let profile = p();
        let mut m = marker(DelegationStatus::Aborted, "parent-conv");
        m.abort_reason = Some("kill switch".into());
        let mut c = ctx(
            vec![Message::DelegationMarker { marker: m, ral_number: None }],
            &profile,
            HashMap::new(),
            "parent-conv",
            Some(&StubResolver),
        );
        ExpandDelegationMarkersStrategy.apply(&mut c).await.unwrap();
        let Message::User { content, .. } = &c.messages[0] else {
            panic!("expected expansion");
        };
        assert!(content.contains("# DELEGATION ABORTED"));
        assert!(content.contains("**Reason:** kill switch"));
    }

    #[tokio::test]
    async fn nested_marker_renders_one_liner() {
        let profile = p();
        let m = marker(DelegationStatus::Completed, "grandparent-conv");
        let mut c = ctx(
            vec![Message::DelegationMarker { marker: m, ral_number: None }],
            &profile,
            HashMap::new(),
            "this-conv",
            Some(&StubResolver),
        );
        ExpandDelegationMarkersStrategy.apply(&mut c).await.unwrap();
        let Message::User { content, .. } = &c.messages[0] else {
            panic!("expected expansion");
        };
        assert_eq!(
            content,
            "[Delegation to @agent2 (conv: child-conv...) — completed]"
        );
    }
}

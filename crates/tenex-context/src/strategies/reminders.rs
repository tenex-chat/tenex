//! System-reminder overlays.
//!
//! Reminders are appended to the most recent visible non-system message,
//! so they ride at the tail of the prompt where the model is most likely
//! to attend to them. Mirrors the TS pipeline's "overlay onto last
//! visible" placement.

use crate::strategies::{ProjectionContext, Strategy};
use crate::types::Message;

const NAME: &str = "reminders";
const REMINDER_TEXT: &str =
    "[system reminder] Stay on the user's task. Prefer concrete artifacts over vague gist.";

#[derive(Default)]
pub struct RemindersStrategy;

impl Strategy for RemindersStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        // Walk from the tail, find the last non-system message, append.
        let target = ctx
            .messages
            .iter_mut()
            .enumerate()
            .rev()
            .find(|(_, m)| !matches!(m, Message::System { .. }));

        let Some((_, msg)) = target else {
            return Ok(());
        };

        match msg {
            Message::User { content } | Message::Assistant { content, .. } => {
                content.push_str("\n\n");
                content.push_str(REMINDER_TEXT);
            }
            Message::ToolResult { content, .. } => {
                content.push_str("\n\n");
                content.push_str(REMINDER_TEXT);
            }
            Message::System { .. } => return Ok(()),
        }

        ctx.telemetry.reminders_overlayed += 1;
        ctx.telemetry.strategies_applied.push(NAME.to_string());
        Ok(())
    }
}

//! Conservative token estimator. Chars/4 is the rough heuristic used by
//! TENEX runtime components when an exact tokenizer is not available.

use crate::types::Message;

pub fn estimate_message_tokens(msg: &Message) -> usize {
    match msg {
        Message::System { content }
        | Message::User { content }
        | Message::Assistant { content, .. } => est(content),
        Message::ToolResult { content, .. } => est(content),
    }
}

fn est(s: &str) -> usize {
    // ceil(len/4) with a 1-token floor for non-empty strings.
    if s.is_empty() {
        0
    } else {
        s.len().div_ceil(4)
    }
}

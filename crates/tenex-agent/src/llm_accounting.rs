//! Helpers shared by tenex-agent call sites that record their own LLM
//! usage via `tenex-accounting`.
//!
//! Two pieces:
//!
//! - [`assistant_text`] flattens a rig `CompletionResponse::choice`
//!   (`OneOrMany<AssistantContent>`) into a single `String`, mirroring
//!   the helper rig uses internally for `agent.prompt`. Use this whenever
//!   a call site has switched from `agent.prompt(user).await` to
//!   `agent.completion(user, vec![]).await?.send().await?` so it can
//!   capture token usage.
//!
//! - [`usage_from_rig`] converts rig's `Usage` into
//!   `tenex_accounting::LlmUsage`.

use rig::completion::message::AssistantContent;
use rig::completion::Usage;
use rig::OneOrMany;
use tenex_accounting::LlmUsage;

pub fn assistant_text(choice: &OneOrMany<AssistantContent>) -> String {
    choice
        .iter()
        .filter_map(|content| match content {
            AssistantContent::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect()
}

pub fn usage_from_rig(u: &Usage) -> LlmUsage {
    LlmUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cached_input_tokens: u.cached_input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
        reasoning_tokens: 0,
        total_tokens: Some(u.total_tokens),
    }
}

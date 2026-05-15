use anyhow::Result;
use rig::completion::Message as RigMessage;
use tenex_context::{Message as CtxMessage, ProjectionOptions};

use crate::agent_bootstrap::AgentBootstrap;
use crate::context_rig::ctx_msg_to_rig;
use crate::tools::TurnToolRegistry;

pub(super) async fn project_step_messages(
    boot: &AgentBootstrap,
    registry: &TurnToolRegistry,
    turn_prompt: &RigMessage,
    turn_text: &str,
    in_turn_tail: &[CtxMessage],
    compaction_override: Option<tenex_context::CompactionOverride>,
) -> Result<Vec<RigMessage>> {
    let mut projected = if let Some(store) = boot.conv_store.as_ref() {
        let name_resolver = crate::identity_resolver::IdentityServiceResolver::new(&boot.base_dir);
        tenex_context::project_with_options(
            store,
            &boot.conversation_id,
            &boot.pubkey_hex,
            &boot.system_prompt,
            &model_profile(boot),
            registry.projection_tool_defs(),
            Some(std::sync::Arc::new(
                crate::compaction::LlmCompactionSummarizer::new(
                    std::sync::Arc::new(boot.resolved.clone()),
                    boot.pubkey_hex.clone(),
                    boot.conversation_id.clone(),
                    Some(boot.project_id.clone()),
                ),
            )),
            Some(&name_resolver),
            ProjectionOptions {
                excluded_event_id: Some(boot.trigger_event_id.clone()),
                in_turn_tail: in_turn_tail.to_vec(),
                compaction_override,
            },
        )
        .await?
        .messages
    } else {
        let mut messages = vec![CtxMessage::System {
            content: boot.system_prompt.clone(),
        }];
        messages.extend(in_turn_tail.iter().cloned());
        messages
    };

    let live_prompt_index = projected
        .iter()
        .rposition(|message| {
            matches!(message, CtxMessage::User { content } if is_live_prompt(content, turn_text))
        });
    let mut rig_messages: Vec<RigMessage> = projected.drain(..).map(ctx_msg_to_rig).collect();
    if let Some(index) = live_prompt_index {
        rig_messages[index] = turn_prompt.clone();
    }
    Ok(rig_messages)
}

fn is_live_prompt(content: &str, turn_text: &str) -> bool {
    content == turn_text
        || (!turn_text.is_empty()
            && content
                .strip_prefix(turn_text)
                .is_some_and(|suffix| suffix.starts_with("\n\n<system-reminder")))
}

fn model_profile(boot: &AgentBootstrap) -> tenex_context::ModelProfile {
    tenex_context::ModelProfile {
        provider: boot.resolved.provider.clone(),
        model_id: boot.resolved.model.clone(),
        prompt_cache: boot.resolved.provider == "anthropic",
        ephemeral_reminders: false,
        image_support: boot.envelope_image_parts.is_some(),
        max_context_tokens: 200_000,
    }
}

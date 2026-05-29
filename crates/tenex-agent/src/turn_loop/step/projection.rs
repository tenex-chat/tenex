use anyhow::Result;
use rig_core::completion::Message as RigMessage;
use tenex_context::Message as CtxMessage;

use crate::agent_bootstrap::AgentBootstrap;
use crate::context_rig::ctx_msg_to_rig;
use crate::tools::TurnToolRegistry;

/// Build the provider-bound `messages[]` for a single step.
///
/// Reads the projection straight from the conversation store via
/// `tenex_context::project` — no in-memory tail, no
/// trigger-event exclusion. Every message the LLM sees corresponds
/// either to a stored row (user/assistant/tool) or to an overlay
/// produced by a projection strategy (reminders, proactive context,
/// active-tool pending pairs).
pub(super) async fn project_step_messages(
    boot: &AgentBootstrap,
    registry: &TurnToolRegistry,
    compaction_override: Option<tenex_context::CompactionOverride>,
) -> Result<Vec<RigMessage>> {
    let projected: Vec<CtxMessage> = if let Some(store) = boot.conv_store.as_ref() {
        let name_resolver = crate::identity_resolver::IdentityServiceResolver::new(&boot.base_dir);
        tenex_context::project(
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
            boot.proactive_context.clone(),
            compaction_override,
        )
        .await?
        .messages
    } else {
        // No-store fallback: only the system prompt. Mock_llm tests that
        // exercise the loop without persistence rely on this minimal shape.
        vec![CtxMessage::System {
            content: boot.system_prompt.clone(),
        }]
    };

    Ok(projected.into_iter().map(ctx_msg_to_rig).collect())
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

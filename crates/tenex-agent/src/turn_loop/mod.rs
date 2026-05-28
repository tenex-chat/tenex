//! Turn loop: drives the rig agent forward one turn at a time, persisting
//! results, then asking the supervisor whether to re-engage or stop.
//!
//! [`run_turn_loop`] takes the [`AgentBootstrap`] assembled by
//! [`crate::agent_bootstrap::build`] and consumes its mutable handles
//! (recorders, supervisor lock, runtime-state release_driver) until the
//! supervisor accepts the response. Loop-local working values
//! (`current_message`, accumulated re-engagement tail) live as locals here;
//! everything else flows through `&mut AgentBootstrap`.

mod error_classify;
mod persistence;
mod step;

use std::sync::atomic::Ordering;

use anyhow::{Context, Result};
use rig_core::client::CompletionClient as _;
use rig_core::providers::{anthropic, ollama, openai, openrouter};
use tenex_accounting::{
    RecordLlmCall, RootKind, finish_trace, flush as flush_accounting, open_trace, with_trace,
};
use tenex_protocol::{
    CompletionIntent, ConversationIntent, ErrorIntent, Intent, LlmUsage, MessageRef,
};
use tenex_supervision::supervisor::PostCompletionOutcome;
use tenex_supervision::types::{TodoEntry as SupTodoEntry, TodoStatus as SupTodoStatus};
use tracing::{Instrument, info_span};

use crate::agent_bootstrap::AgentBootstrap;
use crate::cassette_client::RecordingClient;
use crate::llm_retry::RotatingModel;
use crate::mock_llm;
use crate::oauth_client;
use crate::tools::{TodoStatus, ToolRecorder};

pub(crate) async fn run_turn_loop(boot: &mut AgentBootstrap) -> Result<()> {
    // The trigger user message stays fixed across all iterations of this
    // invocation; re-engagement nudges are now persisted as supervision-typed
    // user rows, so the next projection naturally surfaces them rather than
    // an in-memory tail being spliced in. (We still drain `boot.user_message`
    // so its memory is freed for the rest of the loop.)
    let _ = std::mem::take(&mut boot.user_message);
    let mut iteration: u64 = 0;
    let mut nudge_seq: u64 = 0;

    'agent_loop: loop {
        iteration += 1;
        boot.suppress_response.store(false, Ordering::Release);

        // Fresh recorder per turn. RecordingTool clones forward into every
        // tool call so the inner loop's invocations all land here.
        let recorder = ToolRecorder::new();
        let tool_registry = boot.tool_set.build_for_turn(recorder.clone());
        // The injection tracker used to splice mid-turn user input into the
        // in-memory `turn_message`; that path is gone — the runtime
        // persists inbound user rows directly and the next projection
        // sees them naturally. We still drain the tracker buffer here so
        // the "new messages" indicator clears.
        let _ = boot.injection_tracker.lock().unwrap().take_new_messages();

        // Per-iteration child of `tenex.agent.turn` (created in `main::run`).
        // The outer turn span owns the model/history attrs and the env-extracted
        // parent context; this iteration span scopes one supervisor cycle so
        // re-engagements show up as siblings.
        let iteration_span = info_span!("tenex.agent.iteration", iteration = iteration);

        // Open the accounting trace covering this iteration's main stream
        // and any in-turn ancillary LLM calls (rag_search, learn,
        // conversation_get analysis). Re-engagement iterations get sibling
        // traces. Categorize, compaction, and context_discovery run before
        // run_turn_loop so they are unaffected.
        let accounting_trace = open_trace(&RecordLlmCall {
            root_kind: RootKind::UserMessage.into(),
            agent_pubkey: Some(boot.pubkey_hex.clone()),
            conversation_id: Some(boot.conversation_id.clone()),
            project_id: Some(boot.project_id.clone()),
            ..Default::default()
        })
        .await;
        let resolved = boot.resolved.clone();
        let cassette_recorder = boot.cassette_recorder.clone();
        let agent_slug = boot.agent_slug.clone();
        let turn_body = async {
            let healthy_keys = resolved.healthy_api_keys();
            let response = match resolved.provider.as_str() {
                "openrouter" => {
                    if resolved.api_keys.is_empty() {
                        anyhow::bail!("No OpenRouter API key available from LLM config");
                    }
                    let keyed_models = healthy_keys
                        .iter()
                        .map(|k| {
                            let client = RecordingClient::new(
                                openrouter::Client::new(&k.key)?,
                                cassette_recorder.clone(),
                                "openrouter",
                            );
                            Ok::<_, anyhow::Error>((
                                k.original_index,
                                client.completion_model(resolved.model.clone()),
                            ))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let model = RotatingModel::new(
                        resolved.provider.clone(),
                        resolved.key_health.clone(),
                        keyed_models,
                    );
                    step::run_step_loop(boot,model,tool_registry,recorder.clone(),)
                    .await?
                }
                "openai" => {
                    if resolved.api_keys.is_empty() {
                        anyhow::bail!("No OpenAI API key available from LLM config");
                    }
                    let keyed_models = healthy_keys
                        .iter()
                        .map(|k| {
                            let client = RecordingClient::new(
                                openai::CompletionsClient::builder().api_key(&k.key).build()?,
                                cassette_recorder.clone(),
                                "openai",
                            );
                            Ok::<_, anyhow::Error>((
                                k.original_index,
                                client.completion_model(resolved.model.clone()),
                            ))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let model = RotatingModel::new(
                        resolved.provider.clone(),
                        resolved.key_health.clone(),
                        keyed_models,
                    );
                    step::run_step_loop(boot,model,tool_registry,recorder.clone(),)
                    .await?
                }
                "ollama" => {
                    let mut builder = ollama::Client::builder().api_key(rig_core::client::Nothing);
                    if let Some(url) = &resolved.base_url {
                        builder = builder.base_url(url);
                    }
                    let client =
                        RecordingClient::new(builder.build()?, cassette_recorder.clone(), "ollama");
                    step::run_step_loop(boot,client.completion_model(resolved.model.clone()),tool_registry,recorder.clone(),)
                    .await?
                }
                "mock" => {
                    let client = RecordingClient::new(
                        mock_llm::MockClient::from_env(&agent_slug)?,
                        cassette_recorder.clone(),
                        "mock",
                    );
                    step::run_step_loop(boot,client.completion_model(resolved.model.clone()),tool_registry,recorder.clone(),)
                    .await?
                }
                _ => {
                    if resolved.api_keys.is_empty() {
                        anyhow::bail!(
                            "No API key available from LLM config for provider '{}'",
                            resolved.provider
                        );
                    }
                    // Anthropic keys come in two flavours: standard API keys
                    // (`sk-ant-*`) and Claude OAuth bearer tokens. Each
                    // builds a `Client<H>` parameterised by a *different*
                    // `H`, so a single `RotatingModel` can only hold one
                    // flavour. Mixing within one provider is rejected at
                    // resolve time rather than silently using only some
                    // keys; users should split mixed credentials into
                    // separate provider configs.
                    let any_oauth = healthy_keys
                        .iter()
                        .any(|k| oauth_client::is_oauth_token(&k.key));
                    let all_oauth = healthy_keys
                        .iter()
                        .all(|k| oauth_client::is_oauth_token(&k.key));
                    if any_oauth && !all_oauth {
                        anyhow::bail!(
                            "anthropic provider '{}' mixes OAuth tokens and standard API keys. \
                             Split them into two provider entries in providers.json (e.g. \
                             `anthropic` for standard keys and `anthropic-oauth` for OAuth tokens) \
                             and point each llms.json config at the appropriate provider.",
                            resolved.provider
                        );
                    }
                    if all_oauth {
                        let keyed_models = healthy_keys
                            .iter()
                            .map(|k| {
                                let http_client =
                                    oauth_client::build_oauth_http_client(&k.key);
                                let client = RecordingClient::new(
                                    anthropic::Client::builder()
                                        .api_key(&k.key)
                                        .anthropic_betas(oauth_client::OAUTH_BETAS)
                                        .http_client(http_client)
                                        .build()?,
                                    cassette_recorder.clone(),
                                    "anthropic",
                                );
                                Ok::<_, anyhow::Error>((
                                    k.original_index,
                                    client
                                        .completion_model(resolved.model.clone())
                                        .map_inner(|inner| inner.with_prompt_caching()),
                                ))
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        let model = RotatingModel::new(
                            resolved.provider.clone(),
                            resolved.key_health.clone(),
                            keyed_models,
                        );
                        step::run_step_loop(boot,model,tool_registry,recorder.clone(),)
                        .await?
                    } else {
                        let keyed_models = healthy_keys
                            .iter()
                            .map(|k| {
                                let client = RecordingClient::new(
                                    anthropic::Client::new(&k.key)?,
                                    cassette_recorder.clone(),
                                    "anthropic",
                                );
                                Ok::<_, anyhow::Error>((
                                    k.original_index,
                                    client
                                        .completion_model(resolved.model.clone())
                                        .map_inner(|inner| inner.with_prompt_caching()),
                                ))
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        let model = RotatingModel::new(
                            resolved.provider.clone(),
                            resolved.key_health.clone(),
                            keyed_models,
                        );
                        step::run_step_loop(boot,model,tool_registry,recorder.clone(),)
                        .await?
                    }
                }
            };
            Ok::<_, anyhow::Error>(response)
        };
        // Always finalize the accounting trace, even if the streaming or
        // persistence path fails partway through — otherwise the trace row
        // stays open in the DB.
        let turn_result = with_trace(
            accounting_trace.clone(),
            async move {
                match turn_body.await {
                    Ok(v) => Ok(v),
                    Err(e) => {
                        tenex_telemetry::record_current_error(&e);
                        Err(e)
                    }
                }
            }
            .instrument(iteration_span),
        )
        .await;

        let final_response = match turn_result {
            Ok(v) => v,
            Err(e) => {
                finish_trace(accounting_trace).await;
                flush_accounting().await;
                let ral = boot.emit_state.meta.lock().unwrap().ral;
                let ctx = boot.emit_state.build_ctx(ral);
                let intent = Intent::Error(ErrorIntent {
                    message: e.to_string(),
                    error_type: Some("system".to_string()),
                });
                if let Err(emit_err) = boot.emit_state.channel.send(intent, &ctx).await {
                    eprintln!(
                        "[tenex-agent] warn: failed to emit terminal ErrorIntent: {emit_err}"
                    );
                }
                return Err(e);
            }
        };

        if let Some(state) = &boot.runtime_state {
            state.release_driver();
        }

        if let Some(ref store) = boot.conv_store {
            {
                let final_todos = boot.todos.lock().unwrap();
                let final_skills = boot.self_applied_skills.lock().unwrap();
                if let Err(e) = persistence::save_context_state(
                    store,
                    &boot.conversation_id,
                    &boot.pubkey_hex,
                    &final_todos,
                    &final_skills,
                ) {
                    eprintln!("[tenex-agent] Failed to save agent context state: {e:#}");
                }
            }
        }
        with_trace(
            accounting_trace.clone(),
            persistence::record_turn_accounting(
                boot,
                &boot.original_task,
                &final_response.response,
                &final_response.usage,
            ),
        )
        .await;

        finish_trace(accounting_trace).await;
        flush_accounting().await;

        eprintln!("[tenex-agent] Agent completed.");

        let stream_usage = final_response.usage;
        let pending_final = boot.hook_handle.take_pending();

        // `no_response` requests a terminal silent completion. End the loop
        // immediately: no supervision, no re-engagement, and no final
        // completion/conversation event. `pending_final` (taken above) is
        // left unemitted.
        if boot.suppress_response.load(Ordering::Acquire) {
            break 'agent_loop;
        }

        // Post-completion supervision: check if pending todos warrant re-engagement.
        let todos_snap: Vec<SupTodoEntry> = {
            let lock = boot.todos.lock().unwrap();
            lock.iter()
                .map(|t| SupTodoEntry {
                    id: t.id.clone(),
                    status: match t.status {
                        TodoStatus::Pending => SupTodoStatus::Pending,
                        TodoStatus::InProgress => SupTodoStatus::InProgress,
                        TodoStatus::Done => SupTodoStatus::Done,
                        TodoStatus::Skipped => SupTodoStatus::Skipped,
                    },
                })
                .collect()
        };
        let outcome = {
            let mut sup = boot.supervisor_ref.lock().unwrap();
            sup.check_post_completion(
                todos_snap,
                usize::from(boot.emit_state.has_pending_external_work()),
                boot.original_task.clone(),
            )
        };
        match outcome {
            PostCompletionOutcome::Accept => {
                if let Some((final_content, final_ral)) = pending_final {
                    let usage = Some(LlmUsage {
                        input_tokens: Some(stream_usage.input_tokens),
                        output_tokens: Some(stream_usage.output_tokens),
                        total_tokens: Some(stream_usage.total_tokens),
                        cached_input_tokens: Some(stream_usage.cached_input_tokens),
                        cache_creation_tokens: Some(stream_usage.cache_creation_input_tokens),
                        ..Default::default()
                    });
                    if boot.emit_state.has_pending_external_work()
                        || has_pending_delegations_in_store(boot)
                    {
                        let mut final_ctx = boot.emit_state.build_ctx(final_ral);
                        final_ctx.llm_runtime_ms = boot.emit_state.take_runtime_delta();
                        let intent = ConversationIntent {
                            content: final_content,
                            is_reasoning: false,
                            usage,
                            metadata: None,
                        };
                        let refs = boot
                            .channel
                            .send(Intent::Conversation(intent), &final_ctx)
                            .await
                            .context("Failed to emit pending-work conversation event")?;
                        stamp_terminal_event_id_if_any(
                            boot,
                            final_response.terminal_assistant_row_id,
                            &refs,
                        );
                    } else {
                        let final_ctx = boot.emit_state.build_completion_ctx(final_ral);
                        let intent = CompletionIntent {
                            content: final_content,
                            usage,
                            metadata: None,
                        };
                        let refs = boot
                            .channel
                            .send(Intent::Completion(intent), &final_ctx)
                            .await
                            .context("Failed to emit final completion event")?;
                        stamp_terminal_event_id_if_any(
                            boot,
                            final_response.terminal_assistant_row_id,
                            &refs,
                        );
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::InjectMessage { message } => {
                eprintln!("[tenex-agent] Supervision nudge (no re-engage): {message}");
                if let Some((final_content, final_ral)) = pending_final {
                    let usage = Some(LlmUsage {
                        input_tokens: Some(stream_usage.input_tokens),
                        output_tokens: Some(stream_usage.output_tokens),
                        total_tokens: Some(stream_usage.total_tokens),
                        cached_input_tokens: Some(stream_usage.cached_input_tokens),
                        cache_creation_tokens: Some(stream_usage.cache_creation_input_tokens),
                        ..Default::default()
                    });
                    if boot.emit_state.has_pending_external_work()
                        || has_pending_delegations_in_store(boot)
                    {
                        let mut final_ctx = boot.emit_state.build_ctx(final_ral);
                        final_ctx.llm_runtime_ms = boot.emit_state.take_runtime_delta();
                        let intent = ConversationIntent {
                            content: final_content,
                            is_reasoning: false,
                            usage,
                            metadata: None,
                        };
                        let refs = boot
                            .channel
                            .send(Intent::Conversation(intent), &final_ctx)
                            .await
                            .context("Failed to emit pending-work conversation event")?;
                        stamp_terminal_event_id_if_any(
                            boot,
                            final_response.terminal_assistant_row_id,
                            &refs,
                        );
                    } else {
                        let final_ctx = boot.emit_state.build_completion_ctx(final_ral);
                        let intent = CompletionIntent {
                            content: final_content,
                            usage,
                            metadata: None,
                        };
                        let refs = boot
                            .channel
                            .send(Intent::Completion(intent), &final_ctx)
                            .await
                            .context("Failed to emit final completion event")?;
                        stamp_terminal_event_id_if_any(
                            boot,
                            final_response.terminal_assistant_row_id,
                            &refs,
                        );
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::ReEngage { message } => {
                // Persist the supervision nudge as a `role=user` row with
                // `message_type = "supervision"`. The next iteration's
                // projection picks it up the same way it would pick up a
                // real user message, and the loop reacts to it. The
                // terminal assistant from this iteration is already in
                // storage (via `record_step_assistant`), so projection
                // produces the correct ordering: prior steps + terminal
                // assistant + supervision nudge — no in-memory splice
                // required.
                let Some(store) = boot.conv_store.as_ref() else {
                    // Without a store the nudge has nowhere to go and the
                    // next iteration would re-project identical state,
                    // re-fire the same supervisor outcome, and loop
                    // forever. Hard-error rather than spinning until
                    // MAX_STUCK_ITERATIONS hides the configuration bug.
                    anyhow::bail!(
                        "supervision ReEngage requires a conversation store; \
                         re-engagement is unsupported in the no-store path"
                    );
                };
                persistence::record_supervision_nudge(boot, store, nudge_seq, &message)
                    .context("failed to persist supervision nudge")?;
                nudge_seq += 1;
                eprintln!("[tenex-agent] Supervision: pending todos — re-engaging...");
            }
        }
    }

    Ok(())
}

/// True iff at least one delegation in this conversation still has a
/// latest marker with `status = Pending`. Used as a cross-invocation
/// completion-suppression check: when this is true, the agent emits a
/// `ConversationIntent` (kind 1, no `status: completed` tag) instead of
/// a `CompletionIntent`, mirroring the TS rule that an agent with open
/// delegations may not declare itself complete.
///
/// Returns `false` when there's no store (test path) — the per-process
/// `EmitState.has_pending_external_work()` flag is the only signal in
/// that case.
fn has_pending_delegations_in_store(boot: &AgentBootstrap) -> bool {
    let Some(store) = boot.conv_store.as_ref() else {
        return false;
    };
    match store.latest_delegation_markers(&boot.conversation_id) {
        Ok(markers) => markers
            .values()
            .any(|m| matches!(m.status, tenex_conversations::DelegationStatus::Pending)),
        Err(e) => {
            eprintln!(
                "[tenex-agent] could not check pending delegation markers: {e} \
                 — defaulting to no-pending (may emit completion prematurely)"
            );
            false
        }
    }
}

/// Stamp the just-published Nostr event id onto the locally-persisted
/// step assistant row, so the runtime's own writeback (which materializes
/// the agent's stdout event with `nostr_event_id = Some(<hex>)`) finds
/// this row via the partial unique index and is a no-op. Without this
/// stamp, the runtime would insert a second row for the same content.
///
/// No-op when the agent has no conversation store, when the step had no
/// persisted row (shouldn't happen post-step-7 but defensive), or when
/// the channel returned no Nostr event refs (e.g. test channels).
fn stamp_terminal_event_id_if_any(
    boot: &AgentBootstrap,
    terminal_row_id: Option<i64>,
    refs: &[MessageRef],
) {
    let Some(row_id) = terminal_row_id else { return };
    let Some(store) = boot.conv_store.as_ref() else { return };
    let Some(MessageRef::Nostr { event_id }) = refs.iter().find(|r| matches!(r, MessageRef::Nostr { .. })) else {
        return;
    };
    if let Err(e) =
        persistence::reconcile_step_assistant_event_id(store, row_id, &event_id.to_hex())
    {
        eprintln!(
            "[tenex-agent] warn: failed to reconcile event_id {} on row {}: {e}",
            event_id.to_hex(),
            row_id
        );
    }
}

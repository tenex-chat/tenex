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
use rig::client::CompletionClient as _;
use rig::completion::Message as RigMessage;
use rig::providers::{anthropic, ollama, openai, openrouter};
use tenex_accounting::{
    RecordLlmCall, RootKind, finish_trace, flush as flush_accounting, open_trace, with_trace,
};
use tenex_context::Message as CtxMessage;
use tenex_protocol::{CompletionIntent, ConversationIntent, Intent, LlmUsage};
use tenex_supervision::supervisor::PostCompletionOutcome;
use tenex_supervision::types::{TodoEntry as SupTodoEntry, TodoStatus as SupTodoStatus};
use tracing::{Instrument, info_span};

use crate::agent_bootstrap::AgentBootstrap;
use crate::cassette_client::RecordingClient;
use crate::mock_llm;
use crate::oauth_client;
use crate::tools::{TodoStatus, ToolRecorder};

pub(crate) async fn run_turn_loop(boot: &mut AgentBootstrap) -> Result<()> {
    // current_message starts as the inbound user prompt; supervision may replace it with a
    // re-engagement prompt after each turn if pending todos remain.
    let mut current_message = std::mem::take(&mut boot.user_message);
    let mut re_engage_tail: Vec<CtxMessage> = Vec::new();
    let mut iteration: u64 = 0;

    'agent_loop: loop {
        iteration += 1;
        boot.suppress_response.store(false, Ordering::Release);

        // Fresh recorder per turn. RecordingTool clones forward into every
        // tool call so the inner loop's invocations all land here.
        let recorder = ToolRecorder::new();
        let tool_registry = boot.tool_set.build_for_turn(recorder.clone());
        let injected = boot.injection_tracker.lock().unwrap().take_new_messages();
        let turn_message = if let Some(ref injected) = injected {
            format!("{current_message}\n\n{injected}")
        } else {
            current_message.clone()
        };

        // Build a multipart prompt when the envelope contained images that were
        // successfully fetched. Images are prepended so vision providers see them
        // before the text (preferred order). This applies to every turn, including
        // re-engagement, so the original images remain visible as context.
        let turn_prompt: RigMessage = {
            use rig::OneOrMany;
            use rig::completion::message::{Text, UserContent};
            match &boot.envelope_image_parts {
                Some(image_parts) => {
                    let mut parts: Vec<UserContent> = image_parts.clone();
                    parts.push(UserContent::Text(Text {
                        text: turn_message.clone(),
                    }));
                    RigMessage::User {
                        content: OneOrMany::many(parts).unwrap_or_else(|_| {
                            OneOrMany::one(UserContent::Text(Text {
                                text: turn_message.clone(),
                            }))
                        }),
                    }
                }
                None => RigMessage::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: turn_message.clone(),
                    })),
                },
            }
        };

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
            let response = match resolved.provider.as_str() {
                "openrouter" => {
                    let key = resolved
                        .api_key
                        .clone()
                        .context("No OpenRouter API key available from LLM config")?;
                    let client = RecordingClient::new(
                        openrouter::Client::new(&key)?,
                        cassette_recorder.clone(),
                        "openrouter",
                    );
                    step::run_step_loop(
                        boot,
                        client.completion_model(resolved.model.clone()),
                        turn_prompt.clone(),
                        &turn_message,
                        &re_engage_tail,
                        tool_registry,
                        recorder.clone(),
                    )
                    .await?
                }
                "openai" => {
                    let key = resolved
                        .api_key
                        .clone()
                        .context("No OpenAI API key available from LLM config")?;
                    let client = RecordingClient::new(
                        openai::CompletionsClient::builder().api_key(&key).build()?,
                        cassette_recorder.clone(),
                        "openai",
                    );
                    step::run_step_loop(
                        boot,
                        client.completion_model(resolved.model.clone()),
                        turn_prompt.clone(),
                        &turn_message,
                        &re_engage_tail,
                        tool_registry,
                        recorder.clone(),
                    )
                    .await?
                }
                "ollama" => {
                    let mut builder = ollama::Client::builder().api_key(rig::client::Nothing);
                    if let Some(url) = &resolved.base_url {
                        builder = builder.base_url(url);
                    }
                    let client =
                        RecordingClient::new(builder.build()?, cassette_recorder.clone(), "ollama");
                    step::run_step_loop(
                        boot,
                        client.completion_model(resolved.model.clone()),
                        turn_prompt.clone(),
                        &turn_message,
                        &re_engage_tail,
                        tool_registry,
                        recorder.clone(),
                    )
                    .await?
                }
                "mock" => {
                    let client = RecordingClient::new(
                        mock_llm::MockClient::from_env(&agent_slug)?,
                        cassette_recorder.clone(),
                        "mock",
                    );
                    step::run_step_loop(
                        boot,
                        client.completion_model(resolved.model.clone()),
                        turn_prompt.clone(),
                        &turn_message,
                        &re_engage_tail,
                        tool_registry,
                        recorder.clone(),
                    )
                    .await?
                }
                _ => {
                    let key = resolved.api_key.clone().with_context(|| {
                        format!(
                            "No API key available from LLM config for provider '{}'",
                            resolved.provider
                        )
                    })?;
                    if oauth_client::is_oauth_token(&key) {
                        let http_client = oauth_client::build_oauth_http_client(&key);
                        let client = RecordingClient::new(
                            anthropic::Client::builder()
                                .api_key(&key)
                                .anthropic_betas(oauth_client::OAUTH_BETAS)
                                .http_client(http_client)
                                .build()?,
                            cassette_recorder.clone(),
                            "anthropic",
                        );
                        let model = client
                            .completion_model(resolved.model.clone())
                            .map_inner(|inner| inner.with_prompt_caching());
                        step::run_step_loop(
                            boot,
                            model,
                            turn_prompt.clone(),
                            &turn_message,
                            &re_engage_tail,
                            tool_registry,
                            recorder.clone(),
                        )
                        .await?
                    } else {
                        let client = RecordingClient::new(
                            anthropic::Client::new(&key)?,
                            cassette_recorder.clone(),
                            "anthropic",
                        );
                        let model = client
                            .completion_model(resolved.model.clone())
                            .map_inner(|inner| inner.with_prompt_caching());
                        step::run_step_loop(
                            boot,
                            model,
                            turn_prompt.clone(),
                            &turn_message,
                            &re_engage_tail,
                            tool_registry,
                            recorder.clone(),
                        )
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
                persistence::save_context_state(
                    store,
                    &boot.conversation_id,
                    &boot.pubkey_hex,
                    &final_todos,
                    &final_skills,
                );
            }
        }
        with_trace(
            accounting_trace.clone(),
            persistence::record_turn_accounting(
                boot,
                &current_message,
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
                boot.envelope_content.clone(),
            )
        };
        match outcome {
            PostCompletionOutcome::Accept => {
                let suppressed = boot.suppress_response.load(Ordering::Acquire);
                if let Some((final_content, final_ral)) = pending_final {
                    if !suppressed {
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if boot.emit_state.has_pending_external_work() {
                            let mut final_ctx = boot.emit_state.build_ctx(final_ral);
                            final_ctx.llm_runtime_ms = boot.emit_state.take_runtime_delta();
                            let intent = ConversationIntent {
                                content: final_content,
                                is_reasoning: false,
                                usage,
                                metadata: None,
                            };
                            boot.channel
                                .send(Intent::Conversation(intent), &final_ctx)
                                .await
                                .context("Failed to emit pending-work conversation event")?;
                        } else {
                            let final_ctx = boot.emit_state.build_completion_ctx(final_ral);
                            let intent = CompletionIntent {
                                content: final_content,
                                usage,
                                metadata: None,
                            };
                            boot.channel
                                .send(Intent::Completion(intent), &final_ctx)
                                .await
                                .context("Failed to emit final completion event")?;
                        }
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::InjectMessage { message } => {
                eprintln!("[tenex-agent] Supervision nudge (no re-engage): {message}");
                let suppressed = boot.suppress_response.load(Ordering::Acquire);
                if let Some((final_content, final_ral)) = pending_final {
                    if !suppressed {
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if boot.emit_state.has_pending_external_work() {
                            let mut final_ctx = boot.emit_state.build_ctx(final_ral);
                            final_ctx.llm_runtime_ms = boot.emit_state.take_runtime_delta();
                            let intent = ConversationIntent {
                                content: final_content,
                                is_reasoning: false,
                                usage,
                                metadata: None,
                            };
                            boot.channel
                                .send(Intent::Conversation(intent), &final_ctx)
                                .await
                                .context("Failed to emit pending-work conversation event")?;
                        } else {
                            let final_ctx = boot.emit_state.build_completion_ctx(final_ral);
                            let intent = CompletionIntent {
                                content: final_content,
                                usage,
                                metadata: None,
                            };
                            boot.channel
                                .send(Intent::Completion(intent), &final_ctx)
                                .await
                                .context("Failed to emit final completion event")?;
                        }
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::ReEngage { message } => {
                re_engage_tail = final_response.tail;
                current_message = message;
                eprintln!("[tenex-agent] Supervision: pending todos — re-engaging...");
            }
        }
    }

    Ok(())
}

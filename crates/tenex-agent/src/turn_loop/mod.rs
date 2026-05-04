//! Turn loop: drives the rig agent forward one turn at a time, persisting
//! results, then asking the supervisor whether to re-engage or stop.
//!
//! [`run_turn_loop`] takes the [`AgentBootstrap`] assembled by
//! [`crate::agent_bootstrap::build`] and consumes its mutable handles
//! (recorders, supervisor lock, runtime-state release_driver) until the
//! supervisor accepts the response. Loop-local working values
//! (`current_message`, accumulated `re_engage_history`) live as locals
//! here; everything else flows through `&mut AgentBootstrap`.

mod persistence;

use std::sync::atomic::Ordering;

use anyhow::{Context, Result};
use rig::completion::Message as RigMessage;
use rig::providers::{anthropic, ollama, openai, openrouter};
use tenex_protocol::{CompletionIntent, ConversationIntent, Intent, LlmUsage};
use tenex_supervision::supervisor::PostCompletionOutcome;
use tenex_supervision::types::{TodoEntry as SupTodoEntry, TodoStatus as SupTodoStatus};
use tracing::{info_span, Instrument};

use crate::agent_bootstrap::AgentBootstrap;
use crate::cassette_client::{RecordingClient, RecordingModel};
use crate::mock_llm;
use crate::oauth_client;
use crate::tools::{TodoStatus, ToolRecorder};

pub(crate) async fn run_turn_loop(boot: &mut AgentBootstrap) -> Result<()> {
    // current_message starts as the inbound user prompt; supervision may replace it with a
    // re-engagement prompt after each turn if pending todos remain.
    let mut current_message = std::mem::take(&mut boot.user_message);
    // extra history accumulated from re-engagement turns (user + assistant pairs).
    let mut re_engage_history: Vec<RigMessage> = Vec::new();
    let mut iteration: u64 = 0;

    'agent_loop: loop {
        iteration += 1;
        boot.suppress_response.store(false, Ordering::Release);
        let current_history: Vec<RigMessage> = {
            let mut h = boot.initial_history.clone();
            h.extend(re_engage_history.iter().cloned());
            h
        };

        // Fresh recorder per turn. RecordingTool clones forward into every
        // tool call so the inner loop's invocations all land here.
        let recorder = ToolRecorder::new();
        let tools = boot.tool_set.build_for_turn(recorder.clone());
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
            use rig::completion::message::{Text, UserContent};
            use rig::OneOrMany;
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
        let resolved = &boot.resolved;
        let cassette_recorder = &boot.cassette_recorder;
        let system_prompt = &boot.system_prompt;
        let hook = &boot.hook;
        let agent_slug = &boot.agent_slug;
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
                    run_agent!(
                        client,
                        &resolved.model,
                        system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
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
                    run_agent!(
                        client,
                        &resolved.model,
                        system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                "ollama" => {
                    let mut builder = ollama::Client::builder().api_key(rig::client::Nothing);
                    if let Some(url) = &resolved.base_url {
                        builder = builder.base_url(url);
                    }
                    let client =
                        RecordingClient::new(builder.build()?, cassette_recorder.clone(), "ollama");
                    run_agent!(
                        client,
                        &resolved.model,
                        system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                "mock" => {
                    let client = RecordingClient::new(
                        mock_llm::MockClient::from_env(agent_slug)?,
                        cassette_recorder.clone(),
                        "mock",
                    );
                    run_agent!(
                        client,
                        &resolved.model,
                        system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
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
                        run_agent!(
                            client,
                            &resolved.model,
                            system_prompt,
                            turn_prompt.clone(),
                            current_history,
                            hook.clone(),
                            tools,
                            |m: RecordingModel<
                                anthropic::completion::CompletionModel<
                                    reqwest_middleware::ClientWithMiddleware,
                                >,
                            >| m
                                .map_inner(|inner| inner.with_prompt_caching())
                        )
                    } else {
                        let client = RecordingClient::new(
                            anthropic::Client::new(&key)?,
                            cassette_recorder.clone(),
                            "anthropic",
                        );
                        run_agent!(
                            client,
                            &resolved.model,
                            system_prompt,
                            turn_prompt.clone(),
                            current_history,
                            hook.clone(),
                            tools,
                            |m: RecordingModel<anthropic::completion::CompletionModel>| {
                                m.map_inner(|inner| inner.with_prompt_caching())
                            }
                        )
                    }
                }
            };
            Ok::<_, anyhow::Error>(response)
        };
        let final_response = async move {
            match turn_body.await {
                Ok(v) => Ok(v),
                Err(e) => {
                    tenex_telemetry::record_current_error(&e);
                    Err(e)
                }
            }
        }
        .instrument(iteration_span)
        .await?;

        if let Some(state) = &boot.runtime_state {
            state.release_driver();
        }

        let recorded_calls = recorder.take_records();

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
            persistence::record_tool_messages(
                store,
                &boot.conversation_id,
                &boot.pubkey_hex,
                &recorded_calls,
            );
            persistence::record_turn_outcome(
                boot,
                store,
                &current_message,
                final_response.response(),
                &recorded_calls,
                &final_response.usage(),
            )
            .await;
        }

        eprintln!("[tenex-agent] Agent completed.");

        let stream_usage = final_response.usage();
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
            sup.check_post_completion(todos_snap, 0, boot.envelope_content.clone())
        };
        match outcome {
            PostCompletionOutcome::Accept => {
                let suppressed = boot.suppress_response.load(Ordering::Acquire);
                if let Some((final_content, final_ral)) = pending_final {
                    if !suppressed {
                        let final_ctx = boot.emit_state.build_ctx(final_ral);
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if boot.emit_state.has_pending_external_work() {
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
                        let final_ctx = boot.emit_state.build_ctx(final_ral);
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if boot.emit_state.has_pending_external_work() {
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
                use rig::completion::message::{Text, UserContent};
                use rig::completion::AssistantContent;
                use rig::OneOrMany;

                re_engage_history.push(RigMessage::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: current_message,
                    })),
                });
                re_engage_history.push(RigMessage::Assistant {
                    id: None,
                    content: OneOrMany::one(AssistantContent::Text(Text {
                        text: final_response.response().to_string(),
                    })),
                });
                current_message = message;
                eprintln!("[tenex-agent] Supervision: pending todos — re-engaging...");
            }
        }
    }

    Ok(())
}

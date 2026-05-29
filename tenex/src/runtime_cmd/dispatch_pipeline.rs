//! Dispatch entry points: every code path that turns a Nostr event into a
//! `DispatchJob` and feeds it into the coordinator funnels through this
//! module.
//!
//! - [`accept_dispatch`] is the single dispatch funnel — freezes the
//!   conversation trace root, syncs persisted driver state, then either
//!   starts the job immediately via `spawn_dispatch_job` or queues it.
//!   Callers MUST `persist_user_message` before invoking; the funnel
//!   assumes the inbound event is already in the conversation store.
//! - [`handle_transport_dispatch`] handles synthesized events from the
//!   control socket (telegram bridge etc).
//! - [`run_external_dispatch`] runs firewall screening for events from
//!   pubkeys outside the trusted-author set, then dispatches on pass.
//! - [`handle_stop_command`] sets the per-agent blocked flag and kills any
//!   live runs on the matched (conversation, agent) keys.
//! - [`publish_active_status`], [`persist_user_message`], and
//!   [`send_operations_status`] are dispatch-adjacent helpers used here and
//!   from `agent_subprocess::spawn_dispatch_job` (for `publish_active_status`).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use nostr::JsonUtil;
use nostr_sdk::prelude::*;
use opentelemetry::baggage::BaggageExt;
use opentelemetry::{Context as OtelContext, KeyValue};
use tracing::{info, warn};

use tenex_conversations::{ConversationStore, NewMessage};

use super::agent_config_reload::{
    handle_agent_config_update, handle_project_definition_update, RuntimeReloadContext,
};
use super::agent_subprocess::{spawn_dispatch_job, DispatchJob};
use super::dispatch_coordinator::DispatchKey;
use tenex_protocol::event_filter::conversation_id_from_event;

use super::event_routing::{
    event_matches_project_scope, mark_seen, p_tag_pubkeys, select_dispatch_target,
    targets_project_agent, NotForRuntime,
};
use super::runtime_state_store::{
    clear_agent_blocked, conversation_trace_root, is_agent_blocked, persisted_driver_busy,
    register_delegation_route_if_needed, remember_conversation_trace_root, set_agent_blocked,
};
use super::{control, RuntimeShared, PROJECT_KIND};
use crate::nostr_pub::operations_status;

/// Drive a single relay-delivered event through the runtime: classify it
/// (admin vs scoped-conversation vs out-of-scope), parent its
/// `tenex.daemon.event_received` span under the conversation's persistent
/// trace root, and dispatch to the appropriate handler.
///
/// All `continue` branches in the previous inline relay loop become early
/// `return` here. The caller's `tokio::select!` arm just calls this
/// function and moves on.
pub(super) async fn handle_relay_event(
    shared: &Arc<RuntimeShared>,
    event: Box<Event>,
    reload_context: &RuntimeReloadContext<'_>,
    base_dir: &std::path::Path,
) {
    use tracing::{info_span, Instrument};
    use tracing_opentelemetry::OpenTelemetrySpanExt;

    // For conversation-bearing events, parent the ingress span under this
    // conversation's persistent root (set on the first turn, frozen
    // thereafter). Admin events (project / stop / agent-config) get fresh
    // roots — they're not part of any conversation.
    let is_admin_event = event.kind == Kind::Custom(PROJECT_KIND)
        || event.kind == Kind::Custom(tenex_protocol::nostr::kinds::STOP_COMMAND)
        || event.kind == Kind::Custom(tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE);
    let conversation_root_carrier = if is_admin_event {
        None
    } else {
        let conv_id = conversation_id_from_event(&event);
        conversation_trace_root(&shared.store, &conv_id)
    };

    let event_received_span = info_span!(
        "tenex.daemon.event_received",
        event.id = %event.id.to_hex(),
        event.kind = event.kind.as_u16(),
        event.pubkey = %event.pubkey.to_hex(),
        is_external = tracing::field::Empty,
        outcome = tracing::field::Empty,
    );
    if let Some(parent_ctx) = conversation_root_carrier
        .as_ref()
        .and_then(tenex_telemetry::extract)
    {
        if let Err(err) = event_received_span.set_parent(parent_ctx) {
            warn!(
                error = %err,
                "failed to parent event_received under conversation root",
            );
        }
    }

    process_relay_event_inner(
        shared,
        event,
        reload_context,
        base_dir,
        &event_received_span,
    )
    .instrument(event_received_span.clone())
    .await;
}

async fn process_relay_event_inner(
    shared: &Arc<RuntimeShared>,
    event: Box<Event>,
    reload_context: &RuntimeReloadContext<'_>,
    base_dir: &std::path::Path,
    event_received_span: &tracing::Span,
) {
    if !mark_seen(&shared.seen, event.id) {
        event_received_span.record("outcome", "dropped_scope");
        return;
    }
    if event.kind == Kind::Custom(PROJECT_KIND) {
        event_received_span.record("outcome", "project_definition_update");
        if let Err(e) = handle_project_definition_update(shared, reload_context, &event).await {
            tenex_telemetry::record_current_error(&e);
            warn!(event_id = %tenex_utils::ids::shorten_full_event_id(&event.id.to_hex()), error = %e, "project definition update failed");
        }
        return;
    }
    if event.kind == Kind::Custom(tenex_protocol::nostr::kinds::STOP_COMMAND) {
        event_received_span.record("outcome", "stop_command");
        if let Err(e) = handle_stop_command(shared.clone(), &event).await {
            tenex_telemetry::record_current_error(&e);
            warn!(event_id = %tenex_utils::ids::shorten_full_event_id(&event.id.to_hex()), error = %e, "stop command failed");
        }
        return;
    }
    if event.kind == Kind::Custom(tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE) {
        event_received_span.record("outcome", "agent_config_update");
        if let Err(e) = handle_agent_config_update(shared, reload_context, &event).await {
            tenex_telemetry::record_current_error(&e);
            warn!(event_id = %tenex_utils::ids::shorten_full_event_id(&event.id.to_hex()), error = %e, "agent config update failed");
        }
        return;
    }
    if !event_matches_project_scope(&event, &shared.project_addr) {
        event_received_span.record("outcome", "dropped_scope");
        return;
    }
    let agent_pubkeys = shared.agent_pubkeys();
    if agent_pubkeys.contains(&event.pubkey.to_hex())
        && !targets_project_agent(&event, &agent_pubkeys)
    {
        event_received_span.record("outcome", "dropped_scope");
        return;
    }
    let short_id = tenex_utils::ids::shorten_full_event_id(&event.id.to_hex());
    let short = short_id.as_str();
    tracing::event!(
        parent: event_received_span,
        tracing::Level::INFO,
        event_id = short,
        "received event",
    );

    // Author classification. Trusted system authors and project agents take
    // the existing dispatch path. Anything else is "external": the project
    // filter dropped its `authors` gate so these reach us via the `#a` tag
    // claim. We persist them into the conversation store so they can ground
    // future whitelisted-user replies, then either drop them (config off)
    // or run them through the firewall.
    //
    // `author_is_remote_agent` distinguishes a third class: an event signed
    // by a project agent whose nsec lives on a *different* backend. Those
    // are still trusted (they're members of the project), but the recipient
    // must know the requester does not share a filesystem with it.
    let author_hex = event.pubkey.to_hex();
    let author_trusted = shared.trusted_author_pubkeys.contains(&author_hex);
    let author_is_agent = agent_pubkeys.contains(&author_hex);
    let author_is_remote_agent =
        !author_is_agent && shared.project_member_pubkeys().contains(&author_hex);
    let is_external = !author_trusted && !author_is_agent && !author_is_remote_agent;
    event_received_span.record("is_external", is_external);

    if is_external {
        if !tenex_protocol::event_filter::is_conversation_event(&event) {
            // Drop tool/intent/reasoning/error head-tagged events from
            // external authors entirely. We don't trust unauthorized
            // parties to forge structured runtime signals.
            event_received_span.record("outcome", "dropped_external_non_conversation");
            return;
        }
        let conv_id = conversation_id_from_event(&event);
        if let Err(e) = persist_user_message(&shared.store, &event, &conv_id) {
            tenex_telemetry::record_current_error(&e);
            event_received_span.record("outcome", "dropped_scope");
            warn!(event_id = short, error = %e, "external persist failed");
            return;
        }
        if !shared.route_unauthorized_authors {
            event_received_span.record("outcome", "dropped_external_disabled");
            tracing::event!(
                parent: event_received_span,
                tracing::Level::INFO,
                event_id = short,
                author = %tenex_utils::pubkey::shorten_for_display(&author_hex),
                "external author persisted; routeUnauthorizedAuthors=false",
            );
            return;
        }
        // The firewall LLM call can take up to 15s. Run the firewall +
        // dispatch flow in a spawned task so the relay event loop keeps
        // draining.
        event_received_span.record("outcome", "external_dispatched");
        tokio::spawn(run_external_dispatch(
            shared.clone(),
            event,
            agent_pubkeys.clone(),
        ));
        return;
    }

    if let Err(e) = register_delegation_route_if_needed(&shared.store, &event, &agent_pubkeys, None)
    {
        warn!(event_id = short, error = %e, "failed to register delegation route");
    }
    match select_dispatch_target(shared, &event) {
        Ok((agent, conv_id, completion_recipient_pubkey)) => {
            if let Err(e) = persist_user_message(&shared.store, &event, &conv_id) {
                tenex_telemetry::record_current_error(&e);
                event_received_span.record("outcome", "dropped_persist_failed");
                warn!(event_id = short, error = %e, "trusted persist failed");
                return;
            }
            // Baggage scope is the synchronous block that builds the
            // `DispatchJob`. The carrier captures the trace context here;
            // baggage is re-attached on the dispatch span's parent context
            // inside `spawn_dispatch_job`, which is what survives the
            // `tokio::spawn` boundary and propagates to the spawned child
            // agent. The `ContextGuard` is `!Send`, so it must be dropped
            // before the `.await` on `accept_dispatch`.
            let job = {
                let _baggage_guard = OtelContext::current()
                    .with_baggage([
                        KeyValue::new("conversation.id", conv_id.clone()),
                        KeyValue::new("project.id", shared.project_id.clone()),
                    ])
                    .attach();
                tracing::event!(
                    parent: event_received_span,
                    tracing::Level::INFO,
                    event_id = short,
                    agent = %agent.slug,
                    conversation_id = %conv_id,
                    is_external,
                    "dispatching",
                );
                if author_trusted {
                    if let Err(e) = clear_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
                        warn!(event_id = short, error = %e, "failed to clear agent block");
                    }
                }
                if is_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
                    event_received_span.record("outcome", "dropped_blocked");
                    tracing::event!(
                        parent: event_received_span,
                        tracing::Level::WARN,
                        event_id = short,
                        agent = %agent.slug,
                        conversation_id = %conv_id,
                        "agent is blocked in conversation",
                    );
                    return;
                }
                let agent_json = base_dir
                    .join("agents")
                    .join(format!("{}.json", agent.pubkey));
                let trace_carrier = tenex_telemetry::inject_current();
                DispatchJob {
                    event: *event,
                    agent: agent.clone(),
                    conv_id,
                    agent_json,
                    allow_driver_preempt: false,
                    completion_recipient_pubkey,
                    is_external,
                    is_remote_agent: author_is_remote_agent,
                    response_tee: None,
                    trace_carrier,
                }
            };
            event_received_span.record("outcome", "dispatched");
            if let Err(e) = accept_dispatch(shared.clone(), job).await {
                tenex_telemetry::record_current_error(&e);
                warn!(event_id = short, agent = %agent.slug, error = %e, "dispatch failed");
            }
        }
        Err(e) => {
            // No local handler for this trusted event — persist it anyway
            // so the conversation store reflects everything we observed
            // on the project's #a thread, not just turns we ran ourselves.
            // Future local-agent turns and the embedder backfill rely on
            // this completeness.
            let conv_id = conversation_id_from_event(&event);
            if let Err(perr) = persist_user_message(&shared.store, &event, &conv_id) {
                tenex_telemetry::record_current_error(&perr);
                warn!(event_id = short, error = %perr, "no-target persist failed");
            }
            event_received_span.record("outcome", "persisted_no_target");
            if e.downcast_ref::<NotForRuntime>().is_none() {
                tenex_telemetry::record_current_error(&e);
            }
            tracing::event!(
                parent: event_received_span,
                tracing::Level::INFO,
                event_id = short,
                conversation_id = %conv_id,
                error = %e,
                "no dispatch target; persisted for context",
            );
        }
    }
}

/// Handle a `DispatchTransport` request that arrived on the control socket.
///
/// Parses the synthesized event, runs `select_dispatch_target`, attaches the
/// caller's `TransportTee` to the resulting `DispatchJob`, and feeds it into
/// the same `accept_dispatch` path as a relay-originated event. Terminal
/// frames are emitted on the tee for any error path; on success, the tee
/// rides through to `run_agent` which fires `Event` frames per agent output
/// and a final `Done`/`Error` when the run exits.
pub(super) async fn handle_transport_dispatch(
    shared: Arc<RuntimeShared>,
    req: control::TransportDispatchRequest,
) {
    let control::TransportDispatchRequest { event_json, tee } = req;
    let event = match Event::from_json(&event_json) {
        Ok(ev) => ev,
        Err(e) => {
            tee.send_error(format!("invalid event JSON: {e}"));
            return;
        }
    };

    if !mark_seen(&shared.seen, event.id) {
        tee.send_error("event already dispatched in this runtime".to_string());
        return;
    }

    let agent_pubkeys = shared.agent_pubkeys();
    if let Err(e) = register_delegation_route_if_needed(&shared.store, &event, &agent_pubkeys, None)
    {
        warn!(error = %e, "failed to register delegation route for transport dispatch");
    }

    let (agent, conv_id, completion_recipient_pubkey) =
        match select_dispatch_target(&shared, &event) {
            Ok(target) => target,
            Err(e) => {
                tee.send_error(format!("no dispatch target: {e}"));
                return;
            }
        };

    if let Err(e) = clear_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
        warn!(error = %e, "failed to clear agent block on transport dispatch");
    }

    if let Err(e) = persist_user_message(&shared.store, &event, &conv_id) {
        tee.send_error(format!("persist failed: {e}"));
        return;
    }

    tee.send_accepted(conv_id.clone(), agent.pubkey.clone());

    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    // Baggage scope is the synchronous block that builds the `DispatchJob`.
    // The `ContextGuard` is `!Send`, so it must be dropped before the
    // `.await` on `accept_dispatch`. `spawn_dispatch_job` re-attaches the
    // baggage on the dispatch span's parent context for cross-spawn
    // propagation.
    let job = {
        let _baggage_guard = OtelContext::current()
            .with_baggage([
                KeyValue::new("conversation.id", conv_id.clone()),
                KeyValue::new("project.id", shared.project_id.clone()),
            ])
            .attach();
        let trace_carrier = tenex_telemetry::inject_current();
        DispatchJob {
            event,
            agent,
            conv_id,
            agent_json,
            allow_driver_preempt: false,
            completion_recipient_pubkey,
            // Transport-bridged events (telegram, etc.) come through
            // already-authenticated paths — never marked external.
            is_external: false,
            is_remote_agent: false,
            response_tee: Some(tee.clone()),
            trace_carrier,
        }
    };
    if let Err(e) = accept_dispatch(shared, job).await {
        // Job is dropped here without ever reaching `run_agent`. Mark the
        // tee terminal explicitly with an Error frame so the bridge sees
        // an accurate reason rather than the default `Superseded` that
        // `TransportTeeInner::Drop` would otherwise emit.
        let msg = format!("dispatch failed: {e}");
        warn!(error = %e, "transport dispatch failed");
        tee.send_error(msg);
    }
}

/// Runs firewall screening and (on pass) dispatch for an external-author
/// event. Always invoked from a `tokio::spawn` so the firewall LLM latency
/// never blocks the relay event loop.
pub(super) async fn run_external_dispatch(
    shared: Arc<RuntimeShared>,
    event: Box<Event>,
    agent_pubkeys: HashSet<String>,
) {
    let event_id_hex = event.id.to_hex();
    let short_id = tenex_utils::ids::shorten_full_event_id(&event_id_hex);
    let short = short_id.as_str();
    let author_hex = event.pubkey.to_hex();
    let author_short = tenex_utils::pubkey::shorten_for_display(&author_hex);

    let firewall_ctx = tenex_firewall::ProjectContext {
        title: shared.project_title.as_str(),
        d_tag: shared.project_id.as_str(),
    };
    println!(
        "[firewall] checking event {event_id_hex} from {author_short}: {}",
        event.content.chars().take(120).collect::<String>()
    );
    match tenex_firewall::check(&shared.base_dir, firewall_ctx, &event.content).await {
        tenex_firewall::Verdict::Safe => {
            println!("[firewall] SAFE event {event_id_hex} from {author_short}");
        }
        tenex_firewall::Verdict::Unsafe { reason } => {
            println!("[firewall] UNSAFE event {event_id_hex} from {author_short}: {reason}");
            warn!(
                event_id = short,
                author = %author_short,
                reason = %reason,
                "firewall rejected external event"
            );
            return;
        }
    }

    if let Err(e) = register_delegation_route_if_needed(&shared.store, &event, &agent_pubkeys, None)
    {
        warn!(event_id = short, error = %e, "failed to register delegation route");
    }
    match select_dispatch_target(&shared, &event) {
        Ok((agent, conv_id, completion_recipient_pubkey)) => {
            info!(
                event_id = short,
                agent = %agent.slug,
                conversation_id = %conv_id,
                is_external = true,
                "dispatching"
            );
            if is_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
                warn!(
                    event_id = short,
                    agent = %agent.slug,
                    conversation_id = %conv_id,
                    "agent is blocked in conversation"
                );
                return;
            }
            let agent_json = shared
                .base_dir
                .join("agents")
                .join(format!("{}.json", agent.pubkey));
            // Baggage scope is the synchronous block that builds the
            // `DispatchJob`. `ContextGuard` is `!Send` and so must be
            // dropped before the `.await` on `accept_dispatch`.
            let job = {
                let _baggage_guard = OtelContext::current()
                    .with_baggage([
                        KeyValue::new("conversation.id", conv_id.clone()),
                        KeyValue::new("project.id", shared.project_id.clone()),
                    ])
                    .attach();
                let trace_carrier = tenex_telemetry::inject_current();
                DispatchJob {
                    event: *event,
                    agent: agent.clone(),
                    conv_id,
                    agent_json,
                    allow_driver_preempt: false,
                    completion_recipient_pubkey,
                    is_external: true,
                    is_remote_agent: false,
                    response_tee: None,
                    trace_carrier,
                }
            };
            if let Err(e) = accept_dispatch(shared, job).await {
                warn!(event_id = short, agent = %agent.slug, error = %e, "dispatch failed");
            }
        }
        Err(e) => {
            warn!(event_id = short, error = %e, "no dispatch target");
        }
    }
}

pub(super) async fn accept_dispatch(
    shared: Arc<RuntimeShared>,
    mut job: DispatchJob,
) -> Result<()> {
    if let Some(carrier) = job.trace_carrier.as_ref() {
        if let Err(err) = remember_conversation_trace_root(&shared.store, &job.conv_id, carrier) {
            warn!(
                error = %err,
                conversation_id = %job.conv_id,
                "failed to persist conversation trace root",
            );
        }
    }
    if is_agent_blocked(&shared.store, &job.conv_id, &job.agent.pubkey) {
        warn!(
            conversation_id = %job.conv_id,
            agent = %job.agent.slug,
            "skipping dispatch to blocked agent"
        );
        return Ok(());
    }
    let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
    let driver_busy = persisted_driver_busy(&shared.store, &key);
    // ACP-runtime agents share one persistent child per (agent, conversation);
    // mid-turn inbound events must reach that child immediately so the ACP
    // backend can inject them into the running stream. Bypass the
    // coordinator's tenex-style queueing for ACP and never block on
    // `driver_busy`.
    let runtime_is_acp = matches!(
        super::agent_subprocess::agent_runtime_kind(&job.agent, &shared.base_dir),
        Ok(super::agent_subprocess::AgentRuntimeKind::Acp),
    );
    let maybe_start = {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.sync_driver_busy(&key, driver_busy);
        let allow_shell_intervention = shared
            .whitelisted_pubkeys
            .contains(&job.event.pubkey.to_hex())
            && shared
                .control
                .has_shell_tasks(&shared.project_id, &job.conv_id, &job.agent.pubkey);
        job.allow_driver_preempt = allow_shell_intervention;
        coordinator.dispatch_inbound(job, allow_shell_intervention || runtime_is_acp)
    };

    if let Some(job) = maybe_start {
        publish_active_status(&shared, &job.conv_id).await;
        spawn_dispatch_job(shared, job);
    }
    Ok(())
}

pub(super) async fn handle_stop_command(shared: Arc<RuntimeShared>, event: &Event) -> Result<()> {
    let has_e_tag = event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == "e"));
    let agent_pubkeys = p_tag_pubkeys(event);
    if !has_e_tag || agent_pubkeys.is_empty() {
        warn!(
            event_id = %tenex_utils::ids::shorten_full_event_id(&event.id.to_hex()),
            has_e_tag,
            p_tags = agent_pubkeys.len(),
            "stop command missing target tags"
        );
        return Ok(());
    }

    let conversation_id = conversation_id_from_event(event);
    let reason = format!("stop signal from {}", tenex_utils::pubkey::shorten_for_display(&event.pubkey.to_hex()));
    for agent_pubkey in &agent_pubkeys {
        set_agent_blocked(&shared.store, &conversation_id, agent_pubkey)?;
        let result =
            shared
                .control
                .kill_agent_conversation(&conversation_id, Some(agent_pubkey), &reason);
        info!(
            conversation_id = %conversation_id,
            agent_pubkey = %agent_pubkey,
            killed_count = result.killed_count,
            "processed stop command"
        );
    }
    publish_active_status(&shared, &conversation_id).await;
    Ok(())
}

pub(super) async fn publish_active_status(shared: &RuntimeShared, conv_id: &str) {
    let active = {
        let coordinator = shared.coordinator.lock().unwrap();
        coordinator.active_agent_pubkeys_for_conversation(conv_id)
    };
    let refs: Vec<&str> = active.iter().map(String::as_str).collect();
    info!(
        conversation_id = conv_id,
        active_agents = ?refs,
        "publishing 24133 operations status"
    );
    send_operations_status(
        &shared.client,
        &shared.backend_keys,
        conv_id,
        &shared.project_addr,
        &shared.whitelisted_pubkeys,
        &refs,
    )
    .await;
}

pub(super) fn persist_user_message(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
    conv_id: &str,
) -> Result<()> {
    let ts = event.created_at.as_secs() as i64;
    let targeted_pubkeys = p_tag_pubkeys(event);
    let s = store.lock().unwrap();
    s.ensure_conversation(conv_id)?;
    s.append_message(
        conv_id,
        &NewMessage {
            record_id: format!("event:{}", event.id.to_hex()),
            nostr_event_id: Some(event.id.to_hex()),
            author_pubkey: event.pubkey.to_hex(),
            sender_pubkey: None,
            ral: None,
            message_type: "text".to_string(),
            role: Some("user".to_string()),
            content: event.content.clone(),
            timestamp: Some(ts),
            targeted_pubkeys: if targeted_pubkeys.is_empty() {
                None
            } else {
                Some(targeted_pubkeys)
            },
            sender_principal: None,
            targeted_principals: None,
            tool_data: None,
            delegation_marker: None,
            human_readable: None,
            transcript_tool_attributes: None,
        },
    )?;
    Ok(())
}

pub(super) async fn send_operations_status(
    client: &Client,
    backend_keys: &Keys,
    conv_id: &str,
    project_ref: &str,
    whitelisted_pubkeys: &[String],
    active_agent_pubkeys: &[&str],
) {
    match operations_status::build_operations_status_event(
        backend_keys,
        conv_id,
        project_ref,
        whitelisted_pubkeys,
        active_agent_pubkeys,
    ) {
        Ok(ev) => {
            if let Err(e) = client.send_event(&ev).await {
                warn!(error = %e, "24133 publish failed");
            }
        }
        Err(e) => warn!(error = %e, "24133 build failed"),
    }
}

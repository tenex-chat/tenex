//! Persistent runtime-state helpers backed by the conversation store's
//! `runtime_state` JSON. Holds three families of state:
//!
//! - **Delegation routes** — links a child conversation back to the parent
//!   agent/conversation/recipient that triggered the delegation, so a
//!   completion event can be routed back to the parent's context.
//! - **Trace roots** — the W3C trace carrier captured on the first turn of
//!   a conversation, frozen so every subsequent turn parents under the same
//!   root and renders as a single Jaeger trace.
//! - **Driver state & blocking** — persisted `driver` record (`acquiredAt`
//!   freshness gate via [`DRIVER_STALE_AFTER_MS`]) plus the per-agent
//!   `is_blocked` flag set by `stop` commands.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::info;

use tenex_conversations::{AgentContextState, ConversationStore, MessageQuery};

use super::agent_subprocess::DispatchJob;
use super::dispatch_coordinator::DispatchKey;
use tenex_protocol::event_filter::conversation_id_from_event;

use super::event_routing::{has_any_tag, p_tag_pubkeys};

pub(super) const DRIVER_STALE_AFTER_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DelegationRoute {
    pub(super) parent_agent_pubkey: String,
    pub(super) parent_conversation_id: String,
    pub(super) parent_completion_recipient_pubkey: String,
    pub(super) child_agent_pubkey: String,
    pub(super) child_conversation_id: String,
    pub(super) delegation_event_id: String,
    pub(super) created_at: i64,
}

pub(super) fn register_delegation_route_if_needed(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
    agent_pubkeys: &HashSet<String>,
    parent_job: Option<&DispatchJob>,
) -> Result<Option<DelegationRoute>> {
    let allow_external_child =
        parent_job.is_some_and(|job| event.pubkey.to_hex() == job.agent.pubkey);
    let Some(child_agent_pubkey) =
        fresh_delegation_target(event, agent_pubkeys, allow_external_child)
    else {
        return Ok(None);
    };

    let parent_agent_pubkey = parent_job
        .map(|job| job.agent.pubkey.clone())
        .unwrap_or_else(|| event.pubkey.to_hex());
    let parent_conversation_id = parent_job
        .map(|job| job.conv_id.clone())
        .or_else(|| delegation_parent_conversation_id(event));
    let Some(parent_conversation_id) = parent_conversation_id else {
        return Ok(None);
    };
    let parent_completion_recipient_pubkey = parent_job
        .and_then(|job| job.completion_recipient_pubkey.clone())
        .or_else(|| parent_job.map(|job| job.event.pubkey.to_hex()))
        .or_else(|| {
            first_conversation_author(store, &parent_conversation_id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| parent_agent_pubkey.clone());

    let child_conversation_id = event.id.to_hex();
    let route = DelegationRoute {
        parent_agent_pubkey,
        parent_conversation_id,
        parent_completion_recipient_pubkey,
        child_agent_pubkey,
        child_conversation_id: child_conversation_id.clone(),
        delegation_event_id: child_conversation_id.clone(),
        created_at: super::runtime_setup::now_ms(),
    };

    {
        let mut store = store.lock().unwrap();
        store.update_runtime_state(&child_conversation_id, |state| {
            write_delegation_route(state, &route);
        })?;
    }

    info!(
        parent_agent = %route.parent_agent_pubkey,
        parent_conversation = %route.parent_conversation_id,
        child_agent = %route.child_agent_pubkey,
        child_conversation = %route.child_conversation_id,
        "registered delegation route"
    );

    Ok(Some(route))
}

fn fresh_delegation_target(
    event: &Event,
    agent_pubkeys: &HashSet<String>,
    allow_external_child: bool,
) -> Option<String> {
    if event.kind != Kind::TextNote {
        return None;
    }
    if !agent_pubkeys.contains(&event.pubkey.to_hex()) {
        return None;
    }
    if has_any_tag(event, "e")
        || has_any_tag(event, "tool")
        || has_any_tag(event, "status")
        || has_any_tag(event, "intent")
        || has_any_tag(event, "reasoning")
        || has_any_tag(event, "error")
    {
        return None;
    }
    let targets = p_tag_pubkeys(event);
    if allow_external_child {
        targets.into_iter().next()
    } else {
        targets
            .into_iter()
            .find(|pubkey| agent_pubkeys.contains(pubkey))
    }
}

/// Identify a reply from the delegated child agent that should resume the
/// parent agent in the parent conversation. Identity is established by the
/// triple (`route exists for this conversation`, `author == registered child`,
/// `parent agent in p-tags`); no out-of-band marker tag is required.
///
/// Routing semantics: every matching child reply pops the parent back to the
/// parent conversation context with the child's reply as input. To continue
/// the dialogue with the child after that, the parent posts another message
/// targeting the child in the delegation thread (or delegates again).
pub(super) fn delegation_route_for_child_reply(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
) -> Result<Option<DelegationRoute>> {
    if event.kind != Kind::TextNote {
        return Ok(None);
    }
    // A delegation event starts a new task — it cannot be a child reply.
    // Without this guard, when delegator and delegatee share the same pubkey
    // (same agent in two projects), the delegation event matches its own
    // freshly-registered route and gets dispatched into the parent
    // conversation instead of opening the new delegation thread.
    if has_any_tag(event, "delegation") {
        return Ok(None);
    }

    let child_conversation_id = conversation_id_from_event(event);
    let Some(route) = read_delegation_route(store, &child_conversation_id)? else {
        return Ok(None);
    };
    if route.child_conversation_id != child_conversation_id {
        return Ok(None);
    }
    if event.pubkey.to_hex() != route.child_agent_pubkey {
        return Ok(None);
    }
    if !p_tag_pubkeys(event).contains(&route.parent_agent_pubkey) {
        return Ok(None);
    }

    Ok(Some(route))
}

fn read_delegation_route(
    store: &Arc<Mutex<ConversationStore>>,
    child_conversation_id: &str,
) -> Result<Option<DelegationRoute>> {
    let store = store.lock().unwrap();
    let Some(conversation) = store.get_conversation(child_conversation_id)? else {
        return Ok(None);
    };
    Ok(delegation_route_from_runtime_state(
        &conversation.runtime_state,
    ))
}

fn delegation_route_from_runtime_state(state: &Value) -> Option<DelegationRoute> {
    serde_json::from_value(state.get("rustRuntime")?.get("delegation")?.clone()).ok()
}

fn write_delegation_route(state: &mut Value, route: &DelegationRoute) {
    let state = ensure_json_object(state);
    let rust_runtime = ensure_child_object(state, "rustRuntime");
    rust_runtime.insert(
        "delegation".to_string(),
        serde_json::to_value(route).unwrap_or_else(|_| Value::Object(Map::new())),
    );
}

fn delegation_parent_conversation_id(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.first().is_some_and(|head| head == "delegation") {
            parts.get(1).cloned()
        } else {
            None
        }
    })
}

/// Read the persisted root trace carrier for a conversation. Set once on the
/// first turn that reaches `accept_dispatch`; every subsequent turn parents
/// its `tenex.daemon.event_received` span under this carrier so all turns of
/// one conversation share a `trace_id` and render as one Jaeger trace.
pub(super) fn conversation_trace_root(
    store: &Arc<Mutex<ConversationStore>>,
    conv_id: &str,
) -> Option<tenex_telemetry::TraceCarrier> {
    let store = store.lock().unwrap();
    let conversation = store.get_conversation(conv_id).ok().flatten()?;
    trace_root_from_runtime_state(&conversation.runtime_state)
}

fn trace_root_from_runtime_state(state: &Value) -> Option<tenex_telemetry::TraceCarrier> {
    let root = state
        .get("rustRuntime")?
        .get("telemetry")?
        .get("trace_root")?;
    let traceparent = root.get("traceparent")?.as_str()?.to_string();
    let tracestate = root
        .get("tracestate")
        .and_then(|v| v.as_str())
        .map(String::from);
    let baggage = root
        .get("baggage")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(tenex_telemetry::TraceCarrier {
        traceparent,
        tracestate,
        baggage,
    })
}

/// Persist the root trace carrier for this conversation if and only if no
/// carrier has been written yet. Subsequent calls are no-ops, freezing the
/// first turn's `tenex.daemon.event_received` as the conversation's trace
/// anchor. The atomic absent-check + write happens under the conversation
/// store's mutex inside `update_runtime_state`.
pub(super) fn remember_conversation_trace_root(
    store: &Arc<Mutex<ConversationStore>>,
    conv_id: &str,
    carrier: &tenex_telemetry::TraceCarrier,
) -> Result<()> {
    let mut store = store.lock().unwrap();
    store.update_runtime_state(conv_id, |state| {
        write_trace_root_if_absent(state, carrier);
    })?;
    Ok(())
}

fn write_trace_root_if_absent(state: &mut Value, carrier: &tenex_telemetry::TraceCarrier) {
    let state = ensure_json_object(state);
    let rust_runtime = ensure_child_object(state, "rustRuntime");
    let telemetry = ensure_child_object(rust_runtime, "telemetry");
    if telemetry.contains_key("trace_root") {
        return;
    }
    let mut entry = Map::new();
    entry.insert(
        "traceparent".to_string(),
        Value::String(carrier.traceparent.clone()),
    );
    if let Some(tracestate) = carrier.tracestate.as_ref() {
        entry.insert("tracestate".to_string(), Value::String(tracestate.clone()));
    }
    if let Some(baggage) = carrier.baggage.as_ref() {
        entry.insert("baggage".to_string(), Value::String(baggage.clone()));
    }
    telemetry.insert("trace_root".to_string(), Value::Object(entry));
}

pub(super) fn first_conversation_author(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
) -> Result<Option<String>> {
    let store = store.lock().unwrap();
    Ok(store
        .list_messages(
            conversation_id,
            MessageQuery {
                limit: Some(1),
                ..Default::default()
            },
        )?
        .into_iter()
        .next()
        .map(|message| message.author_pubkey))
}

pub(super) fn persisted_driver_busy(
    store: &Arc<Mutex<ConversationStore>>,
    key: &DispatchKey,
) -> bool {
    let Ok(conversation) = store.lock().unwrap().get_conversation(&key.conversation_id) else {
        return false;
    };
    let Some(conversation) = conversation else {
        return false;
    };
    runtime_state_driver_busy(&conversation.runtime_state, key)
}

fn runtime_state_driver_busy(state: &Value, key: &DispatchKey) -> bool {
    let Some(driver) = state.get("rustRuntime").and_then(|v| v.get("driver")) else {
        return false;
    };
    let same_agent = driver
        .get("agentPubkey")
        .and_then(serde_json::Value::as_str)
        == Some(key.agent_pubkey.as_str());
    let same_conversation = driver
        .get("conversationId")
        .and_then(serde_json::Value::as_str)
        == Some(key.conversation_id.as_str());
    let stale = driver
        .get("acquiredAt")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|ts| {
            super::runtime_setup::now_ms().saturating_sub(ts) > DRIVER_STALE_AFTER_MS
        });

    same_agent && same_conversation && !stale
}

pub(super) fn is_agent_blocked(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
) -> bool {
    store
        .lock()
        .unwrap()
        .get_agent_context_state(conversation_id, agent_pubkey)
        .ok()
        .flatten()
        .is_some_and(|state| state.is_blocked)
}

fn upsert_agent_blocked_flag(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
    is_blocked: bool,
) -> Result<()> {
    let store = store.lock().unwrap();
    store.ensure_conversation(conversation_id)?;
    let existing = store.get_agent_context_state(conversation_id, agent_pubkey)?;
    let state = AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: existing
            .as_ref()
            .map(|s| s.next_prompt_sequence)
            .unwrap_or(0),
        cache_anchored: existing.as_ref().is_some_and(|s| s.cache_anchored),
        seen_message_ids: existing
            .as_ref()
            .map(|s| s.seen_message_ids.clone())
            .unwrap_or_default(),
        compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
        reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
        reminder_delta_state: existing
            .as_ref()
            .and_then(|s| s.reminder_delta_state.clone()),
        todos: existing.as_ref().and_then(|s| s.todos.clone()),
        self_applied_skills: existing
            .as_ref()
            .and_then(|s| s.self_applied_skills.clone()),
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked,
        todo_nudged: existing.as_ref().is_some_and(|s| s.todo_nudged),
        updated_at: super::runtime_setup::now_ms(),
    };
    store.upsert_agent_context_state(&state)?;
    Ok(())
}

pub(super) fn set_agent_blocked(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Result<()> {
    upsert_agent_blocked_flag(store, conversation_id, agent_pubkey, true)
}

pub(super) fn clear_agent_blocked(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Result<()> {
    upsert_agent_blocked_flag(store, conversation_id, agent_pubkey, false)
}

fn ensure_json_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value just set to object")
}

fn ensure_child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    ensure_json_object(value)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use nostr_sdk::prelude::*;
    use tenex_conversations::ConversationStore;
    use tenex_project::Agent;

    use super::*;

    fn signed_event_from(keys: &Keys, kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        EventBuilder::new(kind, content)
            .tags(tags)
            .allow_self_tagging()
            .sign_with_keys(keys)
            .unwrap()
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).unwrap()
    }

    fn agent(pubkey: &str) -> Agent {
        Agent {
            pubkey: pubkey.to_string(),
            slug: pubkey.to_string(),
            name: pubkey.to_string(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: None,
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
            is_local: true,
            backend_name: None,
        }
    }

    #[test]
    fn runtime_state_driver_busy_matches_current_agent_conversation() {
        let key = DispatchKey::new("agent1", "conv1");
        let state = serde_json::json!({
            "rustRuntime": {
                "driver": {
                    "agentPubkey": "agent1",
                    "conversationId": "conv1",
                    "executionId": "exec1",
                    "acquiredAt": super::super::runtime_setup::now_ms()
                }
            }
        });

        assert!(runtime_state_driver_busy(&state, &key));
    }

    #[test]
    fn runtime_state_driver_busy_ignores_stale_driver() {
        let key = DispatchKey::new("agent1", "conv1");
        let state = serde_json::json!({
            "rustRuntime": {
                "driver": {
                    "agentPubkey": "agent1",
                    "conversationId": "conv1",
                    "executionId": "exec1",
                    "acquiredAt": super::super::runtime_setup::now_ms() - DRIVER_STALE_AFTER_MS - 1
                }
            }
        });

        assert!(!runtime_state_driver_busy(&state, &key));
    }

    #[test]
    fn trace_root_round_trips_and_is_write_once() {
        let mut state = serde_json::json!({
            "rustRuntime": { "driver": { "agentPubkey": "a" } }
        });
        let first = tenex_telemetry::TraceCarrier {
            traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01".to_string(),
            tracestate: Some("vendor=one".to_string()),
            baggage: Some("conversation.id=abc".to_string()),
        };
        let second = tenex_telemetry::TraceCarrier {
            traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01".to_string(),
            tracestate: None,
            baggage: None,
        };

        write_trace_root_if_absent(&mut state, &first);
        assert_eq!(trace_root_from_runtime_state(&state), Some(first.clone()));
        // Pre-existing siblings preserved.
        assert_eq!(
            state["rustRuntime"]["driver"]["agentPubkey"],
            serde_json::Value::String("a".to_string())
        );

        // Second write must be a no-op.
        write_trace_root_if_absent(&mut state, &second);
        assert_eq!(trace_root_from_runtime_state(&state), Some(first));
    }

    #[test]
    fn trace_root_returns_none_when_absent() {
        let state = serde_json::json!({ "rustRuntime": { "telemetry": {} } });
        assert_eq!(trace_root_from_runtime_state(&state), None);
    }

    #[test]
    fn delegation_route_maps_child_completion_back_to_parent_context() {
        use std::collections::HashSet;
        use std::sync::Mutex;

        let store = Arc::new(Mutex::new(ConversationStore::open_in_memory().unwrap()));
        let user_keys = Keys::generate();
        let parent_keys = Keys::generate();
        let child_keys = Keys::generate();
        let parent_pubkey = parent_keys.public_key().to_hex();
        let child_pubkey = child_keys.public_key().to_hex();
        let parent_conversation_id =
            signed_event_from(&user_keys, Kind::TextNote, "root task", Vec::new())
                .id
                .to_hex();
        let parent_trigger = signed_event_from(
            &user_keys,
            Kind::TextNote,
            "delegate this",
            vec![tag(&["e", &parent_conversation_id, "", "root"])],
        );
        let parent_job = DispatchJob {
            event: parent_trigger.clone(),
            agent: agent(&parent_pubkey),
            conv_id: parent_conversation_id.clone(),
            agent_json: PathBuf::from("agent.json"),
            allow_driver_preempt: false,
            completion_recipient_pubkey: None,
            is_external: false,
            is_remote_agent: false,
            response_tee: None,
            trace_carrier: None,
        };
        let delegation = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@worker choose a color",
            vec![
                tag(&["p", &child_pubkey]),
                tag(&["delegation", &parent_conversation_id]),
            ],
        );
        let agent_pubkeys = HashSet::from([parent_pubkey.clone(), child_pubkey.clone()]);

        let route = register_delegation_route_if_needed(
            &store,
            &delegation,
            &agent_pubkeys,
            Some(&parent_job),
        )
        .unwrap()
        .expect("route registered");

        assert_eq!(route.parent_agent_pubkey, parent_pubkey);
        assert_eq!(route.parent_conversation_id, parent_conversation_id);
        assert_eq!(
            route.parent_completion_recipient_pubkey,
            parent_trigger.pubkey.to_hex()
        );
        assert_eq!(route.child_agent_pubkey, child_pubkey);
        assert_eq!(route.child_conversation_id, delegation.id.to_hex());

        // A child reply that carries the on-wire turn-end marker
        // (`status: completed`) routes back to the parent.
        let completion = signed_event_from(
            &child_keys,
            Kind::TextNote,
            "Worker picked blue.",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &route.parent_agent_pubkey]),
                tag(&["status", "completed"]),
            ],
        );
        let completion_route = delegation_route_for_child_reply(&store, &completion)
            .unwrap()
            .expect("completion route");

        assert_eq!(
            completion_route.parent_conversation_id,
            parent_conversation_id
        );
        assert_eq!(
            completion_route.child_conversation_id,
            delegation.id.to_hex()
        );

        // Regression: a child reply WITHOUT `status: completed` must also
        // resume the parent. The triple identity (route exists for this
        // conversation, author == registered child, parent in p-tags) is the
        // sole gate. Remote agents (e.g. the iPhone podcast player) don't
        // emit the tag, and we still need their replies to pop the parent
        // back into the parent conversation.
        let bare_reply = signed_event_from(
            &child_keys,
            Kind::TextNote,
            "Worker picked blue.",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &route.parent_agent_pubkey]),
            ],
        );
        let bare_route = delegation_route_for_child_reply(&store, &bare_reply)
            .unwrap()
            .expect("bare reply must route to parent");
        assert_eq!(bare_route.parent_conversation_id, parent_conversation_id);
        assert_eq!(bare_route.child_conversation_id, delegation.id.to_hex());

        // A reply in the delegation thread authored by the *parent* (not the
        // child) must NOT trigger resumption — the parent is following up
        // with the child, not completing the delegation back to itself.
        let parent_followup_in_thread = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@worker any progress?",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &child_pubkey]),
            ],
        );
        assert!(delegation_route_for_child_reply(&store, &parent_followup_in_thread)
            .unwrap()
            .is_none());

        let followup = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@worker use blue if available",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &child_pubkey]),
            ],
        );

        assert!(register_delegation_route_if_needed(
            &store,
            &followup,
            &agent_pubkeys,
            Some(&parent_job)
        )
        .unwrap()
        .is_none());
        assert_eq!(
            tenex_protocol::event_filter::conversation_id_from_event(&followup),
            delegation.id.to_hex()
        );
    }

    #[test]
    fn local_parent_delegation_registers_external_child_route() {
        use std::collections::HashSet;
        use std::sync::Mutex;

        let store = Arc::new(Mutex::new(ConversationStore::open_in_memory().unwrap()));
        let user_keys = Keys::generate();
        let parent_keys = Keys::generate();
        let external_child_keys = Keys::generate();
        let parent_pubkey = parent_keys.public_key().to_hex();
        let external_child_pubkey = external_child_keys.public_key().to_hex();
        let parent_conversation_id =
            signed_event_from(&user_keys, Kind::TextNote, "root task", Vec::new())
                .id
                .to_hex();
        let parent_trigger = signed_event_from(
            &user_keys,
            Kind::TextNote,
            "delegate cross-project",
            vec![tag(&["e", &parent_conversation_id, "", "root"])],
        );
        let parent_job = DispatchJob {
            event: parent_trigger,
            agent: agent(&parent_pubkey),
            conv_id: parent_conversation_id.clone(),
            agent_json: PathBuf::from("agent.json"),
            allow_driver_preempt: false,
            completion_recipient_pubkey: None,
            is_external: false,
            is_remote_agent: false,
            response_tee: None,
            trace_carrier: None,
        };
        let delegation = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@remote choose a color",
            vec![
                tag(&["p", &external_child_pubkey]),
                tag(&["delegation", &parent_conversation_id]),
            ],
        );
        let agent_pubkeys = HashSet::from([parent_pubkey.clone()]);

        let route = register_delegation_route_if_needed(
            &store,
            &delegation,
            &agent_pubkeys,
            Some(&parent_job),
        )
        .unwrap()
        .expect("route registered");

        assert_eq!(route.parent_agent_pubkey, parent_pubkey);
        assert_eq!(route.parent_conversation_id, parent_conversation_id);
        assert_eq!(route.child_agent_pubkey, external_child_pubkey);
        assert_eq!(route.child_conversation_id, delegation.id.to_hex());
    }

    /// Regression: when the delegating agent and the delegatee share the same
    /// Nostr keypair (the same agent configured in two different projects),
    /// the delegation event used to match its own freshly-registered route and
    /// get re-dispatched into the parent conversation, causing an infinite loop.
    ///
    /// The fix: `delegation_route_for_child_reply` must reject events that
    /// carry a `["delegation", ...]` tag — those are task starters, not replies.
    #[test]
    fn delegation_event_is_not_matched_as_child_reply_when_delegator_and_delegatee_share_pubkey() {
        use std::collections::HashSet;
        use std::sync::Mutex;

        let store = Arc::new(Mutex::new(ConversationStore::open_in_memory().unwrap()));
        let user_keys = Keys::generate();
        // One keypair shared between the "source" and "target" project's agent.
        let shared_keys = Keys::generate();
        let shared_pubkey = shared_keys.public_key().to_hex();

        let parent_conversation_id =
            signed_event_from(&user_keys, Kind::TextNote, "root task", Vec::new())
                .id
                .to_hex();

        // Delegation event: delegator == delegatee (same pubkey), no `e` root tag.
        // `conversation_id_from_event` falls back to `event.id`.
        let delegation = signed_event_from(
            &shared_keys,
            Kind::TextNote,
            "@self do the cross-project task",
            vec![
                tag(&["p", &shared_pubkey]),
                tag(&["delegation", &parent_conversation_id]),
            ],
        );

        let agent_pubkeys = HashSet::from([shared_pubkey.clone()]);

        // Simulate what the source runtime does: register the delegation route
        // (with parent_job=None, as happens in the relay/ACP path).
        let route = register_delegation_route_if_needed(
            &store,
            &delegation,
            &agent_pubkeys,
            None,
        )
        .unwrap()
        .expect("route registered");
        assert_eq!(route.child_conversation_id, delegation.id.to_hex());

        // The delegation event itself must NOT be treated as a child reply,
        // even though pubkey and conversation checks would otherwise match.
        assert!(
            delegation_route_for_child_reply(&store, &delegation)
                .unwrap()
                .is_none(),
            "delegation event must not match as a child reply"
        );
    }
}

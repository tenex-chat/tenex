//! Event-classification helpers and dispatch-target selection.
//!
//! Two layers live here:
//!
//! 1. **Pure tag predicates** — `conversation_id_from_event`, `has_tag`,
//!    `p_tag_pubkeys`, `targets_project_agent`,
//!    `event_matches_project_scope`, `select_agent`, etc. These reason about
//!    a single `Event`'s tags with no I/O.
//! 2. **Dispatch-target resolution** — `select_dispatch_target` (used from
//!    the relay loop, transport bridge, and external-author firewall path)
//!    and `dispatch_project_agent_target` (used by `run_agent` to follow
//!    agent-emitted delegations and completions).
//!
//! Routing decisions consult [`super::runtime_state_store`] for delegation
//! routes and pass through [`super::dispatch_pipeline::accept_dispatch`].

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use opentelemetry::baggage::BaggageExt;
use opentelemetry::{Context as OtelContext, KeyValue};
use tracing::warn;

use tenex_project::{models::ProjectAgent, Agent};

use super::agent_subprocess::DispatchJob;
use super::dispatch_pipeline::accept_dispatch;
use super::runtime_state_store::{
    delegation_route_for_completion, register_delegation_route_if_needed,
};
use super::RuntimeShared;

pub(super) fn mark_seen(seen: &Arc<Mutex<HashSet<EventId>>>, event_id: EventId) -> bool {
    let mut seen = seen.lock().unwrap();
    seen.insert(event_id)
}

pub(super) fn select_dispatch_target(
    shared: &RuntimeShared,
    event: &Event,
) -> Result<(Agent, String, Option<String>)> {
    let snapshot = shared.agent_snapshot();
    if let Some(route) = delegation_route_for_completion(&shared.store, event)? {
        if let Some(agent) = snapshot
            .agents
            .iter()
            .find(|agent| agent.pubkey == route.parent_agent_pubkey)
        {
            return Ok((
                agent.clone(),
                route.parent_conversation_id,
                Some(route.parent_completion_recipient_pubkey),
            ));
        }
        warn!(
            parent_agent = %route.parent_agent_pubkey,
            child_conversation = %route.child_conversation_id,
            "delegation completion parent agent is not in this runtime"
        );
    }

    if !event_matches_project_scope(event, &shared.project_addr) {
        anyhow::bail!("event project a-tag does not match this runtime");
    }

    if has_p_tags(event) && !targets_project_agent(event, &snapshot.agent_pubkeys) {
        anyhow::bail!("directed event does not target a current project agent");
    }

    let agent = select_agent(event, &snapshot.agents, &snapshot.project_agents)?.clone();
    Ok((agent, conversation_id_from_event(event), None))
}

pub(super) async fn dispatch_project_agent_target(
    shared: Arc<RuntimeShared>,
    event: &Event,
    parent_job: Option<&DispatchJob>,
) -> Result<()> {
    let agent_pubkeys = shared.agent_pubkeys();
    register_delegation_route_if_needed(&shared.store, event, &agent_pubkeys, parent_job)?;

    if !event_matches_project_scope(event, &shared.project_addr) {
        return Ok(());
    }
    if !targets_project_agent(event, &agent_pubkeys) {
        return Ok(());
    }
    if !mark_seen(&shared.seen, event.id) {
        return Ok(());
    }

    let (agent, conv_id, completion_recipient_pubkey) = select_dispatch_target(&shared, event)?;
    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    // Baggage scope is the synchronous block that builds the `DispatchJob`.
    // `ContextGuard` is `!Send` and so must be dropped before the `.await`
    // on `accept_dispatch`.
    let job = {
        let _baggage_guard = OtelContext::current()
            .with_baggage([
                KeyValue::new("conversation.id", conv_id.clone()),
                KeyValue::new("project.id", shared.project_id.clone()),
            ])
            .attach();
        let trace_carrier = tenex_telemetry::inject_current();
        DispatchJob {
            event: event.clone(),
            agent,
            conv_id,
            agent_json,
            allow_driver_preempt: false,
            completion_recipient_pubkey,
            // This path handles agent-emitted events (delegations,
            // completions). Inter-agent traffic is never external —
            // external authors are caught earlier in the relay loop.
            // It also is never cross-backend: only locally-spawned agents
            // emit through this pipe (their stdout). Remote agents reach
            // us via the relay loop instead.
            is_external: false,
            is_remote_agent: false,
            response_tee: None,
            trace_carrier,
        }
    };
    accept_dispatch(shared, job).await
}

pub(super) fn p_tag_pubkeys(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if parts.first().is_some_and(|head| head == "p") {
                parts.get(1).cloned()
            } else {
                None
            }
        })
        .collect()
}

pub(super) fn e_tag_event_ids(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if parts.first().is_some_and(|head| head == "e") {
                parts.get(1).cloned()
            } else {
                None
            }
        })
        .collect()
}

pub(super) fn is_completion_event(event: &Event) -> bool {
    event.kind == Kind::TextNote && has_tag(event, "status", "completed")
}

fn has_tag(event: &Event, tag_name: &str, tag_value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().is_some_and(|head| head == tag_name)
            && parts.get(1).is_some_and(|value| value == tag_value)
    })
}

pub(super) fn has_any_tag(event: &Event, tag_name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == tag_name))
}

pub(super) fn targets_project_agent(event: &Event, agent_pubkeys: &HashSet<String>) -> bool {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    event
        .tags
        .iter()
        .filter(|tag| tag.kind() == p_kind)
        .filter_map(|tag| tag.content())
        .any(|pubkey| agent_pubkeys.contains(pubkey))
}

fn has_p_tags(event: &Event) -> bool {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    event.tags.iter().any(|tag| tag.kind() == p_kind)
}

pub(super) fn event_matches_project_scope(event: &Event, project_addr: &str) -> bool {
    let project_addresses = project_address_tags(event);
    project_addresses.is_empty() || project_addresses.contains(&project_addr)
}

fn project_address_tags(event: &Event) -> Vec<&str> {
    let a_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::A));
    event
        .tags
        .iter()
        .filter(|tag| tag.kind() == a_kind)
        .filter_map(|tag| tag.content())
        .filter(|addr| addr.starts_with("31933:"))
        .collect()
}

pub(super) fn select_agent<'a>(
    event: &Event,
    agents: &'a [Agent],
    project_agents: &[ProjectAgent],
) -> Result<&'a Agent> {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    let p_tags: Vec<String> = event
        .tags
        .iter()
        .filter(|t| t.kind() == p_kind)
        .filter_map(|t| t.content().map(|s| s.to_string()))
        .collect();

    // Direct mention: find the first agent whose pubkey is in the #p tags.
    if let Some(agent) = agents.iter().find(|a| p_tags.contains(&a.pubkey)) {
        return Ok(agent);
    }

    if !p_tags.is_empty() {
        anyhow::bail!("directed event does not target a current project agent");
    }

    // No #p tags: fall back to the PM agent (handles project-wide events).
    let pm_pubkey = project_agents
        .iter()
        .find(|pa| pa.is_pm)
        .map(|pa| &pa.agent_pubkey);

    if let Some(pk) = pm_pubkey {
        return agents
            .iter()
            .find(|a| &a.pubkey == pk)
            .context("PM agent pubkey not found in agents list");
    }

    anyhow::bail!(
        "no agent matched #p tags {:?} and no PM agent configured",
        p_tags
    )
}

pub(super) fn conversation_id_from_event(event: &Event) -> String {
    let e_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::E));
    let mut first_unmarked: Option<String> = None;

    for tag in event.tags.iter() {
        if tag.kind() != e_kind {
            continue;
        }
        let parts = tag.as_slice();
        // parts[0]="e", parts[1]=event-id, parts[2]=relay, parts[3]=marker
        let Some(event_id) = parts.get(1) else {
            continue;
        };
        let marker = parts.get(3).map(|s| s.as_str());
        match marker {
            Some("root") => return event_id.clone(),
            None | Some("") if first_unmarked.is_none() => {
                first_unmarked = Some(event_id.clone());
            }
            None | Some("") => {}
            _ => {}
        }
    }

    first_unmarked.unwrap_or_else(|| event.id.to_hex())
}

#[cfg(test)]
mod tests {
    use tenex_project::models::ProjectAgent;

    use super::*;

    fn signed_event(kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, content)
            .tags(tags)
            .sign_with_keys(&keys)
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
        }
    }

    #[test]
    fn p_tag_pubkeys_extracts_direct_targets() {
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&["p", recipient.as_str()])],
        );

        assert_eq!(p_tag_pubkeys(&event), vec![recipient]);
    }

    #[test]
    fn agent_authored_delegation_targets_project_agent() {
        let worker = Keys::generate().public_key().to_hex();
        let event = signed_event(Kind::TextNote, "delegated task", vec![tag(&["p", &worker])]);
        let agent_pubkeys = HashSet::from([worker]);

        assert!(targets_project_agent(&event, &agent_pubkeys));
    }

    #[test]
    fn agent_authored_plain_message_does_not_target_project_agent() {
        let worker = Keys::generate().public_key().to_hex();
        let event = signed_event(Kind::TextNote, "plain reply", Vec::new());
        let agent_pubkeys = HashSet::from([worker]);

        assert!(!targets_project_agent(&event, &agent_pubkeys));
    }

    #[test]
    fn foreign_project_a_tag_blocks_routing_even_when_p_tag_matches_agent() {
        let local_owner = Keys::generate().public_key().to_hex();
        let foreign_owner = Keys::generate().public_key().to_hex();
        let agent_pubkey = Keys::generate().public_key().to_hex();
        let local_project = format!("31933:{local_owner}:local-project");
        let foreign_project = format!("31933:{foreign_owner}:foreign-project");
        let event = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&["a", &foreign_project]), tag(&["p", &agent_pubkey])],
        );
        let agent_pubkeys = HashSet::from([agent_pubkey]);

        assert!(targets_project_agent(&event, &agent_pubkeys));
        assert!(!event_matches_project_scope(&event, &local_project));
    }

    #[test]
    fn local_project_a_tag_allows_routing() {
        let owner = Keys::generate().public_key().to_hex();
        let project = format!("31933:{owner}:local-project");
        let event = signed_event(Kind::TextNote, "direct", vec![tag(&["a", &project])]);

        assert!(event_matches_project_scope(&event, &project));
    }

    #[test]
    fn unscoped_and_non_project_a_tags_do_not_block_direct_routing() {
        let unscoped = signed_event(Kind::TextNote, "direct", Vec::new());
        let article_ref = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&[
                "a",
                "30023:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:note",
            ])],
        );
        let project = "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:demo";

        assert!(event_matches_project_scope(&unscoped, project));
        assert!(event_matches_project_scope(&article_ref, project));
    }

    #[test]
    fn select_agent_falls_back_to_pm_only_when_event_has_no_p_tags() {
        let owner = Keys::generate().public_key().to_hex();
        let pm_pubkey = Keys::generate().public_key().to_hex();
        let worker_pubkey = Keys::generate().public_key().to_hex();
        let unknown_pubkey = Keys::generate().public_key().to_hex();
        let project = format!("31933:{owner}:local-project");
        let agents = vec![agent(&pm_pubkey), agent(&worker_pubkey)];
        let project_agents = vec![
            ProjectAgent {
                agent_pubkey: pm_pubkey.clone(),
                is_pm: true,
            },
            ProjectAgent {
                agent_pubkey: worker_pubkey.clone(),
                is_pm: false,
            },
        ];

        let project_wide =
            signed_event(Kind::TextNote, "project-wide", vec![tag(&["a", &project])]);
        let selected = select_agent(&project_wide, &agents, &project_agents).unwrap();
        assert_eq!(selected.pubkey, pm_pubkey);

        let unknown_direct = signed_event(
            Kind::TextNote,
            "unknown direct",
            vec![tag(&["a", &project]), tag(&["p", &unknown_pubkey])],
        );
        assert!(select_agent(&unknown_direct, &agents, &project_agents).is_err());
    }
}

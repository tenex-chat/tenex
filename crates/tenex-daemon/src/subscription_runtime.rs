use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::inbound_routing::{InboundRoutingCatalogError, build_inbound_routing_catalog};
use crate::project_event_index::ProjectEventIndex;
use crate::subscription_filters::{
    NostrFilter, build_agent_mentions_filter, build_lesson_filter, build_nip46_reply_filter,
    build_project_agent_snapshot_filter, build_project_tagged_filter, build_static_filters,
};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy)]
pub struct NostrSubscriptionPlanInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub since: Option<u64>,
    pub lesson_definition_ids: &'a [String],
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionPlan {
    pub relay_urls: Vec<String>,
    pub whitelisted_pubkeys: Vec<String>,
    pub project_addresses: Vec<String>,
    pub agent_pubkeys: Vec<String>,
    pub filters: Vec<NostrFilter>,
    pub static_filters: Vec<NostrFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_tagged_filter: Option<NostrFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_mentions_filter: Option<NostrFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_agent_snapshot_filter: Option<NostrFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nip46_reply_filter: Option<NostrFilter>,
    pub lesson_filters: Vec<NostrFilter>,
}

#[derive(Debug, Error)]
pub enum NostrSubscriptionPlanError {
    #[error("subscription plan backend config failed: {0}")]
    BackendConfig(#[from] BackendConfigError),
    #[error("subscription plan routing catalog failed: {0}")]
    RoutingCatalog(#[from] InboundRoutingCatalogError),
}

pub fn build_nostr_subscription_plan(
    input: NostrSubscriptionPlanInput<'_>,
) -> Result<NostrSubscriptionPlan, NostrSubscriptionPlanError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let projects_base = config
        .projects_base
        .as_deref()
        .unwrap_or("/tmp/tenex-projects");
    let descriptor_report = input
        .project_event_index
        .lock()
        .expect("project event index mutex must not be poisoned")
        .descriptors_report(projects_base);
    let catalog = build_inbound_routing_catalog(input.tenex_base_dir, &descriptor_report)?;
    let project_addresses = sorted_deduped(
        catalog
            .projects
            .iter()
            .map(|project| project.address.clone())
            .collect(),
    );
    let agent_pubkeys = sorted_deduped(
        catalog
            .projects
            .iter()
            .flat_map(|project| project.agents.iter().map(|agent| agent.pubkey.clone()))
            .collect(),
    );
    let relay_urls = config.effective_relay_urls();
    let backend_pubkey = config.backend_signer()?.pubkey_hex().to_string();
    let whitelisted_pubkeys = sorted_deduped(config.whitelisted_pubkeys);

    let static_filters = build_static_filters(&whitelisted_pubkeys, input.since);
    let project_tagged_filter = build_project_tagged_filter(&project_addresses, input.since);
    let agent_mentions_filter = build_agent_mentions_filter(&agent_pubkeys, input.since);
    let project_agent_snapshot_filter = build_project_agent_snapshot_filter(&whitelisted_pubkeys);
    let nip46_reply_filter = build_nip46_reply_filter(&backend_pubkey, &whitelisted_pubkeys);
    let lesson_filters = sorted_deduped(input.lesson_definition_ids.to_vec())
        .into_iter()
        .map(|definition_id| build_lesson_filter(&definition_id))
        .collect::<Vec<_>>();

    let mut filters = static_filters.clone();
    filters.extend(project_tagged_filter.clone());
    filters.extend(agent_mentions_filter.clone());
    filters.extend(project_agent_snapshot_filter.clone());
    filters.extend(nip46_reply_filter.clone());
    filters.extend(lesson_filters.clone());

    Ok(NostrSubscriptionPlan {
        relay_urls,
        whitelisted_pubkeys,
        project_addresses,
        agent_pubkeys,
        filters,
        static_filters,
        project_tagged_filter,
        agent_mentions_filter,
        project_agent_snapshot_filter,
        nip46_reply_filter,
        lesson_filters,
    })
}

fn sorted_deduped(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn builds_subscription_plan_from_config_and_filesystem_routing_catalog() {
        let project_event_index = std::sync::Arc::new(std::sync::Mutex::new(crate::project_event_index::ProjectEventIndex::new()));
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);
        let other_agent = pubkey_hex(0x22);
        let lesson_id = "e".repeat(64);

        write_config(
            base_dir,
            &[&owner],
            &["wss://relay.one", "https://not-a-relay"],
        );
        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent, &other_agent, &agent]);
        write_agent(base_dir, &agent, "alpha-agent");
        write_agent(base_dir, &other_agent, "other-agent");

        let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
            tenex_base_dir: base_dir,
            since: Some(1_710_001_000),
            lesson_definition_ids: std::slice::from_ref(&lesson_id),
            project_event_index: &project_event_index,
        })
        .expect("subscription plan must build");

        assert_eq!(plan.relay_urls, vec!["wss://relay.one".to_string()]);
        assert_eq!(plan.whitelisted_pubkeys, vec![owner.clone()]);
        assert_eq!(
            plan.project_addresses,
            vec![format!("31933:{owner}:project-alpha")]
        );
        assert_eq!(plan.agent_pubkeys, sorted_deduped(vec![agent, other_agent]));
        assert_eq!(plan.static_filters.len(), 3);
        assert_eq!(
            plan.project_tagged_filter
                .as_ref()
                .expect("project filter must exist")
                .project_addresses,
            plan.project_addresses
        );
        assert_eq!(
            plan.agent_mentions_filter
                .as_ref()
                .expect("agent filter must exist")
                .pubkeys,
            plan.agent_pubkeys
        );
        let snapshot_filter = plan
            .project_agent_snapshot_filter
            .as_ref()
            .expect("project agent snapshot filter must exist");
        assert_eq!(snapshot_filter.kinds, vec![14199]);
        assert_eq!(snapshot_filter.authors, plan.whitelisted_pubkeys);
        let nip46_filter = plan
            .nip46_reply_filter
            .as_ref()
            .expect("nip46 reply filter must exist");
        assert_eq!(nip46_filter.kinds, vec![24133]);
        assert_eq!(nip46_filter.authors, plan.whitelisted_pubkeys);
        assert_eq!(
            nip46_filter.pubkeys,
            vec![TEST_BACKEND_PUBKEY_HEX.to_string()]
        );
        assert_eq!(nip46_filter.limit, Some(0));
        assert_eq!(plan.lesson_filters, vec![build_lesson_filter(&lesson_id)]);
        assert_eq!(
            plan.filters.len(),
            plan.static_filters.len() + 1 + 1 + 1 + 1 + plan.lesson_filters.len()
        );
        assert!(plan.filters.contains(snapshot_filter));
        assert!(plan.filters.contains(nip46_filter));
    }

    #[test]
    fn falls_back_to_default_relay_and_omits_empty_dynamic_filters() {
        let project_event_index = std::sync::Arc::new(std::sync::Mutex::new(crate::project_event_index::ProjectEventIndex::new()));
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        write_config(base_dir, &[], &[]);

        let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
            tenex_base_dir: base_dir,
            since: None,
            lesson_definition_ids: &[],
            project_event_index: &project_event_index,
        })
        .expect("subscription plan must build");

        assert_eq!(plan.relay_urls, vec!["wss://relay.tenex.chat".to_string()]);
        assert!(plan.static_filters.is_empty());
        assert_eq!(plan.project_tagged_filter, None);
        assert_eq!(plan.agent_mentions_filter, None);
        assert_eq!(plan.project_agent_snapshot_filter, None);
        assert_eq!(plan.nip46_reply_filter, None);
        assert!(plan.lesson_filters.is_empty());
        assert!(plan.filters.is_empty());
    }

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_BACKEND_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    fn write_config(base_dir: &Path, whitelisted: &[&str], relays: &[&str]) {
        fs::write(
            base_dir.join("config.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "whitelistedPubkeys": whitelisted,
                "relays": relays,
                "tenexPrivateKey": TEST_SECRET_KEY_HEX,
            }))
            .expect("config json must serialize"),
        )
        .expect("config must write");
    }

    fn write_project(base_dir: &Path, project_id: &str, owner: &str, project_base_path: &str) {
        let project_dir = base_dir.join("projects").join(project_id);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::write(
            project_dir.join("project.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "projectOwnerPubkey": owner,
                "projectDTag": project_id,
                "projectBasePath": project_base_path,
                "status": "active"
            }))
            .expect("project json must serialize"),
        )
        .expect("project descriptor must write");
    }

    fn write_agent_index(base_dir: &Path, project_id: &str, pubkeys: &[&str]) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "byProject": {
                    project_id: pubkeys,
                }
            }))
            .expect("agent index must serialize"),
        )
        .expect("agent index must write");
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": "active",
                "default": {}
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}

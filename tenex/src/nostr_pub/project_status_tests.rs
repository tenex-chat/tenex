use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use nostr_sdk::{Event, Keys};
use tenex_project::{Agent, ProjectMetadata};

use super::project_status::{build_project_status_event, collect_model_access, ModelAccess};
use crate::store::llms::LlmsDoc;

const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
const AGENT_PK: &str = "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";

fn unique_temp() -> PathBuf {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path =
        std::env::temp_dir().join(format!("tenex-project-status-{}-{n}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn load_llms(raw: serde_json::Value) -> LlmsDoc {
    let base = unique_temp();
    fs::write(base.join("llms.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    let doc = LlmsDoc::load(&base).unwrap();
    fs::remove_dir_all(base).ok();
    doc
}

fn agent(slug: &str, model: Option<&str>) -> Agent {
    let default_config_json = model.map(|model| serde_json::json!({ "model": model }).to_string());
    Agent {
        pubkey: AGENT_PK.into(),
        slug: slug.into(),
        name: slug.into(),
        role: None,
        description: None,
        instructions: None,
        use_criteria: None,
        category: None,
        signer_ref: None,
        event_id: None,
        status: None,
        default_config_json,
        telegram_config_json: None,
        mcp_servers_json: None,
    }
}

fn project_meta() -> ProjectMetadata {
    ProjectMetadata {
        d_tag: "test-project".into(),
        owner_pubkey: Some(OWNER_PK.into()),
        title: None,
        repo_url: None,
        latest_event_id: None,
        ingested_at: None,
    }
}

fn tags(event: &Event) -> Vec<Vec<String>> {
    event.tags.iter().map(|tag| tag.clone().to_vec()).collect()
}

#[test]
fn collect_model_access_announces_all_configs_and_maps_agents() {
    let llms = load_llms(serde_json::json!({
        "configurations": {
            "beta": { "provider": "mock", "model": "b" },
            "alpha": { "provider": "mock", "model": "a" },
            "unused": { "provider": "mock", "model": "u" }
        },
        "default": "alpha"
    }));
    let agents = vec![
        agent("worker-beta", Some("beta")),
        agent("worker-default", None),
        agent("worker-unknown", Some("missing")),
    ];

    let access = collect_model_access(&llms, &agents);

    assert_eq!(
        access,
        vec![
            ModelAccess {
                slug: "alpha".into(),
                agents: vec!["worker-default".into(), "worker-unknown".into()],
            },
            ModelAccess {
                slug: "beta".into(),
                agents: vec!["worker-beta".into()],
            },
            ModelAccess {
                slug: "unused".into(),
                agents: vec![],
            },
        ]
    );
}

#[test]
fn build_event_emits_model_tags() {
    let keys = Keys::generate();
    let event = build_project_status_event(
        &keys,
        &project_meta(),
        &[agent("worker", Some("alpha"))],
        &[],
        &[
            ModelAccess {
                slug: "alpha".into(),
                agents: vec!["worker".into()],
            },
            ModelAccess {
                slug: "unused".into(),
                agents: vec![],
            },
        ],
        &[],
    )
    .unwrap();
    let tags = tags(&event);

    assert!(tags.contains(&vec!["model".into(), "alpha".into(), "worker".into()]));
    assert!(tags.contains(&vec!["model".into(), "unused".into()]));
}

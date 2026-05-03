use nostr_sdk::{Event, Keys};
use tenex_project::{Agent, ProjectMetadata};

use super::project_status::build_project_status_event;

const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
const AGENT_PK: &str = "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";

fn agent_with_skills(slug: &str, pubkey: &str, skills: &[&str], mcps: &[&str]) -> Agent {
    let mut default = serde_json::Map::new();
    default.insert(
        "skills".into(),
        serde_json::Value::Array(
            skills
                .iter()
                .map(|s| serde_json::Value::String((*s).to_string()))
                .collect(),
        ),
    );
    let default_config_json = Some(serde_json::Value::Object(default).to_string());

    let mcp_servers_json = if mcps.is_empty() {
        None
    } else {
        let mut m = serde_json::Map::new();
        for name in mcps {
            m.insert((*name).into(), serde_json::json!({}));
        }
        Some(serde_json::Value::Object(m).to_string())
    };

    Agent {
        pubkey: pubkey.into(),
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
        mcp_servers_json,
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
fn build_event_emits_no_capability_tags() {
    let keys = Keys::generate();
    let event = build_project_status_event(
        &keys,
        &project_meta(),
        &[agent_with_skills(
            "worker",
            AGENT_PK,
            &["any-skill"],
            &["github", "linear"],
        )],
        &[],
        &[],
    )
    .unwrap();

    let all = tags(&event);
    for capability in ["model", "mcp", "skill"] {
        assert!(
            !all.iter()
                .any(|t| t.first().map(String::as_str) == Some(capability)),
            "24010 must not emit {capability} tags; got {all:?}",
        );
    }
}

#[test]
fn build_event_keeps_agent_and_pm_tags() {
    let keys = Keys::generate();
    let agent = agent_with_skills("worker", AGENT_PK, &[], &[]);
    let pm = tenex_project::models::ProjectAgent {
        agent_pubkey: AGENT_PK.into(),
        is_pm: true,
    };

    let event =
        build_project_status_event(&keys, &project_meta(), &[agent], &[pm], &[]).unwrap();

    let all = tags(&event);
    assert!(
        all.iter().any(|t| {
            t.len() >= 4
                && t[0] == "agent"
                && t[1] == AGENT_PK
                && t[2] == "worker"
                && t[3] == "pm"
        }),
        "expected agent+pm tag; got {all:?}",
    );
}

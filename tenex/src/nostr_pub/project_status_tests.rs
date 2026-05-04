use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use nostr_sdk::{Event, Keys};
use tenex_project::{Agent, ProjectMetadata};

use super::project_status::{build_project_status_event, project_scoped_skill_ids};

const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
const AGENT_PK: &str = "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";
const AGENT_PK_B: &str = "1f1a2b3c4d5e6f7081928374a5b6c7d8e9f0011223344556677889900aabbccd";

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

fn unique_temp(prefix: &str) -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let path = std::env::temp_dir().join(format!(
        "tenex_project_status_tests_{prefix}_{pid}_{id}_{nanos}",
        nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

/// Write a project-scoped skill at `{root}/.agents/skills/<id>/SKILL.md`.
/// The directory is flat (no per-agent shard) — same set is visible to every
/// agent in the project.
fn write_skill_dir(root: &Path, skill_id: &str, with_skill_md: bool) {
    let dir = root.join(".agents").join("skills").join(skill_id);
    fs::create_dir_all(&dir).unwrap();
    if with_skill_md {
        fs::write(dir.join("SKILL.md"), "---\nname: test\n---\n").unwrap();
    }
}

#[test]
fn project_scoped_skill_ids_partitions_by_directory_presence() {
    let tmp = unique_temp("partition");

    // alpha has a SKILL.md, beta is just an empty dir.
    write_skill_dir(&tmp, "alpha", true);
    write_skill_dir(&tmp, "beta", false);

    let ids = project_scoped_skill_ids(&tmp);
    assert!(ids.contains("alpha"), "alpha should be present: {ids:?}");
    assert!(!ids.contains("beta"), "beta should be filtered out: {ids:?}");
    assert_eq!(ids.len(), 1, "only alpha should be present: {ids:?}");
}

#[test]
fn build_event_emits_universe_and_assignment_tags() {
    let tmp = unique_temp("universe");

    // Both alpha and beta live in the flat per-project skills dir — visible
    // to every agent.
    write_skill_dir(&tmp, "alpha", true);
    write_skill_dir(&tmp, "beta", true);

    // A enables alpha. B enables nothing.
    let agent_a = agent_with_skills("agent-a", AGENT_PK, &["alpha"], &[]);
    let agent_b = agent_with_skills("agent-b", AGENT_PK_B, &[], &[]);

    let keys = Keys::generate();
    let event = build_project_status_event(
        &keys,
        &project_meta(),
        &tmp,
        &[agent_a, agent_b],
        &[],
        &[],
    )
    .unwrap();

    let all = tags(&event);

    // Universe tags for both alpha and beta.
    assert!(
        all.iter().any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "alpha"),
        "expected bare ['skill', 'alpha']; got {all:?}",
    );
    assert!(
        all.iter().any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "beta"),
        "expected bare ['skill', 'beta']; got {all:?}",
    );

    // Assignment tag for alpha → agent-a.
    assert!(
        all.iter().any(|t| t.len() == 3
            && t[0] == "skill"
            && t[1] == "alpha"
            && t[2] == "agent-a"),
        "expected ['skill', 'alpha', 'agent-a']; got {all:?}",
    );

    // No assignment tag for beta — neither agent enabled it.
    assert!(
        !all.iter()
            .any(|t| t.len() >= 3 && t[0] == "skill" && t[1] == "beta"),
        "beta should have universe tag only; got {all:?}",
    );

    // No model, mcp, or tool tags ever.
    for capability in ["model", "mcp", "tool"] {
        assert!(
            !all.iter()
                .any(|t| t.first().map(String::as_str) == Some(capability)),
            "24010 must not emit {capability} tags; got {all:?}",
        );
    }
}

#[test]
fn build_event_emits_universe_tag_for_inactive_project_scoped_skill() {
    let tmp = unique_temp("inactive");

    // gamma exists in the flat per-project dir, but no agent enables it.
    write_skill_dir(&tmp, "gamma", true);
    let agent_a = agent_with_skills("agent-a", AGENT_PK, &[], &[]);

    let keys = Keys::generate();
    let event =
        build_project_status_event(&keys, &project_meta(), &tmp, &[agent_a], &[], &[]).unwrap();

    let all = tags(&event);

    // Universe tag for gamma exists.
    assert!(
        all.iter().any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "gamma"),
        "expected bare ['skill', 'gamma']; got {all:?}",
    );

    // No assignment tag for gamma.
    assert!(
        !all.iter()
            .any(|t| t.len() >= 3 && t[0] == "skill" && t[1] == "gamma"),
        "gamma should have no assignment tag; got {all:?}",
    );
}

#[test]
fn build_event_emits_no_model_or_mcp_tags() {
    let tmp = unique_temp("nocaps");
    let keys = Keys::generate();
    let event = build_project_status_event(
        &keys,
        &project_meta(),
        &tmp,
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
    for capability in ["model", "mcp", "tool"] {
        assert!(
            !all.iter()
                .any(|t| t.first().map(String::as_str) == Some(capability)),
            "24010 must not emit {capability} tags; got {all:?}",
        );
    }
    // No project dir set up → no skill tags either.
    assert!(
        !all.iter()
            .any(|t| t.first().map(String::as_str) == Some("skill")),
        "no project-scoped skills on disk → no skill tags; got {all:?}",
    );
}

#[test]
fn build_event_keeps_agent_and_pm_tags() {
    let tmp = unique_temp("pmtag");
    let keys = Keys::generate();
    let agent = agent_with_skills("worker", AGENT_PK, &[], &[]);
    let pm = tenex_project::models::ProjectAgent {
        agent_pubkey: AGENT_PK.into(),
        is_pm: true,
    };

    let event =
        build_project_status_event(&keys, &project_meta(), &tmp, &[agent], &[pm], &[]).unwrap();

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

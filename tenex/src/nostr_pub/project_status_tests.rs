use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use nostr_sdk::{Event, Keys};
use tenex_project::ProjectMetadata;

use super::project_status::{build_project_status_event, project_scoped_skill_ids, RunningAgent};
use tenex_mcp::PROJECT_MCP_FILE_NAME;

const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";

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
    assert!(
        !ids.contains("beta"),
        "beta should be filtered out: {ids:?}"
    );
    assert_eq!(ids.len(), 1, "only alpha should be present: {ids:?}");
}

#[test]
fn build_event_emits_one_skill_tag_per_universe_entry() {
    let tmp = unique_temp("universe");

    write_skill_dir(&tmp, "alpha", true);
    write_skill_dir(&tmp, "beta", true);

    let keys = Keys::generate();
    let event = build_project_status_event(&keys, &project_meta(), &tmp, &[], &[]).unwrap();

    let all = tags(&event);

    // Bare ['skill', <id>] tag for each universe entry.
    assert!(
        all.iter()
            .any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "alpha"),
        "expected ['skill', 'alpha']; got {all:?}",
    );
    assert!(
        all.iter()
            .any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "beta"),
        "expected ['skill', 'beta']; got {all:?}",
    );

    // Never any assignment-form skill tag — agent assignments live on kind:0.
    assert!(
        !all.iter().any(|t| t[0] == "skill" && t.len() > 2),
        "24010 must not emit assignment-form skill tags; got {all:?}",
    );

    // model and tool tags never appear on 24010 — they live on kind:0.
    // agent tags appear only when running_agents is non-empty (tested separately).
    for capability in ["model", "tool"] {
        assert!(
            !all.iter()
                .any(|t| t.first().map(String::as_str) == Some(capability)),
            "24010 must not emit {capability} tags; got {all:?}",
        );
    }
    assert!(
        !all.iter()
            .any(|t| t.first().map(String::as_str) == Some("agent")),
        "24010 must not emit agent tags when running_agents is empty; got {all:?}",
    );
}

#[test]
fn build_event_emits_skill_tags_independent_of_agent_state() {
    // Skills appear regardless of whether running_agents is populated.
    let tmp = unique_temp("nocaps");
    write_skill_dir(&tmp, "gamma", true);

    let keys = Keys::generate();
    let event = build_project_status_event(&keys, &project_meta(), &tmp, &[], &[]).unwrap();

    let all = tags(&event);
    assert!(
        all.iter()
            .any(|t| t.len() == 2 && t[0] == "skill" && t[1] == "gamma"),
        "expected ['skill', 'gamma']; got {all:?}",
    );
    for capability in ["model", "tool"] {
        assert!(
            !all.iter()
                .any(|t| t.first().map(String::as_str) == Some(capability)),
            "24010 must not emit {capability} tags; got {all:?}",
        );
    }
}

#[test]
fn build_event_emits_agent_tags_for_running_agents() {
    let tmp = unique_temp("agents");
    let keys = Keys::generate();
    let agents = vec![
        RunningAgent {
            pubkey: "a".repeat(64),
            slug: "planner".into(),
        },
        RunningAgent {
            pubkey: "b".repeat(64),
            slug: "coder".into(),
        },
    ];
    let event =
        build_project_status_event(&keys, &project_meta(), &tmp, &[], &agents).unwrap();
    let all = tags(&event);

    assert!(
        all.iter().any(|t| t.len() == 3
            && t[0] == "agent"
            && t[1] == "a".repeat(64)
            && t[2] == "planner"),
        "expected ['agent', 'aaa...', 'planner']; got {all:?}",
    );
    assert!(
        all.iter().any(|t| t.len() == 3
            && t[0] == "agent"
            && t[1] == "b".repeat(64)
            && t[2] == "coder"),
        "expected ['agent', 'bbb...', 'coder']; got {all:?}",
    );
}

#[test]
fn build_event_emits_mcp_tags_from_dot_mcp_json() {
    let tmp = unique_temp("mcp");
    fs::write(
        tmp.join(PROJECT_MCP_FILE_NAME),
        r#"{"mcpServers":{"xcode":{"type":"stdio","command":"npx","args":["-y","xcodebuildmcp","mcp"],"env":{}},"git":{"type":"stdio","command":"git-mcp","args":[],"env":{}}}}"#,
    )
    .unwrap();

    let keys = Keys::generate();
    let event = build_project_status_event(&keys, &project_meta(), &tmp, &[], &[]).unwrap();

    let all = tags(&event);

    assert!(
        all.iter()
            .any(|t| t.len() == 2 && t[0] == "mcp" && t[1] == "xcode"),
        "expected ['mcp', 'xcode']; got {all:?}",
    );
    assert!(
        all.iter()
            .any(|t| t.len() == 2 && t[0] == "mcp" && t[1] == "git"),
        "expected ['mcp', 'git']; got {all:?}",
    );
}

#[test]
fn build_event_emits_no_mcp_tags_when_dot_mcp_json_absent() {
    let tmp = unique_temp("nomcp");

    let keys = Keys::generate();
    let event = build_project_status_event(&keys, &project_meta(), &tmp, &[], &[]).unwrap();

    let all = tags(&event);
    assert!(
        !all.iter().any(|t| t.first().map(String::as_str) == Some("mcp")),
        "expected no mcp tags when .mcp.json is absent; got {all:?}",
    );
}

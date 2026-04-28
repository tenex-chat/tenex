use std::fs;

use tempfile::TempDir;
use tenex_project::{Agent, Project, ProjectAgent, ProjectMetadata};

const HEX_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
const AGENT_PK: &str = "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";

fn sample_metadata() -> ProjectMetadata {
    ProjectMetadata {
        d_tag: "my-project".into(),
        owner_pubkey: Some(HEX_PK.into()),
        title: Some("My Project".into()),
        repo_url: Some("https://example.org/repo".into()),
        working_directory: Some("/tmp/work".into()),
        latest_event_id: Some("event123".into()),
        ingested_at: Some(1_700_000_000),
    }
}

fn sample_agent() -> Agent {
    Agent {
        pubkey: AGENT_PK.into(),
        slug: "transparent".into(),
        name: "Transparent".into(),
        role: Some("Respond clearly".into()),
        description: Some("desc".into()),
        instructions: Some("instr".into()),
        use_criteria: Some("crit".into()),
        category: Some("worker".into()),
        inferred_category: None,
        signer_ref: Some("nsec:nsec125v964gu6u6ncqdkczwjq7pdtu0adj03sjfcm3lsj67ljk7v2hrsr2juay".into()),
        event_id: Some("evt-agent".into()),
        status: Some("active".into()),
        default_config_json: Some(r#"{"skills":["write-access","read-access"]}"#.into()),
        telegram_config_json: None,
        mcp_servers_json: None,
    }
}

#[test]
fn open_creates_db_and_runs_migrations() {
    let tmp = TempDir::new().unwrap();
    let project = Project::open("my-project", tmp.path()).unwrap();
    assert_eq!(project.d_tag().as_str(), "my-project");
    assert!(project.db_path().exists());

    let check = project.integrity_check().unwrap();
    assert_eq!(check, "ok");
}

#[test]
fn coordinate_and_d_tag_resolve_to_same_db() {
    let tmp = TempDir::new().unwrap();
    let coord = format!("31933:{HEX_PK}:my-project");

    let from_coord = Project::open(&coord, tmp.path()).unwrap();
    let coord_path = from_coord.db_path().to_path_buf();
    drop(from_coord);

    let from_d_tag = Project::open("my-project", tmp.path()).unwrap();
    assert_eq!(from_d_tag.db_path(), coord_path);
}

#[test]
fn coordinate_and_d_tag_see_same_rows() {
    let tmp = TempDir::new().unwrap();
    let coord = format!("31933:{HEX_PK}:my-project");

    {
        let p = Project::open(&coord, tmp.path()).unwrap();
        p.upsert_metadata(&sample_metadata()).unwrap();
        p.upsert_agent(&sample_agent()).unwrap();
    }

    let p2 = Project::open("my-project", tmp.path()).unwrap();
    assert_eq!(p2.metadata().unwrap(), Some(sample_metadata()));
    assert_eq!(p2.agents().unwrap(), vec![sample_agent()]);
}

#[test]
fn metadata_round_trip_and_upsert_merges() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();

    p.upsert_metadata(&sample_metadata()).unwrap();
    assert_eq!(p.metadata().unwrap(), Some(sample_metadata()));

    let mut updated = sample_metadata();
    updated.title = Some("New Title".into());
    updated.working_directory = None;
    p.upsert_metadata(&updated).unwrap();

    let read = p.metadata().unwrap().unwrap();
    assert_eq!(read.title.as_deref(), Some("New Title"));
    // working_directory falls back to the previous value when the upsert
    // passes NULL — see project.rs upsert_metadata.
    assert_eq!(read.working_directory.as_deref(), Some("/tmp/work"));
}

#[test]
fn agents_lookup_by_pubkey_and_slug() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();
    p.upsert_agent(&sample_agent()).unwrap();

    assert_eq!(p.agent_by_pubkey(AGENT_PK).unwrap(), Some(sample_agent()));
    assert_eq!(p.agent_by_slug("transparent").unwrap(), Some(sample_agent()));
    assert_eq!(p.resolve_slug("transparent").unwrap().as_deref(), Some(AGENT_PK));
    assert!(p.agent_by_slug("missing").unwrap().is_none());
}

#[test]
fn project_agents_round_trip() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();
    p.upsert_agent(&sample_agent()).unwrap();

    let pa = ProjectAgent {
        agent_pubkey: AGENT_PK.into(),
        is_pm: true,
        intervention_enabled: true,
        escalation_target: Some("escalation-agent".into()),
    };
    p.upsert_project_agent(&pa).unwrap();

    let rows = p.project_agents().unwrap();
    assert_eq!(rows, vec![pa]);

    p.remove_project_agent(AGENT_PK).unwrap();
    assert!(p.project_agents().unwrap().is_empty());
}

#[test]
fn agent_json_columns_round_trip() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();

    let mut a = sample_agent();
    a.default_config_json = Some(r#"{"skills":["write-access","shell"],"model":"claude-opus-4-7"}"#.into());
    a.telegram_config_json = Some(r#"{"botToken":"t","allowlistedChatIds":["123"]}"#.into());
    a.mcp_servers_json = Some(r#"{"repomix":{"command":"npx","args":["-y","repomix@latest","--mcp"]}}"#.into());
    p.upsert_agent(&a).unwrap();

    let read = p.agent_by_pubkey(AGENT_PK).unwrap().unwrap();
    assert_eq!(read.default_config_json, a.default_config_json);
    assert_eq!(read.telegram_config_json, a.telegram_config_json);
    assert_eq!(read.mcp_servers_json, a.mcp_servers_json);
}

#[test]
fn signer_for_agent_with_nsec_works() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();
    p.upsert_agent(&sample_agent()).unwrap();

    let signer = p.signer_for_agent(AGENT_PK).unwrap().unwrap();
    assert_eq!(signer.pubkey().len(), 64);
}

#[test]
fn signer_for_agent_with_bunker_returns_unsupported() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();
    let mut a = sample_agent();
    a.signer_ref = Some("bunker:nostrconnect://abc".into());
    p.upsert_agent(&a).unwrap();

    let result = p.signer_for_agent(AGENT_PK).unwrap();
    assert!(result.is_err(), "expected unsupported scheme error");
}

#[test]
fn migrate_from_legacy_imports_event_and_agents() {
    let tmp = TempDir::new().unwrap();
    let base = tmp.path();
    let projects_dir = base.join("projects/my-project");
    fs::create_dir_all(&projects_dir).unwrap();
    let agents_dir = base.join("agents");
    fs::create_dir_all(&agents_dir).unwrap();

    let event_json = serde_json::json!({
        "id": "event-id-1",
        "pubkey": HEX_PK,
        "kind": 31933,
        "tags": [
            ["d", "my-project"],
            ["title", "My Project"],
            ["p", AGENT_PK],
        ],
    });
    fs::write(
        projects_dir.join("event.json"),
        serde_json::to_vec_pretty(&event_json).unwrap(),
    )
    .unwrap();

    let agent_json = serde_json::json!({
        "nsec": "nsec125v964gu6u6ncqdkczwjq7pdtu0adj03sjfcm3lsj67ljk7v2hrsr2juay",
        "slug": "transparent",
        "name": "Transparent",
        "role": "role",
        "status": "active",
        "eventId": "evt-agent",
        "default": {
            "skills": ["write-access", "read-access", "shell"],
        },
        "telegram": {
            "botToken": "telegram-token",
        },
        "mcpServers": {
            "repomix": {
                "command": "npx",
                "args": ["-y", "repomix@latest", "--mcp"],
            },
        },
    });
    fs::write(
        agents_dir.join(format!("{AGENT_PK}.json")),
        serde_json::to_vec_pretty(&agent_json).unwrap(),
    )
    .unwrap();

    let project = Project::open("my-project", base).unwrap();
    let report = project.migrate_from_legacy(base).unwrap();

    assert!(report.project_metadata_written);
    assert_eq!(report.agents_written, 1);
    assert_eq!(report.project_agents_written, 1);

    let meta = project.metadata().unwrap().unwrap();
    assert_eq!(meta.title.as_deref(), Some("My Project"));
    assert_eq!(meta.owner_pubkey.as_deref(), Some(HEX_PK));
    assert_eq!(meta.latest_event_id.as_deref(), Some("event-id-1"));

    let agent = project.agent_by_pubkey(AGENT_PK).unwrap().unwrap();
    assert_eq!(agent.slug, "transparent");
    assert!(agent.signer_ref.as_deref().unwrap().starts_with("nsec:"));
    assert!(agent
        .default_config_json
        .as_deref()
        .unwrap()
        .contains("write-access"));
    assert!(agent
        .telegram_config_json
        .as_deref()
        .unwrap()
        .contains("telegram-token"));
    assert!(agent.mcp_servers_json.as_deref().unwrap().contains("repomix"));

    let project_agents = project.project_agents().unwrap();
    assert_eq!(project_agents.len(), 1);
    assert!(project_agents[0].is_pm);

    // Idempotent: rerunning produces the same row counts.
    let report2 = project.migrate_from_legacy(base).unwrap();
    assert_eq!(report2.agents_written, 1);
    assert_eq!(project.agents().unwrap().len(), 1);
}

#[test]
fn schema_version_mismatch_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let p = Project::open("my-project", tmp.path()).unwrap();
    let path = p.db_path().to_path_buf();
    drop(p);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [&999_i64])
        .unwrap();
    drop(conn);

    let err = match Project::open("my-project", tmp.path()) {
        Ok(_) => panic!("expected schema version mismatch"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(msg.contains("schema version"), "unexpected error: {msg}");
}

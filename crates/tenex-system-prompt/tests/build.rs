//! Smoke tests for `tenex_system_prompt::build_system_prompt`.

use tenex_system_prompt::{
    build_system_prompt, BuildSystemPromptInput, HomeDirectoryInfo, TelegramChannelBinding,
};

fn minimal_home() -> HomeDirectoryInfo<'static> {
    HomeDirectoryInfo {
        home_dir: "/home/u/.tenex/home/abcdef01",
        file_count: "0 files",
        injected_files: &[],
    }
}

fn minimal_input<'a>(home: &'a HomeDirectoryInfo<'a>) -> BuildSystemPromptInput<'a> {
    BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    }
}

#[test]
fn contains_identity_fragment() {
    let home = minimal_home();
    let out = build_system_prompt(minimal_input(&home));
    assert!(out.contains("<agent-identity>"));
    assert!(out.contains("Your name: scout (abcdef01)"));
    assert!(out.contains("</agent-identity>"));
}

#[test]
fn includes_global_system_prompt_when_present() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        global_system_prompt: Some("Use repository conventions first."),
        ..minimal_input(&home)
    });
    assert!(out.contains("<global-system-prompt>"));
    assert!(out.contains("Use repository conventions first."));
    assert!(out.contains("</global-system-prompt>"));
}

#[test]
fn contains_todo_guidance() {
    let home = minimal_home();
    let out = build_system_prompt(minimal_input(&home));
    assert!(out.contains("todo_write()"));
}

#[test]
fn home_directory_guidance_uses_maintainable_workspace_language() {
    let home = minimal_home();
    let out = build_system_prompt(minimal_input(&home));
    assert!(out.contains("scratch files"));
    assert!(!out.contains("temporary files"));
}

#[test]
fn identical_inputs_produce_byte_identical_output() {
    let home_a = minimal_home();
    let home_b = minimal_home();
    let a = build_system_prompt(BuildSystemPromptInput {
        identity_name: "stable",
        pubkey_hex: "11112222333344445555",
        category_str: Some("worker"),
        category: None,
        global_system_prompt: None,
        instructions: Some("hold steady"),
        working_dir: "/x",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home_a,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    let b = build_system_prompt(BuildSystemPromptInput {
        identity_name: "stable",
        pubkey_hex: "11112222333344445555",
        category_str: Some("worker"),
        category: None,
        global_system_prompt: None,
        instructions: Some("hold steady"),
        working_dir: "/x",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home_b,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert_eq!(a, b);
}

#[test]
fn orchestrator_category_skips_env_vars() {
    use tenex_system_prompt::AgentCategory;
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "boss",
        pubkey_hex: "abcdef0123456789",
        category_str: Some("orchestrator"),
        category: Some(AgentCategory::Orchestrator),
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(!out.contains("<environment-variables>"));
    assert!(out.contains("Orchestrator Guidance"));
}

#[test]
fn includes_root_agents_md_when_supplied() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj/.worktrees/feature",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: Some("\n# Project Rules\nUse repo conventions.\n"),
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("  <agents.md>\n# Project Rules\nUse repo conventions.\n  </agents.md>"));
}

#[test]
fn project_context_renders_project_base_relative_cwd() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj/src",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("cwd: $PROJECT_BASE/src"), "output was: {out}");
    assert!(out.contains("root: $PROJECT_BASE"));
}

#[test]
fn project_context_renders_exact_root_as_project_base() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("cwd: $PROJECT_BASE"), "output was: {out}");
    assert!(
        !out.contains("cwd: $PROJECT_BASE/"),
        "should not append slash: {out}"
    );
}

#[test]
fn project_context_does_not_rewrite_sibling_path() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/other-proj",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("cwd: /home/u/other-proj"), "output was: {out}");
    assert!(!out.contains("cwd: $PROJECT_BASE"));
}

#[test]
fn project_context_renders_project_id_and_conversation_id() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: Some("my-cool-project"),
        conversation_id: Some("deadbeef01234567"),
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("ID: my-cool-project"), "output was: {out}");
    assert!(
        out.contains("Conversation ID: deadbeef"),
        "output was: {out}"
    );
}

#[test]
fn project_context_renders_telegram_channel_bindings() {
    let home = minimal_home();
    let bindings = vec![
        TelegramChannelBinding::parse("telegram:chat:12345").unwrap(),
        TelegramChannelBinding::parse("telegram:group:-100987654321:topic:42").unwrap(),
        TelegramChannelBinding::parse("telegram:group:-100111222333").unwrap(),
    ];
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        global_system_prompt: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams: &[],
        agent_slug: "",
        active_team: None,
        home: &home,
        preloaded_skills_block: None,
        workflows_fragment: None,
        telegram_channel_bindings: &bindings,
        telegram_chat_context: None,

        scheduled_tasks: &[],
        current_branch: None,
        worktrees: &[],
    });
    assert!(out.contains("<channels>"), "output was: {out}");
    assert!(
        out.contains(r#"type="dm" id="telegram:chat:12345""#),
        "output was: {out}"
    );
    assert!(
        out.contains(r#"type="topic" id="telegram:group:-100987654321:topic:42""#),
        "output was: {out}"
    );
    assert!(
        out.contains(r#"type="group" id="telegram:group:-100111222333""#),
        "output was: {out}"
    );
    assert!(out.contains("</channels>"), "output was: {out}");
}

#[test]
fn no_channels_block_when_no_bindings() {
    let home = minimal_home();
    let out = build_system_prompt(minimal_input(&home));
    assert!(!out.contains("<channels>"), "output was: {out}");
}

#[test]
fn telegram_channel_binding_parse_dm() {
    let b = TelegramChannelBinding::parse("telegram:chat:12345").unwrap();
    assert_eq!(b.chat_id, "12345");
    assert_eq!(b.thread_id, None);
    assert_eq!(b.channel_type(), "dm");
}

#[test]
fn telegram_channel_binding_parse_group() {
    let b = TelegramChannelBinding::parse("telegram:group:-100111222333").unwrap();
    assert_eq!(b.chat_id, "-100111222333");
    assert_eq!(b.thread_id, None);
    assert_eq!(b.channel_type(), "group");
}

#[test]
fn telegram_channel_binding_parse_topic() {
    let b = TelegramChannelBinding::parse("telegram:group:-100987654321:topic:42").unwrap();
    assert_eq!(b.chat_id, "-100987654321");
    assert_eq!(b.thread_id, Some("42".to_string()));
    assert_eq!(b.channel_type(), "topic");
}

#[test]
fn telegram_channel_binding_parse_unknown_returns_none() {
    assert!(TelegramChannelBinding::parse("unknown:format:here").is_none());
    assert!(TelegramChannelBinding::parse("").is_none());
}

fn make_agent(slug: &str, description: &str) -> tenex_project::Agent {
    tenex_project::Agent {
        pubkey: format!("pk-{slug}"),
        slug: slug.to_string(),
        name: slug.to_string(),
        role: None,
        description: Some(description.to_string()),
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

fn make_team(name: &str, description: &str, lead: &str, members: &[&str]) -> tenex_project::Team {
    tenex_project::Team {
        name: name.to_string(),
        description: description.to_string(),
        team_lead: lead.to_string(),
        members: members.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn available_agents_falls_back_to_flat_list_when_no_teams() {
    let home = minimal_home();
    let agents = vec![
        make_agent("alpha", "alpha agent"),
        make_agent("beta", "beta agent"),
    ];
    let out = build_system_prompt(BuildSystemPromptInput {
        agents: &agents,
        ..minimal_input(&home)
    });
    assert!(out.contains("<available-agents>"));
    assert!(out.contains("- alpha (pk-alpha): alpha agent"));
    assert!(out.contains("- beta (pk-beta): beta agent"));
    assert!(!out.contains("<active-team>"));
    assert!(!out.contains("<my-teams>"));
    assert!(!out.contains("<also-available>"));
}

#[test]
fn available_agents_active_team_details_only_teammates_and_summarizes_others() {
    let home = minimal_home();
    let agents = vec![
        make_agent("self", "running agent"),
        make_agent("teammate", "teammate agent"),
        make_agent("outsider", "agent in another team"),
        make_agent("loner", "no team agent"),
    ];
    let teams = vec![
        make_team("alpha", "Alpha team", "self", &["self", "teammate"]),
        make_team("beta", "Beta team", "outsider", &["outsider"]),
    ];
    let out = build_system_prompt(BuildSystemPromptInput {
        agents: &agents,
        teams: &teams,
        agent_slug: "self",
        active_team: Some("alpha"),
        ..minimal_input(&home)
    });

    // Active team teammates detailed.
    assert!(out.contains("<active-team>"));
    assert!(out.contains("You are working in team \"alpha\""));
    assert!(out.contains("- teammate (pk-teamm): teammate agent"));

    // Other (non-member) team summarized — outsider must NOT be detailed.
    assert!(out.contains("* Team beta — Beta team [1 agents]"));
    assert!(!out.contains("- outsider "));

    // Unaffiliated agents detailed; running agent never listed.
    assert!(out.contains("- loner (pk-loner): no team agent"));
    assert!(!out.contains("- self "));
}

#[test]
fn available_agents_no_active_team_lists_member_team_teammates() {
    let home = minimal_home();
    let agents = vec![
        make_agent("self", "running agent"),
        make_agent("teammate", "teammate agent"),
    ];
    let teams = vec![make_team(
        "alpha",
        "Alpha team",
        "self",
        &["self", "teammate"],
    )];
    let out = build_system_prompt(BuildSystemPromptInput {
        agents: &agents,
        teams: &teams,
        agent_slug: "self",
        active_team: None,
        ..minimal_input(&home)
    });

    // No active-team scope, but member-team teammates surface as detailed.
    assert!(!out.contains("<active-team>"));
    assert!(out.contains("Teammates:"));
    assert!(out.contains("- teammate (pk-teamm): teammate agent"));
    assert!(!out.contains("- self "));
}

#[test]
fn available_agents_renders_my_teams_when_member_of_multiple() {
    let home = minimal_home();
    let agents = vec![
        make_agent("self", "running agent"),
        make_agent("teammate-a", "team a member"),
        make_agent("teammate-b", "team b member"),
    ];
    let teams = vec![
        make_team("alpha", "Alpha team", "self", &["self", "teammate-a"]),
        make_team("beta", "Beta team", "self", &["self", "teammate-b"]),
    ];
    let out = build_system_prompt(BuildSystemPromptInput {
        agents: &agents,
        teams: &teams,
        agent_slug: "self",
        active_team: Some("alpha"),
        ..minimal_input(&home)
    });

    // Active team's teammate is detailed; the other member team is summarized.
    assert!(out.contains("- teammate-a (pk-teamm): team a member"));
    assert!(out.contains("<my-teams>"));
    assert!(out.contains("You are also a member of:"));
    assert!(out.contains("* beta — Beta team"));
    // teammate-b is in beta only — not detailed under active-team scope.
    assert!(!out.contains("- teammate-b "));
}

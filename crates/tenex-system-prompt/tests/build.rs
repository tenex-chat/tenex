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
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: Some("hold steady"),
        working_dir: "/x",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home_a,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
    });
    let b = build_system_prompt(BuildSystemPromptInput {
        identity_name: "stable",
        pubkey_hex: "11112222333344445555",
        category_str: Some("worker"),
        category: None,
        instructions: Some("hold steady"),
        working_dir: "/x",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home_b,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj/.worktrees/feature",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: Some("\n# Project Rules\nUse repo conventions.\n"),
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj/src",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/other-proj",
        project_base_path: Some("/home/u/proj"),
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: Some("my-cool-project"),
        conversation_id: Some("deadbeef01234567"),
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &[],
        telegram_chat_context: None,
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
        instructions: None,
        working_dir: "/home/u/proj",
        project_base_path: None,
        project_meta: None,
        project_id: None,
        conversation_id: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
        telegram_channel_bindings: &bindings,
        telegram_chat_context: None,
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

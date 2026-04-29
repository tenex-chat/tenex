//! Smoke tests for `tenex_system_prompt::build_system_prompt`.

use tenex_system_prompt::{build_system_prompt, BuildSystemPromptInput, HomeDirectoryInfo};

fn minimal_home() -> HomeDirectoryInfo<'static> {
    HomeDirectoryInfo {
        home_dir: "/home/u/.tenex/home/abcdef01",
        file_count: "0 files",
        injected_files: &[],
    }
}

#[test]
fn contains_identity_fragment() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_meta: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
    });
    assert!(out.contains("<agent-identity>"));
    assert!(out.contains("Your name: scout (abcdef01)"));
    assert!(out.contains("</agent-identity>"));
}

#[test]
fn contains_todo_guidance() {
    let home = minimal_home();
    let out = build_system_prompt(BuildSystemPromptInput {
        identity_name: "scout",
        pubkey_hex: "abcdef0123456789",
        category_str: None,
        category: None,
        instructions: None,
        working_dir: "/home/u/proj",
        project_meta: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
    });
    assert!(out.contains("todo_write()"));
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
        project_meta: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home_a,
        preloaded_skills_block: None,
    });
    let b = build_system_prompt(BuildSystemPromptInput {
        identity_name: "stable",
        pubkey_hex: "11112222333344445555",
        category_str: Some("worker"),
        category: None,
        instructions: Some("hold steady"),
        working_dir: "/x",
        project_meta: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home_b,
        preloaded_skills_block: None,
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
        project_meta: None,
        root_agents_md: None,
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
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
        project_meta: None,
        root_agents_md: Some("\n# Project Rules\nUse repo conventions.\n"),
        agents: &[],
        teams_fragment: "",
        home: &home,
        preloaded_skills_block: None,
    });
    assert!(out.contains("  <agents.md>\n# Project Rules\nUse repo conventions.\n  </agents.md>"));
}

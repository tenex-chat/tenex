//! Smoke tests for `tenex_system_prompt::build_system_prompt`.

use tenex_system_prompt::{build_system_prompt, HomeDirectoryInfo};

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
    let out = build_system_prompt(
        "scout",
        "abcdef0123456789",
        None,
        None,
        None,
        "/home/u/proj",
        None,
        &[],
        "",
        &home,
        None,
    );
    assert!(out.contains("<agent-identity>"));
    assert!(out.contains("Your name: scout (abcdef01)"));
    assert!(out.contains("</agent-identity>"));
}

#[test]
fn contains_todo_guidance() {
    let home = minimal_home();
    let out = build_system_prompt(
        "scout",
        "abcdef0123456789",
        None,
        None,
        None,
        "/home/u/proj",
        None,
        &[],
        "",
        &home,
        None,
    );
    assert!(out.contains("todo_write()"));
}

#[test]
fn identical_inputs_produce_byte_identical_output() {
    let home_a = minimal_home();
    let home_b = minimal_home();
    let a = build_system_prompt(
        "stable",
        "11112222333344445555",
        Some("worker"),
        None,
        Some("hold steady"),
        "/x",
        None,
        &[],
        "",
        &home_a,
        None,
    );
    let b = build_system_prompt(
        "stable",
        "11112222333344445555",
        Some("worker"),
        None,
        Some("hold steady"),
        "/x",
        None,
        &[],
        "",
        &home_b,
        None,
    );
    assert_eq!(a, b);
}

#[test]
fn orchestrator_category_skips_env_vars() {
    use tenex_system_prompt::AgentCategory;
    let home = minimal_home();
    let out = build_system_prompt(
        "boss",
        "abcdef0123456789",
        Some("orchestrator"),
        Some(AgentCategory::Orchestrator),
        None,
        "/home/u/proj",
        None,
        &[],
        "",
        &home,
        None,
    );
    assert!(!out.contains("<environment-variables>"));
    assert!(out.contains("Orchestrator Guidance"));
}

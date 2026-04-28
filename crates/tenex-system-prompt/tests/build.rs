//! Golden tests for `tenex_system_prompt::build`.
//!
//! Expected strings are constructed inline so that diffs are reviewable and the
//! stability contract is exercised by re-invoking `build` with identical inputs.

use tenex_system_prompt::{build, AgentIdentity, ProjectContext, SkillRef};

const TODO_GUIDANCE: &str = "## Task Tracking with Todos

**IMPORTANT: Use `todo_write()` liberally and proactively!**

Creating a todo list helps you stay organized, shows your progress to observers, and ensures nothing gets forgotten. It's always better to have a simple todo list than none at all.

**Best Practice: Create todos EARLY in your work:**
- As soon as you receive a task, create a todo list
- Even 1-2 item lists are valuable for tracking progress
- Update your todos as you work (mark in_progress, done, add new items)

**Task management rules:**
- Only ONE task should be `in_progress` at a time
- Mark tasks `done` immediately after completing (don't batch completions)
- Use `skipped` with a reason if a task becomes irrelevant";

const TOOL_DESCRIPTION_GUIDANCE: &str = "When tools have a `description` parameter, write 5-10 words in active voice describing *what* and *why* (e.g. \"Index API docs for onboarding guide\").";

#[test]
fn minimal_inputs_render_identity_project_and_guidance() {
    let agent = AgentIdentity {
        pubkey: "abcdef0123456789".to_string(),
        name: "scout".to_string(),
        instructions: None,
        category: None,
    };
    let project = ProjectContext {
        working_dir: "/home/u/proj".to_string(),
        title: None,
        owner_pubkey: None,
    };

    let expected = format!(
        "<agent-identity>\n\
         Your name: scout (abcdef01)\n\
         </agent-identity>\n\
         \n\
         <project-context>\n  \
         <workspace>\n    \
         cwd: /home/u/proj\n  \
         </workspace>\n\
         </project-context>\n\
         \n\
         {TODO_GUIDANCE}\n\
         \n\
         {TOOL_DESCRIPTION_GUIDANCE}",
    );

    assert_eq!(build(&agent, &project, &[]), expected);
}

#[test]
fn full_inputs_render_all_fragments_in_order() {
    let agent = AgentIdentity {
        pubkey: "deadbeefcafebabe".to_string(),
        name: "architect".to_string(),
        instructions: Some("Be precise.\nFavor clarity.".to_string()),
        category: Some("orchestrator".to_string()),
    };
    let project = ProjectContext {
        working_dir: "/srv/tenex/proj".to_string(),
        title: Some("Tenex Core".to_string()),
        owner_pubkey: Some("ownerpub1234567890".to_string()),
    };
    let skills = [
        SkillRef {
            name: "rag-search".to_string(),
            when_to_use: "When you need codebase context.".to_string(),
            load_tool_name: "load_skill_rag_search".to_string(),
        },
        SkillRef {
            name: "schedule".to_string(),
            when_to_use: "When the user asks for a recurring task.".to_string(),
            load_tool_name: "load_skill_schedule".to_string(),
        },
    ];

    let expected = format!(
        "<agent-identity>\n\
         Your name: architect (deadbeef)\n\
         Your category: orchestrator\n\
         </agent-identity>\n\
         \n\
         <agent-instructions>\n\
         Be precise.\n\
         Favor clarity.\n\
         </agent-instructions>\n\
         \n\
         <project-context>\n  \
         <workspace>\n    \
         cwd: /srv/tenex/proj\n    \
         project: Tenex Core\n    \
         owner: ownerpub\n  \
         </workspace>\n\
         </project-context>\n\
         \n\
         <available-skills>\n  \
         - rag-search\n    \
         When to use: When you need codebase context.\n    \
         Load with: load_skill_rag_search\n  \
         - schedule\n    \
         When to use: When the user asks for a recurring task.\n    \
         Load with: load_skill_schedule\n\
         </available-skills>\n\
         \n\
         {TODO_GUIDANCE}\n\
         \n\
         {TOOL_DESCRIPTION_GUIDANCE}",
    );

    assert_eq!(build(&agent, &project, &skills), expected);
}

#[test]
fn identical_inputs_produce_byte_identical_output() {
    let agent = AgentIdentity {
        pubkey: "11112222333344445555".to_string(),
        name: "stable".to_string(),
        instructions: Some("hold steady".to_string()),
        category: Some("worker".to_string()),
    };
    let project = ProjectContext {
        working_dir: "/x".to_string(),
        title: Some("X".to_string()),
        owner_pubkey: Some("ownerXYZ".to_string()),
    };
    let skills = [SkillRef {
        name: "only".to_string(),
        when_to_use: "always".to_string(),
        load_tool_name: "load_only".to_string(),
    }];

    let a = build(&agent, &project, &skills);
    let b = build(&agent, &project, &skills);
    assert_eq!(a, b);
}

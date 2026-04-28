use crate::config::AgentConfig;
use tenex_project::{Agent, ProjectMetadata};

pub fn build_system_prompt(
    config: &AgentConfig,
    pubkey_hex: &str,
    working_dir: &str,
    project_meta: Option<&ProjectMetadata>,
    agents: &[Agent],
    teams_fragment: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Fragment 01: Agent identity
    let short_pubkey = &pubkey_hex[..8];
    parts.push(format!(
        "<agent-identity>\nYour name: {} ({})\n{}</agent-identity>",
        config.identity_name(),
        short_pubkey,
        config
            .category
            .as_deref()
            .map(|c| format!("Your category: {c}\n"))
            .unwrap_or_default(),
    ));

    // Fragment 03: System reminders explanation
    parts.push(
        "<system-reminders-explanation>\
Messages may include <system-reminder> tags. These are system-injected informational \
context — not user speech. They contain dynamic state such as your current todo list, \
behavioral guidance, or context updates. Absorb them silently; do not acknowledge or \
respond to them directly.\
</system-reminders-explanation>"
            .to_string(),
    );

    if let Some(instructions) = &config.instructions {
        parts.push(format!(
            "<agent-instructions>\n{instructions}\n</agent-instructions>"
        ));
    }

    // Fragment 08: Workspace + project context
    let mut project_lines = vec![format!("    cwd: {working_dir}")];
    if let Some(meta) = project_meta {
        if let Some(title) = &meta.title {
            project_lines.push(format!("    project: {title}"));
        }
        if let Some(owner) = &meta.owner_pubkey {
            project_lines.push(format!("    owner: {}", &owner[..8.min(owner.len())]));
        }
    }
    parts.push(format!(
        "<project-context>\n  <workspace>\n{}\n  </workspace>\n</project-context>",
        project_lines.join("\n")
    ));

    // Available agents fragment
    if !agents.is_empty() {
        let agent_lines: Vec<String> = agents
            .iter()
            .map(|a| {
                let mut line = format!("  - {} ({})", a.slug, a.name);
                if let Some(desc) = &a.description {
                    line.push_str(&format!(": {desc}"));
                } else if let Some(role) = &a.role {
                    line.push_str(&format!(": {role}"));
                }
                if let Some(criteria) = &a.use_criteria {
                    line.push_str(&format!("\n    Use when: {criteria}"));
                }
                line
            })
            .collect();
        parts.push(format!(
            "<available-agents>\n{}\n</available-agents>",
            agent_lines.join("\n")
        ));
    }

    // Teams context
    if !teams_fragment.is_empty() {
        parts.push(teams_fragment.to_string());
    }

    // Fragment 06: Todo guidance
    parts.push(
        "## Task Tracking with Todos

**IMPORTANT: Use `todo_write()` liberally and proactively!**

Creating a todo list helps you stay organized, shows your progress to observers, and ensures nothing gets forgotten. It's always better to have a simple todo list than none at all.

**Best Practice: Create todos EARLY in your work:**
- As soon as you receive a task, create a todo list
- Even 1-2 item lists are valuable for tracking progress
- Update your todos as you work (mark in_progress, done, add new items)

**Task management rules:**
- Only ONE task should be `in_progress` at a time
- Mark tasks `done` immediately after completing (don't batch completions)
- Use `skipped` with a reason if a task becomes irrelevant"
            .to_string(),
    );

    // Fragment 14: Tool description guidance
    parts.push(
        "When tools have a `description` parameter, write 5-10 words in active voice describing *what* and *why* (e.g. \"Index API docs for onboarding guide\").".to_string(),
    );

    parts.join("\n\n")
}

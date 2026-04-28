use crate::config::AgentConfig;

pub fn build_system_prompt(config: &AgentConfig, pubkey_hex: &str, working_dir: &str) -> String {
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

    if let Some(instructions) = &config.instructions {
        parts.push(format!(
            "<agent-instructions>\n{instructions}\n</agent-instructions>"
        ));
    }

    // Fragment 08: Workspace context
    parts.push(format!(
        "<project-context>\n  <workspace>\n    cwd: {working_dir}\n  </workspace>\n</project-context>"
    ));

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

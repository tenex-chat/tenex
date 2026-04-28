//! Pure assembly of an agent's system prompt.
//!
//! The output string is the cache anchor for downstream LLM calls; identical
//! inputs must yield byte-identical output. See the spec at
//! `docs/plans/2026-04-28-tenex-system-prompt-library.md`.

pub struct AgentIdentity {
    pub pubkey: String,
    pub name: String,
    pub instructions: Option<String>,
    pub category: Option<String>,
}

pub struct ProjectContext {
    pub working_dir: String,
    pub title: Option<String>,
    pub owner_pubkey: Option<String>,
}

pub struct SkillRef {
    pub name: String,
    pub when_to_use: String,
    pub load_tool_name: String,
}

pub fn build(
    agent: &AgentIdentity,
    project_ctx: &ProjectContext,
    available_skills: &[SkillRef],
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(6);

    parts.push(render_identity(agent));

    if let Some(instructions) = &agent.instructions {
        parts.push(format!(
            "<agent-instructions>\n{instructions}\n</agent-instructions>"
        ));
    }

    parts.push(render_project_context(project_ctx));

    if !available_skills.is_empty() {
        parts.push(render_available_skills(available_skills));
    }

    parts.push(TODO_GUIDANCE.to_string());
    parts.push(TOOL_DESCRIPTION_GUIDANCE.to_string());

    parts.join("\n\n")
}

fn render_identity(agent: &AgentIdentity) -> String {
    let short_pubkey = &agent.pubkey[..8];
    let mut s = format!(
        "<agent-identity>\nYour name: {} ({})\n",
        agent.name, short_pubkey,
    );
    if let Some(category) = &agent.category {
        s.push_str(&format!("Your category: {category}\n"));
    }
    s.push_str("</agent-identity>");
    s
}

fn render_project_context(ctx: &ProjectContext) -> String {
    let mut lines = vec![format!("    cwd: {}", ctx.working_dir)];
    if let Some(title) = &ctx.title {
        lines.push(format!("    project: {title}"));
    }
    if let Some(owner) = &ctx.owner_pubkey {
        lines.push(format!("    owner: {}", &owner[..8]));
    }
    format!(
        "<project-context>\n  <workspace>\n{}\n  </workspace>\n</project-context>",
        lines.join("\n")
    )
}

fn render_available_skills(skills: &[SkillRef]) -> String {
    let entries: Vec<String> = skills
        .iter()
        .map(|s| {
            format!(
                "  - {}\n    When to use: {}\n    Load with: {}",
                s.name, s.when_to_use, s.load_tool_name,
            )
        })
        .collect();
    format!(
        "<available-skills>\n{}\n</available-skills>",
        entries.join("\n")
    )
}

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

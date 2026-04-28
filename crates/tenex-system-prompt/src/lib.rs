//! Pure assembly of an agent's system prompt.
//!
//! The output string is the cache anchor for downstream LLM calls; identical
//! inputs must yield byte-identical output.

use std::path::Path;
pub use tenex_supervision::types::AgentCategory;

pub struct InjectedFile {
    pub filename: String,
    pub content: String,
    pub truncated: bool,
}

pub struct HomeDirectoryInfo<'a> {
    pub home_dir: &'a str,
    pub file_count: &'a str,
    pub injected_files: &'a [InjectedFile],
}

pub struct BuildSystemPromptInput<'a> {
    pub identity_name: &'a str,
    pub pubkey_hex: &'a str,
    pub category_str: Option<&'a str>,
    pub category: Option<AgentCategory>,
    pub instructions: Option<&'a str>,
    pub working_dir: &'a str,
    pub project_meta: Option<&'a tenex_project::ProjectMetadata>,
    pub agents: &'a [tenex_project::Agent],
    pub teams_fragment: &'a str,
    pub home: &'a HomeDirectoryInfo<'a>,
    pub preloaded_skills_block: Option<&'a str>,
}

fn render_home_directory(info: &HomeDirectoryInfo) -> String {
    let mut parts = vec![
        "<home-directory>".to_string(),
        format!(
            "You have a personal home directory at: `{}`. This is *your* space to use as you see fit. The contents of this directory are persistent and private to you.",
            info.home_dir
        ),
        String::new(),
        format!("**Current contents:** {}", info.file_count),
        String::new(),
        "Use this space for notes, helper scripts, temporary files, or any personal workspace needs. Use descriptive names for your files so you can easily find them later.".to_string(),
        String::new(),
        "**Shell env files:** Shell sessions automatically load environment variables from `.env` files with precedence `agent > project > global`. Your nsec is in your home directory's `.env` file as `NSEC`. `.env` contents are NOT injected into your prompt. Reference them in shell commands with normal shell expansion such as `$NSEC` or `$OPENAI_API_KEY`.".to_string(),
        String::new(),
        "**Note on ~:** The shell `~` expands to the user's real home directory (via `$HOME`), NOT your agent home. To access your agent home directory in shell commands, use `$AGENT_HOME`.".to_string(),
        String::new(),
        "**Auto-injected files:** Files starting with `+` (e.g., `+NOTES.md`) are automatically injected into your system prompt on every execution. Keep `+` files **lean and poignant** — only include things you genuinely need at *every* execution (standing rules, critical reminders, active constraints). Do NOT use `+` files for: status reports, task logs, one-off findings, transient state, or detailed reference material. Instead, write that content in a regular (non-`+`) file and add a brief reference to it from your `+` file so you can read it when relevant. Keep each `+` file under **100 lines** — if it exceeds that, extract the detail into a non-`+` file and replace it with a pointer.".to_string(),
    ];

    if !info.injected_files.is_empty() {
        parts.push(String::new());
        parts.push("<memorized-files>".to_string());
        for file in info.injected_files {
            let truncated_attr = if file.truncated { " truncated=\"true\"" } else { "" };
            parts.push(format!(
                "  <file name=\"{}\"{}>{}</file>",
                file.filename, truncated_attr, file.content
            ));
        }
        parts.push("</memorized-files>".to_string());
    }

    parts.push("</home-directory>".to_string());
    parts.join("\n")
}

const ORCHESTRATOR_GUIDANCE: &str = "## Orchestrator Guidance

You are an orchestrator. When the user says \"do X\", they are assigning responsibility for getting X done, not telling you that you personally must execute every step.

- Your first job is to evaluate who should handle the work.
- Prefer delegating execution to the most appropriate agent when another agent is better suited for the task.
- Treat yourself as the coordinator responsible for routing, sequencing, and quality control.
- Only do the work yourself when the task is genuinely orchestration work, delegation would add unnecessary overhead, or no better delegate exists.";

const DOMAIN_EXPERT_GUIDANCE: &str = "## Domain Expert Guidance

You are a domain expert. You do all work yourself — no exceptions.

- **NEVER delegate.** You have no delegation capability. Do the work directly using your own knowledge and available tools.
- **Refuse out-of-domain requests entirely.** If a request falls outside your domain of expertise, respond with exactly: \"I can't help with that — this is outside my domain of expertise.\" Do not attempt a partial answer, do not suggest who might help, do not pass it on. Just refuse.
- Your job is to answer questions and complete tasks within your domain. Nothing else.";

const DELEGATION_TIPS: &str = "## Delegation Tips

Delegate what needs to be done, not how — provide context but trust the delegatee's expertise. Delegation is async: you are automatically re-invoked when the delegatee completes; `delegate_followup` is for additional context or clarifying questions only.";

const TODO_BEFORE_DELEGATION: &str = "## Todo List

When delegating tasks, a todo list helps you track progress and stay organized.

- Use `todo_write()` to outline your workflow plan before or after delegating
- Include anticipated delegations so progress is visible
- Mark your current task as in_progress when delegating";

const AGENT_DIRECTED_MONITORING: &str = "## Monitoring Delegated Work

Delegation is **asynchronous**: after you call `delegate`, stop for the turn. The system automatically re-invokes you when the delegatee completes and returns their response.

- **Do not poll or wait** — there is no progress-check tool available. Stop after delegating and let the runtime re-invoke you.
- **Mid-flight corrections**: If you realise a delegatee needs clarification before they finish, use `delegate_followup` with the delegation event ID returned by `delegate`.
- **On re-invocation**: you will receive the delegatee's completion as your next message. Review it, update your todo list, and proceed with the next step.";

/// Build the full system prompt for an agent.
///
/// `category_str` is the raw string value from config (e.g. `"orchestrator"`) used
/// only for display in the identity fragment. `category` is the parsed enum used for
/// conditional fragment inclusion.
pub fn build_system_prompt(input: BuildSystemPromptInput<'_>) -> String {
    let BuildSystemPromptInput {
        identity_name,
        pubkey_hex,
        category_str,
        category,
        instructions,
        working_dir,
        project_meta,
        agents,
        teams_fragment,
        home,
        preloaded_skills_block,
    } = input;
    let mut parts: Vec<String> = Vec::new();

    // Fragment 01: Agent identity
    let short_pubkey = &pubkey_hex[..8.min(pubkey_hex.len())];
    parts.push(format!(
        "<agent-identity>\nYour name: {} ({})\n{}</agent-identity>",
        identity_name,
        short_pubkey,
        category_str
            .map(|c| format!("Your category: {c}\n"))
            .unwrap_or_default(),
    ));

    // Fragment 02: Home directory
    parts.push(render_home_directory(home));

    // Fragment 03: System reminders explanation
    parts.push(
        "<system-reminders-explanation>\n\
System messages may include `<system-reminders>` blocks, and tool results or user messages \
may include `<system-reminder>` tags. These are system-injected informational context — not \
user speech. They contain dynamic information such as behavioral guidance, context updates, \
and state notifications. They bear no direct relation to the surrounding message unless the \
reminder content says otherwise.\n\n\
System reminders are background context for you to absorb silently. Do not acknowledge, \
reference, or respond to them as if the user said something. Incorporate relevant information \
into your behavior naturally, but never surface the reminder itself in your response.\n\
</system-reminders-explanation>"
            .to_string(),
    );

    if let Some(instr) = instructions {
        parts.push(format!(
            "<agent-instructions>\n{instr}\n</agent-instructions>"
        ));
    }

    // Preloaded skills (from agent config default.skills + self_applied_skills)
    if let Some(block) = preloaded_skills_block {
        parts.push(block.to_string());
    }

    // Fragment 07: Environment variables (skipped for orchestrators — adds noise)
    if category != Some(AgentCategory::Orchestrator) {
        parts.push(
            "<environment-variables>\n\
These variables are available in shell commands and file tool path arguments.\n\
- $USER_HOME, $AGENT_HOME, $PUBKEY, $NPUB\n\
- $PROJECT_BASE, $PROJECT_ID\n\
- $TENEX_BASE_DIR — TENEX data directory (agents, projects, teams, built-in skills)\n\n\
Your nsec and other secrets are in $AGENT_HOME/.env (auto-loaded in shell sessions).\n\
</environment-variables>"
                .to_string(),
        );
    }

    // Fragment 08: Workspace + project context (with AGENTS.md if present and small)
    let mut project_lines = vec![format!("    cwd: {working_dir}")];
    if let Some(meta) = project_meta {
        if let Some(title) = &meta.title {
            project_lines.push(format!("    project: {title}"));
        }
        if let Some(owner) = &meta.owner_pubkey {
            project_lines.push(format!("    owner: {}", &owner[..8.min(owner.len())]));
        }
    }
    let agents_md = read_agents_md(working_dir);
    let mut project_ctx = format!(
        "<project-context>\n  <workspace>\n{}\n  </workspace>",
        project_lines.join("\n")
    );
    if let Some(content) = agents_md {
        project_ctx.push_str(&format!("\n\n  <agents.md>\n{content}\n  </agents.md>"));
    }
    project_ctx.push_str("\n</project-context>");
    parts.push(project_ctx);

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

    // Category-specific guidance fragments
    if category == Some(AgentCategory::Orchestrator) {
        parts.push(ORCHESTRATOR_GUIDANCE.to_string());
    }

    if category == Some(AgentCategory::DomainExpert) {
        parts.push(DOMAIN_EXPERT_GUIDANCE.to_string());
    }

    if !matches!(category, Some(AgentCategory::DomainExpert) | Some(AgentCategory::Worker)) {
        parts.push(DELEGATION_TIPS.to_string());
        parts.push(TODO_BEFORE_DELEGATION.to_string());
    }

    if !matches!(category, Some(AgentCategory::DomainExpert) | Some(AgentCategory::Worker)) {
        parts.push(AGENT_DIRECTED_MONITORING.to_string());
    }

    parts.join("\n\n")
}

fn read_agents_md(working_dir: &str) -> Option<String> {
    let content = std::fs::read_to_string(Path::new(working_dir).join("AGENTS.md")).ok()?;
    if content.len() > 2000 { None } else { Some(content) }
}

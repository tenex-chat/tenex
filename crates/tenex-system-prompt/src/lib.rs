//! Pure assembly of an agent's system prompt.
//!
//! The output string is the cache anchor for downstream LLM calls; identical
//! inputs must yield byte-identical output.

mod guidance;
mod home;
mod reminders;
mod schedule;
mod telegram;

use guidance::{
    AGENT_DIRECTED_MONITORING, DELEGATION_TIPS, DOMAIN_EXPERT_GUIDANCE, ORCHESTRATOR_GUIDANCE,
    TODO_BEFORE_DELEGATION,
};
use home::render_home_directory;
pub use home::{HomeDirectoryInfo, InjectedFile};
pub use reminders::{
    render_conversation_reminders, ConversationRemindersForPrompt, ConversationSummary,
    DelegationParentRef,
};
use schedule::render_scheduled_tasks;
pub use schedule::{humanize_cron, ScheduledTaskForPrompt};
use telegram::{render_telegram_chat_context, TELEGRAM_DELIVERY_RULES};
pub use telegram::{TelegramChannelBinding, TelegramChatContextForPrompt};
pub use tenex_supervision::types::AgentCategory;

pub struct BuildSystemPromptInput<'a> {
    pub identity_name: &'a str,
    pub pubkey_hex: &'a str,
    pub category_str: Option<&'a str>,
    pub category: Option<AgentCategory>,
    pub instructions: Option<&'a str>,
    pub working_dir: &'a str,
    /// Absolute path to the project's root directory (used to render
    /// `$PROJECT_BASE`-relative paths in the workspace block).
    pub project_base_path: Option<&'a str>,
    pub project_meta: Option<&'a tenex_project::ProjectMetadata>,
    /// Project d-tag (short identifier used in Nostr NIP-33 coordinates).
    pub project_id: Option<&'a str>,
    /// Hex conversation ID (root event ID) for the current conversation.
    pub conversation_id: Option<&'a str>,
    pub root_agents_md: Option<&'a str>,
    pub agents: &'a [tenex_project::Agent],
    pub teams_fragment: &'a str,
    pub home: &'a HomeDirectoryInfo<'a>,
    pub preloaded_skills_block: Option<&'a str>,
    /// Telegram channel bindings for this agent in the current project.
    pub telegram_channel_bindings: &'a [TelegramChannelBinding],
    /// Telegram chat context for Fragment 33. `None` when the triggering event
    /// did not arrive via Telegram.
    pub telegram_chat_context: Option<TelegramChatContextForPrompt>,
    /// Fragment 22: the agent's own scheduled tasks (recurring + one-off).
    pub scheduled_tasks: &'a [ScheduledTaskForPrompt],
    /// Current git branch for this agent's working directory.
    pub current_branch: Option<&'a str>,
    /// All worktrees for this project (from `git worktree list`).
    pub worktrees: &'a [tenex_project::git::WorktreeInfo],
}

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
        project_base_path,
        project_meta,
        project_id,
        conversation_id,
        root_agents_md,
        agents,
        teams_fragment,
        home,
        preloaded_skills_block,
        telegram_channel_bindings,
        telegram_chat_context,
        scheduled_tasks,
        current_branch,
        worktrees,
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

    // Fragment 08: Project context
    {
        // Helper: render a path as $PROJECT_BASE-relative when possible.
        let relativize = |p: &str| -> String {
            if let Some(base) = project_base_path {
                if p == base {
                    return "$PROJECT_BASE".to_string();
                }
                // Strip the base prefix only when the path is a strict child.
                let base_with_sep = format!("{base}/");
                if let Some(rel) = p.strip_prefix(base_with_sep.as_str()) {
                    return format!("$PROJECT_BASE/{rel}");
                }
            }
            p.to_string()
        };

        let mut ctx_parts: Vec<String> = Vec::new();
        ctx_parts.push("<project-context>".to_string());

        // Header: title, project ID, owner, conversation ID
        if let Some(meta) = project_meta {
            if let Some(title) = &meta.title {
                ctx_parts.push(format!("  Title: \"{title}\""));
            }
        }
        if let Some(id) = project_id {
            ctx_parts.push(format!("  ID: {id}"));
        }
        if let Some(meta) = project_meta {
            if let Some(owner) = &meta.owner_pubkey {
                ctx_parts.push(format!(
                    "  Owner pubkey: \"{}\"",
                    &owner[..8.min(owner.len())]
                ));
            }
        }
        if let Some(conv_id) = conversation_id {
            ctx_parts.push(format!(
                "  Conversation ID: {}",
                &conv_id[..8.min(conv_id.len())]
            ));
        }

        // <workspace> block
        ctx_parts.push(String::new());
        ctx_parts.push("  <workspace>".to_string());
        if project_base_path.is_some() {
            ctx_parts.push("    root: $PROJECT_BASE".to_string());
        }
        if let Some(branch) = current_branch {
            ctx_parts.push(format!("    current-branch: {branch}"));
        }
        let other_worktrees: Vec<&tenex_project::git::WorktreeInfo> =
            worktrees.iter().filter(|w| !w.is_main).collect();
        if !other_worktrees.is_empty() {
            ctx_parts.push("    other worktrees:".to_string());
            for wt in &other_worktrees {
                let path_str = wt.path.to_str().unwrap_or_default();
                let rel = relativize(path_str);
                match &wt.branch {
                    Some(b) => ctx_parts.push(format!("      - {rel} (branch: {b})")),
                    None => ctx_parts.push(format!("      - {rel} (detached)")),
                }
            }
        }
        ctx_parts.push(format!("    cwd: {}", relativize(working_dir)));
        ctx_parts.push("  </workspace>".to_string());

        // <channels> block — Telegram bindings for send_message
        if !telegram_channel_bindings.is_empty() {
            ctx_parts.push(String::new());
            ctx_parts.push("  <channels>".to_string());
            ctx_parts.push("    These are alternative communication channels available to you via the send_message tool.".to_string());
            for binding in telegram_channel_bindings {
                let ch_type = binding.channel_type();
                ctx_parts.push(format!(
                    "    <telegram type=\"{ch_type}\" id=\"{}\" />",
                    binding.channel_id
                ));
            }
            ctx_parts.push("  </channels>".to_string());
        }

        // <agents.md> block
        if let Some(content) = root_agents_md {
            ctx_parts.push(String::new());
            ctx_parts.push("  <agents.md>".to_string());
            ctx_parts.push(content.trim().to_string());
            ctx_parts.push("  </agents.md>".to_string());
        }

        ctx_parts.push("</project-context>".to_string());
        parts.push(ctx_parts.join("\n"));
    }

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

    if !matches!(
        category,
        Some(AgentCategory::DomainExpert) | Some(AgentCategory::Worker)
    ) {
        parts.push(DELEGATION_TIPS.to_string());
        parts.push(TODO_BEFORE_DELEGATION.to_string());
    }

    if !matches!(
        category,
        Some(AgentCategory::DomainExpert) | Some(AgentCategory::Worker)
    ) {
        parts.push(AGENT_DIRECTED_MONITORING.to_string());
    }

    // Fragment 33: Telegram chat context (only when triggered via Telegram)
    if let Some(ctx) = telegram_chat_context {
        let rendered = render_telegram_chat_context(&ctx);
        if !rendered.is_empty() {
            parts.push(rendered);
        }
    }

    // Fragment 34: Telegram delivery rules (when agent has Telegram bindings)
    if !telegram_channel_bindings.is_empty() {
        parts.push(TELEGRAM_DELIVERY_RULES.to_string());
    }

    // Fragment 22: Scheduled tasks
    if !scheduled_tasks.is_empty() {
        parts.push(render_scheduled_tasks(scheduled_tasks));
    }

    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_input<'a>(
        home_info: &'a HomeDirectoryInfo<'a>,
        current_branch: Option<&'a str>,
        worktrees: &'a [tenex_project::git::WorktreeInfo],
    ) -> BuildSystemPromptInput<'a> {
        BuildSystemPromptInput {
            identity_name: "test-agent",
            pubkey_hex: "deadbeefdeadbeef",
            category_str: None,
            category: None,
            instructions: None,
            working_dir: "/repo/src",
            project_base_path: Some("/repo"),
            project_meta: None,
            project_id: None,
            conversation_id: None,
            root_agents_md: None,
            agents: &[],
            teams_fragment: "",
            home: home_info,
            preloaded_skills_block: None,
            telegram_channel_bindings: &[],
            telegram_chat_context: None,
            scheduled_tasks: &[],
            current_branch,
            worktrees,
        }
    }

    fn dummy_home() -> HomeDirectoryInfo<'static> {
        HomeDirectoryInfo {
            home_dir: "/home/agent",
            file_count: "0 files",
            injected_files: &[],
        }
    }

    #[test]
    fn workspace_no_branch_no_worktrees() {
        let home = dummy_home();
        let prompt = build_system_prompt(minimal_input(&home, None, &[]));
        assert!(prompt.contains("root: $PROJECT_BASE"));
        assert!(prompt.contains("cwd: $PROJECT_BASE/src"));
        assert!(!prompt.contains("current-branch"));
        assert!(!prompt.contains("other worktrees"));
    }

    #[test]
    fn workspace_branch_no_other_worktrees() {
        let home = dummy_home();
        let prompt = build_system_prompt(minimal_input(&home, Some("main"), &[]));
        assert!(prompt.contains("current-branch: main"));
        assert!(!prompt.contains("other worktrees"));
        assert!(prompt.contains("cwd: $PROJECT_BASE/src"));
    }

    #[test]
    fn workspace_branch_with_other_worktrees() {
        use std::path::PathBuf;
        let home = dummy_home();
        let worktrees = vec![
            tenex_project::git::WorktreeInfo {
                path: PathBuf::from("/repo"),
                branch: Some("main".to_string()),
                commit: "aaa".to_string(),
                is_main: true,
            },
            tenex_project::git::WorktreeInfo {
                path: PathBuf::from("/repo/.worktrees/feature_auth"),
                branch: Some("feature/auth".to_string()),
                commit: "bbb".to_string(),
                is_main: false,
            },
            tenex_project::git::WorktreeInfo {
                path: PathBuf::from("/repo/.worktrees/bugfix_typo"),
                branch: Some("bugfix/typo".to_string()),
                commit: "ccc".to_string(),
                is_main: false,
            },
        ];
        let prompt = build_system_prompt(minimal_input(&home, Some("main"), &worktrees));
        assert!(prompt.contains("current-branch: main"));
        assert!(prompt.contains("other worktrees:"));
        assert!(prompt.contains("$PROJECT_BASE/.worktrees/feature_auth (branch: feature/auth)"));
        assert!(prompt.contains("$PROJECT_BASE/.worktrees/bugfix_typo (branch: bugfix/typo)"));
        // cwd is last inside the <workspace> block
        let workspace_start = prompt.find("<workspace>").unwrap();
        let workspace_end = prompt.find("</workspace>").unwrap();
        let workspace_block = &prompt[workspace_start..workspace_end];
        let cwd_pos = workspace_block.find("cwd:").unwrap();
        let other_pos = workspace_block.find("other worktrees:").unwrap();
        assert!(cwd_pos > other_pos, "cwd must appear after other worktrees");
    }
}

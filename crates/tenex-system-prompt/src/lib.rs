//! Pure assembly of an agent's system prompt.
//!
//! The output string is the cache anchor for downstream LLM calls; identical
//! inputs must yield byte-identical output.

mod guidance;
mod home;
mod telegram;

use guidance::{
    AGENT_DIRECTED_MONITORING, DELEGATION_TIPS, DOMAIN_EXPERT_GUIDANCE, ORCHESTRATOR_GUIDANCE,
    TODO_BEFORE_DELEGATION,
};
use home::render_home_directory;
pub use home::{HomeDirectoryInfo, InjectedFile};
use telegram::{render_telegram_chat_context, TELEGRAM_DELIVERY_RULES};
pub use telegram::{TelegramChannelBinding, TelegramChatContextForPrompt};
pub use tenex_supervision::types::AgentCategory;

/// A single conversation shown in the reminders overlay.
pub struct ConversationSummary {
    /// First 8 hex chars of the conversation ID.
    pub id_short: String,
    /// Human-readable title, if available.
    pub title: Option<String>,
    /// Human-readable relative time string, e.g. "3 minutes ago".
    pub last_active_human: String,
}

/// The delegation parent for the current conversation, if any.
pub struct DelegationParentRef {
    /// First 8 hex chars of the parent conversation ID.
    pub id_short: String,
    /// Human-readable title, if available.
    pub title: Option<String>,
}

/// Data needed to render the `<conversation-reminders>` block.
pub struct ConversationRemindersForPrompt {
    /// Other active/recent conversations in this project (excludes current).
    pub active_conversations: Vec<ConversationSummary>,
    /// The parent conversation when this agent was delegated to.
    pub delegation_parent: Option<DelegationParentRef>,
}

/// A scheduled task entry for rendering in the system prompt (Fragment 22).
pub struct ScheduledTaskForPrompt {
    pub id: String,
    pub cron_expr: String,
    pub description: String,
    /// Unix timestamp (milliseconds) for the next scheduled run, if known.
    pub next_run_ms: Option<i64>,
    /// Whether this is a one-off task (true) or recurring (false).
    pub is_oneoff: bool,
}

/// Convert a cron expression to a human-readable description.
///
/// Handles `@hourly`, `@daily`, `@weekly`, `@monthly` presets and the most
/// common 5-field patterns. Falls back to the raw expression for anything
/// unrecognised.
pub fn humanize_cron(expr: &str) -> String {
    match expr {
        "@hourly" => return "Every hour".to_string(),
        "@daily" | "@midnight" => return "Every day at 00:00 UTC".to_string(),
        "@weekly" => return "Every Sunday at 00:00 UTC".to_string(),
        "@monthly" => return "On the 1st of every month at 00:00 UTC".to_string(),
        "@yearly" | "@annually" => return "On January 1st at 00:00 UTC".to_string(),
        _ => {}
    }

    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return expr.to_string();
    }
    let (minute, hour, dom, month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

    // Every minute
    if minute == "*" && hour == "*" && dom == "*" && month == "*" && dow == "*" {
        return "Every minute".to_string();
    }
    // Every N minutes
    if let Some(n) = minute.strip_prefix("*/") {
        if hour == "*" && dom == "*" && month == "*" && dow == "*" {
            return format!("Every {n} minutes");
        }
    }
    // Every N hours at minute M
    if let Some(n) = hour.strip_prefix("*/") {
        if dom == "*" && month == "*" && dow == "*" {
            return format!("Every {n} hours at minute {minute}");
        }
    }
    // Every hour at minute M
    if hour == "*" && dom == "*" && month == "*" && dow == "*" {
        return format!("Every hour at minute {minute}");
    }
    // Daily at HH:MM
    if dom == "*" && month == "*" && dow == "*" {
        let hh = hour.parse::<u8>().map(|h| format!("{h:02}")).unwrap_or_else(|_| hour.to_string());
        let mm = minute.parse::<u8>().map(|m| format!("{m:02}")).unwrap_or_else(|_| minute.to_string());
        return format!("Daily at {hh}:{mm} UTC");
    }
    // Weekly on DOW at HH:MM
    if dom == "*" && month == "*" {
        let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        let day_name = dow
            .parse::<usize>()
            .ok()
            .and_then(|i| days.get(i))
            .copied()
            .unwrap_or(dow);
        let hh = hour.parse::<u8>().map(|h| format!("{h:02}")).unwrap_or_else(|_| hour.to_string());
        let mm = minute.parse::<u8>().map(|m| format!("{m:02}")).unwrap_or_else(|_| minute.to_string());
        return format!("Every {day_name} at {hh}:{mm} UTC");
    }
    // Monthly on day N at HH:MM
    if month == "*" {
        let hh = hour.parse::<u8>().map(|h| format!("{h:02}")).unwrap_or_else(|_| hour.to_string());
        let mm = minute.parse::<u8>().map(|m| format!("{m:02}")).unwrap_or_else(|_| minute.to_string());
        return format!("Monthly on day {dom} at {hh}:{mm} UTC");
    }

    expr.to_string()
}

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
    /// Active/recent conversation overlay. `None` skips the block entirely.
    pub conversation_reminders: Option<&'a ConversationRemindersForPrompt>,
    /// Fragment 22: the agent's own scheduled tasks (recurring + one-off).
    pub scheduled_tasks: &'a [ScheduledTaskForPrompt],
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
        conversation_reminders,
        scheduled_tasks,
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

    // Conversation reminders overlay (active/recent conversations + delegation parent)
    if let Some(reminders) = conversation_reminders {
        if let Some(rendered) = render_conversation_reminders(reminders) {
            parts.push(rendered);
        }
    }

    parts.join("\n\n")
}

fn render_scheduled_tasks(tasks: &[ScheduledTaskForPrompt]) -> String {
    let recurring: Vec<&ScheduledTaskForPrompt> = tasks.iter().filter(|t| !t.is_oneoff).collect();
    let oneoff: Vec<&ScheduledTaskForPrompt> = tasks.iter().filter(|t| t.is_oneoff).collect();

    let mut sections: Vec<String> = Vec::new();

    if !recurring.is_empty() {
        let lines: Vec<String> = recurring
            .iter()
            .map(|t| {
                let human = humanize_cron(&t.cron_expr);
                format!(
                    "- **{}** [recurring]: {} (cron: `{}`)\n  ID: `{}`",
                    t.description, human, t.cron_expr, t.id
                )
            })
            .collect();
        sections.push(format!("### Recurring Tasks\n{}", lines.join("\n\n")));
    }

    if !oneoff.is_empty() {
        let lines: Vec<String> = oneoff
            .iter()
            .map(|t| {
                let when = t
                    .next_run_ms
                    .map(|ms| {
                        let secs = ms / 1000;
                        format!("at unix timestamp {secs}")
                    })
                    .unwrap_or_else(|| "at unknown time".to_string());
                format!(
                    "- **{}** [one-off]: Executes {}\n  ID: `{}`",
                    t.description, when, t.id
                )
            })
            .collect();
        sections.push(format!("### One-off Tasks\n{}", lines.join("\n\n")));
    }

    let total = tasks.len();
    let summary = if total == 1 {
        "1 scheduled task".to_string()
    } else {
        format!(
            "{total} scheduled tasks ({} recurring, {} one-off)",
            recurring.len(),
            oneoff.len()
        )
    };

    format!(
        "<scheduled-tasks>\nYou have {summary} that will trigger automatically:\n\n{}\n\nUse `kill` to remove any task by ID.\n</scheduled-tasks>",
        sections.join("\n\n")
    )
}

fn render_conversation_reminders(reminders: &ConversationRemindersForPrompt) -> Option<String> {
    let has_active = !reminders.active_conversations.is_empty();
    let has_parent = reminders.delegation_parent.is_some();
    if !has_active && !has_parent {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("<conversation-reminders>".to_string());

    if has_active {
        lines.push("Active conversations in this project:".to_string());
        for conv in &reminders.active_conversations {
            let title = conv
                .title
                .as_deref()
                .unwrap_or("(untitled)");
            lines.push(format!(
                "- {} [id: {}] — last activity {}",
                title, conv.id_short, conv.last_active_human
            ));
        }
    }

    if let Some(parent) = &reminders.delegation_parent {
        let title = parent.title.as_deref().unwrap_or("(untitled)");
        lines.push(format!(
            "Delegation parent: {} [id: {}]",
            title, parent.id_short
        ));
    }

    lines.push("</conversation-reminders>".to_string());
    Some(lines.join("\n"))
}

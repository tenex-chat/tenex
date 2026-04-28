//! `tenex doctor` — diagnose and repair TENEX state.
//!
//! Source: `src/commands/doctor.ts:74-78`. Top-level command is a parent
//! that **only dispatches to subcommands**; invoking `tenex doctor` with
//! no subcommand prints commander's auto-generated help. Per spec doc 11
//! §1.1 there is **no global "run-all" flow** — the Rust port must not
//! invent one.
//!
//! Subcommand dependency status:
//!
//! | Subcommand | Depends on | Status |
//! |---|---|---|
//! | `agents refetch` | NDK + AgentStorage (spec doc 10) | pending — honest hint |
//! | `agents orphans [--purge]` | AgentStorage + project-membership reader | pending — honest hint |
//! | `agents categorize [--dry-run]` | AgentStorage + LLM service | pending — honest hint |
//! | `migrate` | TS-side state migration registry | n/a — Rust port has no legacy state to migrate; clean no-op exit |
//! | `conversations status` | conversation-index DB | pending — honest hint |
//! | `conversations reindex [--confirm]` | conversation-index DB | pending — honest hint |
//!
//! Per CLAUDE.md "no half-finished implementations" — every pending
//! subcommand surfaces a clear hint identifying which subsystem is
//! required and exits cleanly. None of them silently pretend to succeed.

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::tui::display;

#[derive(Parser, Clone)]
pub struct DoctorArgs {
    #[command(subcommand)]
    pub command: Option<DoctorCommand>,
}

#[derive(Subcommand, Clone)]
pub enum DoctorCommand {
    /// Agent diagnostics and repair
    Agents(AgentsArgs),
    /// Apply pending TENEX state migrations
    Migrate,
    /// Conversation indexing diagnostics and repair
    Conversations(ConversationsArgs),
}

#[derive(Parser, Clone)]
pub struct AgentsArgs {
    #[command(subcommand)]
    pub command: AgentsCommand,
}

#[derive(Subcommand, Clone)]
pub enum AgentsCommand {
    /// Refetch and update all agent definitions from Nostr
    Refetch,
    /// List agents not assigned to any project
    Orphans {
        /// Delete the orphaned agents found
        #[arg(long)]
        purge: bool,
    },
    /// Auto-categorize agents that lack an explicit or inferred category
    Categorize {
        /// Show what would be done without writing changes
        #[arg(long = "dry-run")]
        dry_run: bool,
    },
}

#[derive(Parser, Clone)]
pub struct ConversationsArgs {
    #[command(subcommand)]
    pub command: ConversationsCommand,
}

#[derive(Subcommand, Clone)]
pub enum ConversationsCommand {
    /// Check conversation indexing status
    Status,
    /// Force full re-index of all conversations
    Reindex {
        /// Skip the confirmation prompt
        #[arg(long)]
        confirm: bool,
    },
}

pub async fn run(args: DoctorArgs) -> Result<()> {
    let Some(command) = args.command else {
        // Bare `tenex doctor` prints help — clap handles this when the
        // subcommand is required, but ours is `Option<>` for ergonomics.
        // Surface the same hint commander emits.
        eprintln!(
            "tenex doctor: no subcommand specified. Try one of: agents, migrate, conversations.\n\
             See `tenex doctor --help` for the full subcommand list."
        );
        return Ok(());
    };

    match command {
        DoctorCommand::Agents(args) => run_agents(args).await,
        DoctorCommand::Migrate => run_migrate().await,
        DoctorCommand::Conversations(args) => run_conversations(args).await,
    }
}

async fn run_agents(args: AgentsArgs) -> Result<()> {
    match args.command {
        AgentsCommand::Refetch => {
            display::hint(
                "doctor agents refetch — depends on NDK client + AgentStorage \
                 (spec doc 10). Pending port.",
            );
            Ok(())
        }
        AgentsCommand::Orphans { purge } => find_orphaned_agents(purge),
        AgentsCommand::Categorize { dry_run } => {
            let _ = dry_run;
            display::hint(
                "doctor agents categorize — depends on AgentStorage + LLM \
                 service (spec doc 10 + 04). Pending port.",
            );
            Ok(())
        }
    }
}

/// Mirror `findOrphanedAgents` (`src/commands/doctor.ts:74-106`).
///
/// "Orphan" means: the agent's pubkey appears in zero persisted kind:31933
/// project events on disk. Membership is read via
/// [`crate::store::project_members::list_projects_for_agent`] (the canonical
/// source — agent storage's index is only a cache). Output strings are the
/// TS verbatim:
/// - "No orphaned agents found." (green)
/// - "Found N orphaned agent(s):" (yellow)
/// - "  <slug> (<pubkey-prefix-8>...)  [nostr:<event-id-prefix-10>|local]" (gray)
/// - "Purging N orphaned agent(s)..." (blue), "  ✓ deleted <slug>" (green),
///   "Done: N deleted" (blue)
fn find_orphaned_agents(purge: bool) -> Result<()> {
    use crate::store::agent_storage::{
        derive_agent_pubkey_from_nsec, AgentStorage,
    };
    use crate::store::project_members::list_projects_for_agent;

    let base_dir = crate::store::resolve_base_dir(None);
    let mut storage = AgentStorage::open(&base_dir)?;

    let stored = storage.get_all_stored_agents()?;
    let mut orphans: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    for (_filename_pubkey, agent) in stored {
        let nsec = agent.nsec().ok_or_else(|| {
            anyhow::anyhow!("stored agent missing nsec — refusing to scan further")
        })?;
        let pubkey = derive_agent_pubkey_from_nsec(nsec)?;
        let projects = list_projects_for_agent(&base_dir, &pubkey)?;
        if !projects.is_empty() {
            continue;
        }
        let slug = agent.slug().unwrap_or("?").to_string();
        let event_id = agent.event_id().map(str::to_owned);
        orphans.push((slug, pubkey, event_id, agent.name().map(str::to_owned)));
    }

    let green = console::Style::new().green();
    let yellow = console::Style::new().yellow();
    let gray = console::Style::new().color256(8); // chalk's default gray
    let blue = console::Style::new().blue();

    if orphans.is_empty() {
        println!("{}", green.apply_to("No orphaned agents found."));
        return Ok(());
    }

    println!(
        "{}",
        yellow.apply_to(format!("Found {} orphaned agent(s):", orphans.len()))
    );
    for (slug, pubkey, event_id, _name) in &orphans {
        let prefix8 = pubkey.get(..8).unwrap_or(pubkey.as_str());
        let source = match event_id {
            Some(eid) => {
                // `shortenEventId(eid)` = first 10 chars, lowercased
                // (`utils/conversation-id.ts:26-27`).
                let short: String = eid
                    .chars()
                    .take(10)
                    .map(|c| c.to_ascii_lowercase())
                    .collect();
                format!("nostr:{short}")
            }
            None => "local".to_string(),
        };
        println!(
            "{}",
            gray.apply_to(format!("  {slug} ({prefix8}...)  [{source}]"))
        );
    }

    if !purge {
        return Ok(());
    }

    println!();
    println!(
        "{}",
        blue.apply_to(format!("Purging {} orphaned agent(s)...", orphans.len()))
    );
    let mut deleted = 0usize;
    for (slug, pubkey, _, _) in &orphans {
        if storage.delete_agent(pubkey)? {
            println!("{}", green.apply_to(format!("  ✓ deleted {slug}")));
            deleted += 1;
        }
    }
    println!("{}", blue.apply_to(format!("Done: {deleted} deleted")));
    Ok(())
}

async fn run_migrate() -> Result<()> {
    // The TS migration registry is iterated in source order; pending ones
    // are applied and printed as "Applied migration <from> -> <to>: <desc>".
    // The Rust port maintains no legacy state files of its own — every
    // store layer was built fresh against the canonical TS schema — so
    // there are no migrations to apply. This is a faithful clean exit
    // matching what TS does when the migration registry is empty.
    let blue = console::Style::new().blue();
    println!(
        "{}",
        blue.apply_to("doctor migrate: 0 migrations applied (Rust port has no legacy state).")
    );
    Ok(())
}

async fn run_conversations(args: ConversationsArgs) -> Result<()> {
    match args.command {
        ConversationsCommand::Status => {
            display::hint(
                "doctor conversations status — depends on the conversation-\
                 index DB. Pending port.",
            );
            Ok(())
        }
        ConversationsCommand::Reindex { confirm } => {
            let _ = confirm;
            display::hint(
                "doctor conversations reindex — depends on the conversation-\
                 index DB. Pending port.",
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn doctor_top_level_has_three_subcommands() {
        // Source: spec doc 11 §1 — `agents`, `migrate`, `conversations`.
        let cmd = DoctorArgs::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert_eq!(names, vec!["agents", "migrate", "conversations"]);
    }

    #[test]
    fn agents_has_three_leaf_subcommands_in_canonical_order() {
        // Source: spec doc 11 §1 — `refetch`, `orphans`, `categorize`.
        let cmd = AgentsArgs::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert_eq!(names, vec!["refetch", "orphans", "categorize"]);
    }

    #[test]
    fn conversations_has_two_leaf_subcommands_in_canonical_order() {
        // Source: spec doc 11 §1 — `status`, `reindex`.
        let cmd = ConversationsArgs::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert_eq!(names, vec!["status", "reindex"]);
    }

    #[test]
    fn agents_orphans_exposes_purge_flag() {
        // Per spec 11 §1.2, the only flags in the doctor tree are
        // `--purge` (orphans), `--dry-run` (categorize), and `--confirm`
        // (reindex). Verify orphans has --purge.
        let agents = AgentsArgs::command();
        let orphans = agents.find_subcommand("orphans").unwrap();
        let arg_names: Vec<&str> = orphans
            .get_arguments()
            .filter_map(|a| a.get_long())
            .collect();
        assert!(arg_names.contains(&"purge"), "got: {arg_names:?}");
    }

    #[test]
    fn agents_categorize_exposes_dry_run_flag() {
        let agents = AgentsArgs::command();
        let cat = agents.find_subcommand("categorize").unwrap();
        let arg_names: Vec<&str> = cat.get_arguments().filter_map(|a| a.get_long()).collect();
        assert!(arg_names.contains(&"dry-run"), "got: {arg_names:?}");
    }

    #[test]
    fn conversations_reindex_exposes_confirm_flag() {
        let conv = ConversationsArgs::command();
        let reindex = conv.find_subcommand("reindex").unwrap();
        let arg_names: Vec<&str> = reindex
            .get_arguments()
            .filter_map(|a| a.get_long())
            .collect();
        assert!(arg_names.contains(&"confirm"), "got: {arg_names:?}");
    }

    #[test]
    fn doctor_tree_has_no_verbose_or_quiet_flags_anywhere() {
        // Spec 11 §1.2 explicitly forbids these.
        let cmd = DoctorArgs::command();
        for sub in cmd.get_subcommands() {
            for arg in sub.get_arguments() {
                let long = arg.get_long().unwrap_or("");
                assert!(
                    long != "verbose" && long != "quiet" && long != "v",
                    "found forbidden flag --{long} on {}",
                    sub.get_name()
                );
            }
            for nested in sub.get_subcommands() {
                for arg in nested.get_arguments() {
                    let long = arg.get_long().unwrap_or("");
                    assert!(
                        long != "verbose" && long != "quiet" && long != "v",
                        "found forbidden flag --{long} on {} {}",
                        sub.get_name(),
                        nested.get_name()
                    );
                }
            }
        }
    }

    #[test]
    fn agents_subcommand_descriptions_match_ts_verbatim() {
        // Source: spec doc 11 §1.
        let agents = AgentsArgs::command();
        let refetch = agents.find_subcommand("refetch").unwrap();
        assert_eq!(
            refetch.get_about().map(|s| s.to_string()).as_deref(),
            Some("Refetch and update all agent definitions from Nostr")
        );
        let orphans = agents.find_subcommand("orphans").unwrap();
        assert_eq!(
            orphans.get_about().map(|s| s.to_string()).as_deref(),
            Some("List agents not assigned to any project")
        );
        let cat = agents.find_subcommand("categorize").unwrap();
        assert_eq!(
            cat.get_about().map(|s| s.to_string()).as_deref(),
            Some("Auto-categorize agents that lack an explicit or inferred category")
        );
    }

    #[test]
    fn conversations_subcommand_descriptions_match_ts_verbatim() {
        let conv = ConversationsArgs::command();
        let status = conv.find_subcommand("status").unwrap();
        assert_eq!(
            status.get_about().map(|s| s.to_string()).as_deref(),
            Some("Check conversation indexing status")
        );
        let reindex = conv.find_subcommand("reindex").unwrap();
        assert_eq!(
            reindex.get_about().map(|s| s.to_string()).as_deref(),
            Some("Force full re-index of all conversations")
        );
    }

    #[test]
    fn migrate_description_matches_ts_verbatim() {
        // Source: spec doc 11 §1 — "Apply pending TENEX state migrations".
        let cmd = DoctorArgs::command();
        let migrate = cmd.find_subcommand("migrate").unwrap();
        assert_eq!(
            migrate.get_about().map(|s| s.to_string()).as_deref(),
            Some("Apply pending TENEX state migrations")
        );
    }
}

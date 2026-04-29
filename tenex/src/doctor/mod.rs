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
//! | `agents orphans [--purge]` | AgentStorage + project-membership reader | wired — see `find_orphaned_agents` |
//! | `agents categorize [--dry-run]` | AgentStorage + LLM service | pending — honest hint |
//! | `migrate` | TS-side state migration registry | reports current vs latest version; honest hint when behind (substrates pending) |
//! | `conversations status` | conversation-index DB | pending — honest hint |
//! | `conversations reindex [--confirm]` | conversation-index DB | pending — honest hint |
//!
//! Note: spec 11 §1 listed an `agents refetch` subcommand. That was removed
//! in TS commit `2855d63d` (kind:4199 / Nostr-event-driven agent install
//! cutover) — there's no longer anything to "refetch" from Nostr. The Rust
//! port matches the live TS source at `src/commands/doctor.ts:43-46`.
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
    /// List agents not assigned to any project
    Orphans {
        /// Delete orphaned agents
        #[arg(long)]
        purge: bool,
    },
    /// Auto-categorize agents that lack an explicit or inferred category
    Categorize {
        /// Show what would be categorized without making changes
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
        /// Skip confirmation prompt
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
        AgentsCommand::Orphans { purge } => find_orphaned_agents(purge),
        AgentsCommand::Categorize { dry_run } => preview_categorize(dry_run),
    }
}

/// Preview path for `tenex doctor agents categorize`. Mirrors the
/// observable stdout of `backfillAgentCategories`'s discovery phase
/// (`src/commands/doctor.ts:23-41` + `backfillAgentCategories.ts:30-39`):
/// counts agents already-categorised vs needing classification, then
/// surfaces an honest hint identifying the missing LLM substrate.
///
/// The full backfill substrate (`AgentStorage::update_inferred_category`,
/// the [`crate::agent_cmd::categorize::Categoriser`] trait,
/// `backfill_agent_categories`) is already in place. When the LLM service
/// lands, a `LlmCategoriser` impl drops in and this becomes:
///
/// ```ignore
/// let result = backfill_agent_categories(&mut storage, &llm_categoriser, opts)?;
/// println!("{}", blue.apply_to(format!(
///     "Processed: {}, Categorized: {}, Skipped: {}, Failed: {}",
///     result.processed, result.categorized, result.skipped, result.failed
/// )));
/// if result.failed > 0 { … exit 1 … }
/// ```
fn preview_categorize(dry_run: bool) -> Result<()> {
    use crate::store::agent_storage::AgentStorage;

    let base_dir = crate::store::resolve_base_dir(None);
    let storage = AgentStorage::open(&base_dir)?;

    let agents = storage.get_canonical_active_agents()?;
    let total = agents.len();
    let already = agents
        .iter()
        .filter(|a| a.category().is_some() || a.inferred_category().is_some())
        .count();
    let uncategorised = total - already;

    let blue = console::Style::new().blue();
    let mode = if dry_run { " (dry run)" } else { "" };
    println!(
        "{}",
        blue.apply_to(format!(
            "Total: {total}, Already categorised: {already}, Uncategorised: {uncategorised}{mode}"
        ))
    );
    if uncategorised == 0 {
        let green = console::Style::new().green();
        println!(
            "{}",
            green.apply_to("Nothing to categorise — all canonical agents already have a category.")
        );
        return Ok(());
    }
    display::hint(
        "Agent categorisation requires the LLM service \
         (spec doc 04 / categorizeAgent.ts) — pending port. The \
         AgentStorage scan, the Categoriser trait, the backfill \
         orchestrator, and the kebab-literal persistence are all wired; \
         only the per-agent LLM call is missing.",
    );
    Ok(())
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
    let gray = crate::tui::theme::chalk_gray();
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
            Some(eid) => format!("nostr:{}", crate::utils::identifiers::shorten_event_id(eid)),
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
    // TS source (`doctor.ts:101-105`) prints "  ✓ deleted <slug>" inside
    // the loop unconditionally and reports `orphans.length` on the final
    // line — even if a delete is a no-op. Match that exactly: the per-agent
    // line always fires, the final count is `orphans.len()`. (The
    // delete_agent return value indicates whether anything was on disk —
    // for orphans we just enumerated from the same storage, it's always
    // `Ok(true)` in practice; the `?` propagates real I/O errors.)
    for (slug, pubkey, _, _) in &orphans {
        storage.delete_agent(pubkey)?;
        println!("{}", green.apply_to(format!("  ✓ deleted {slug}")));
    }
    println!(
        "{}",
        blue.apply_to(format!("Done: {} deleted", orphans.len()))
    );
    Ok(())
}

/// Mirror `runMigrate` (`src/commands/doctor.ts:108-140`).
///
/// TS has three migrations registered (`src/services/migrations/migrations/`):
/// `unknown→1` relocates legacy schedules, `1→2` reindexes PrefixKVStore to
/// 10-char prefixes, `2→3` bundles built-in skills. Latest = 3.
///
/// The Rust port does not yet implement these migrations — the underlying
/// substrates (schedules store, PrefixKVStore, built-in skills bundle) are
/// pending ports. So we read the current `config.version` (the same field
/// TS migrates), surface it in the TS format, and exit non-zero with an
/// honest hint pointing to the TS binary if the user has unfinished
/// migrations. We never silently claim "0 applied" — that would mislead a
/// user whose state still needs `1→2` or `2→3`.
async fn run_migrate() -> Result<()> {
    use crate::store::tenex_config::TenexConfigDoc;
    const LATEST_MIGRATION_VERSION: u64 = 3;

    let base_dir = crate::store::resolve_base_dir(None);
    let doc = TenexConfigDoc::load(&base_dir)?;
    let current = doc.version();

    let blue = console::Style::new().blue();
    let current_str = current
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    println!(
        "{}",
        blue.apply_to(format!(
            "Current migration version: {current_str} (latest: {LATEST_MIGRATION_VERSION})"
        ))
    );

    if current == Some(LATEST_MIGRATION_VERSION) {
        let green = console::Style::new().green();
        println!("{}", green.apply_to("No pending migrations."));
        println!(
            "{}",
            blue.apply_to(format!("Final migration version: {LATEST_MIGRATION_VERSION}"))
        );
        return Ok(());
    }

    display::hint(
        "TS has migrations registered up to v3 (schedules relocation, \
         PrefixKVStore reindex, built-in skills bundle). The Rust port \
         doesn't yet implement them — run `tenex doctor migrate` from the \
         TS install to bring this base directory up to v3, then return here.",
    );
    std::process::exit(1);
}

async fn run_conversations(args: ConversationsArgs) -> Result<()> {
    match args.command {
        ConversationsCommand::Status => preview_conversations_status(),
        ConversationsCommand::Reindex { confirm } => reindex_conversations(confirm),
    }
}

/// Preview path for `tenex doctor conversations status`. Mirrors the
/// observable structural-enumeration phase of `checkConversationIndexingStatus`
/// (`src/commands/doctor.ts:174-230`) and surfaces an honest hint
/// identifying the missing DB-backed substrates (RAG collection stats,
/// indexing-job runtime status, embedding-state version breakdown).
///
/// What's wired: the local file walk (`list_project_ids_from_disk` →
/// `list_conversation_ids_from_project`) reports project counts +
/// per-project conversation file counts. That's the structural piece; it
/// matches what the TS source emits in the "Tracked conversations" line
/// when the SQLite catalog has been mirrored from disk.
///
/// What's gated: every line that needs the running embedding pipeline
/// (RAG stats, IndexingJob.getStatus, content-version breakdown via
/// `ConversationCatalogService.getEmbeddingState`).
fn preview_conversations_status() -> Result<()> {
    use crate::store::conversation_disk_reader::{
        list_conversation_ids_from_project, list_project_ids_from_disk,
    };

    let blue = console::Style::new().blue();
    let gray = crate::tui::theme::chalk_gray();
    let bold = console::Style::new().bold();

    println!("{}", blue.apply_to("Checking conversation indexing status...\n"));

    let base_dir = crate::store::resolve_base_dir(None);
    let project_ids = list_project_ids_from_disk(&base_dir);
    let mut total_conversations: usize = 0;
    let mut per_project: Vec<(String, usize)> = Vec::with_capacity(project_ids.len());
    for project_id in &project_ids {
        let convs = list_conversation_ids_from_project(&base_dir, project_id);
        total_conversations += convs.len();
        per_project.push((project_id.clone(), convs.len()));
    }

    println!("{}", bold.apply_to("On-disk conversation tree:"));
    println!(
        "{}",
        gray.apply_to(format!("  Projects: {}", project_ids.len()))
    );
    println!(
        "{}",
        gray.apply_to(format!("  Total conversation files: {total_conversations}"))
    );
    if !per_project.is_empty() {
        per_project.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        println!("{}", gray.apply_to("  Top projects by conversation count:"));
        for (project, n) in per_project.iter().take(5) {
            println!("{}", gray.apply_to(format!("    {project}: {n}")));
        }
    }

    println!();
    display::hint(
        "RAG collection stats, indexing-job runtime status, and the \
         content-version breakdown require the embedding pipeline + \
         SQLite catalog substrates (spec doc 11 §3) — pending port. \
         The local file enumeration above is faithful; the DB-backed \
         lines are gated.",
    );
    Ok(())
}

/// Mirror `reindexConversations` (`src/commands/doctor.ts:232-273`) up to
/// the actual `forceFullReindex()` call. The pre-flight confirmation
/// gate, prompt phrasing, exit-on-cancel behavior, and "Cancelled." line
/// are all wired byte-for-byte. The reindex itself surfaces the DB
/// substrate hint.
fn reindex_conversations(confirm: bool) -> Result<()> {
    use crate::tui::prompts;

    let yellow = console::Style::new().yellow();
    let gray = crate::tui::theme::chalk_gray();

    if !confirm {
        println!(
            "{}",
            yellow.apply_to(
                "This will clear all conversation indexing state and re-index all conversations.",
            )
        );
        println!(
            "{}",
            yellow.apply_to("This may take several minutes depending on the number of conversations.\n")
        );
        println!("{}", gray.apply_to("Run with --confirm to skip this prompt.\n"));

        let answer = match prompts::input("Continue? (yes/no):").prompt() {
            Ok(s) => s.trim().to_lowercase(),
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => {
                println!("{}", gray.apply_to("Cancelled."));
                return Ok(());
            }
            Err(e) => return Err(anyhow::anyhow!("reindex confirm prompt: {e}")),
        };
        if answer != "yes" && answer != "y" {
            println!("{}", gray.apply_to("Cancelled."));
            return Ok(());
        }
    }

    display::hint(
        "Re-indexing requires the embedding pipeline + SQLite catalog \
         substrates (spec doc 11 §3) — pending port. The confirmation \
         gate above is wired; the actual `indexingJob.forceFullReindex()` \
         call is gated.",
    );
    Ok(())
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
    fn agents_has_two_leaf_subcommands_in_canonical_order() {
        // Source: live TS at `src/commands/doctor.ts:43-46` — `orphans`,
        // `categorize`. Spec doc 11 §1 also listed `refetch` but that was
        // removed in TS commit `2855d63d` (kind:4199 cutover).
        let cmd = AgentsArgs::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert_eq!(names, vec!["orphans", "categorize"]);
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
        // Source: live TS at `src/commands/doctor.ts:17, 24`.
        let agents = AgentsArgs::command();
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

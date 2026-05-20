//! `tenex doctor` — diagnose and repair TENEX state.
//!
//! Top-level command is a parent that **only dispatches to subcommands**;
//! invoking `tenex doctor` with no subcommand prints help. Per spec doc 11
//! §1.1 there is **no global "run-all" flow**.
//!
//! Subcommand dependency status:
//!
//! | Subcommand | Depends on | Status |
//! |---|---|---|
//! | `agents orphans [--purge]` | AgentStorage + project-membership reader | wired — see `find_orphaned_agents` |
//! | `agents categorize [--dry-run]` | AgentStorage + LLM service | pending — honest hint |
//! | `migrate` | state migration registry | reports current vs latest version; honest hint when behind (substrates pending) |
//! | `conversations status` | conversation-index DB | pending — honest hint |
//! | `conversations reindex [--confirm]` | conversation-index DB | pending — honest hint |
//! | `conversations backfill <project> [--since N]` | conversation store + Nostr relay | wired |
//!
//! Note: spec 11 §1 listed an `agents refetch` subcommand. That was removed
//! during the kind:4199 / Nostr-event-driven agent install cutover; there's
//! no longer anything to "refetch" from Nostr.
//!
//! Per CLAUDE.md "no half-finished implementations" — every pending
//! subcommand surfaces a clear hint identifying which subsystem is
//! required and exits cleanly. None of them silently pretend to succeed.

use std::time::Duration;

use anyhow::{Context, Result};
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
    /// Auto-categorize agents that lack a category
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
    /// Fetch and ingest historical kind:1 events from Nostr relays into the
    /// conversation store. Idempotent — events already in the store are
    /// skipped. Runs to completion and exits; the daemon continues normally.
    Backfill {
        /// Project d-tag or NIP-33 coordinate (31933:<pubkey>:<dTag>).
        project_id: String,
        /// Unix timestamp lower bound. Defaults to 30 days ago.
        /// Pass 0 to fetch from the beginning of time.
        #[arg(long, value_name = "UNIX_TIMESTAMP")]
        since: Option<u64>,
    },
}

pub async fn run(args: DoctorArgs) -> Result<()> {
    let Some(command) = args.command else {
        // Bare `tenex doctor` prints help. Mirror commander.js's
        // behavior at TS `commands/doctor.ts:68-72` — when no
        // subcommand is given on a `new Command(...).addCommand(...)`
        // parent without an `.action(...)`, commander prints help to
        // stdout and exits 0. Use clap's auto-generated help so the
        // listing stays in sync with the actual subcommand tree.
        use clap::CommandFactory;
        let mut cmd = DoctorArgs::command();
        cmd.set_bin_name("tenex doctor");
        // print_help() writes to stdout; `?` propagates I/O errors.
        cmd.print_help()
            .map_err(|e| anyhow::anyhow!("print doctor help: {e}"))?;
        // Trailing newline so the prompt doesn't sit flush against the
        // last help line — matches commander.js's auto-output shape.
        println!();
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
        AgentsCommand::Categorize { dry_run } => {
            // Mirror the catch wrapper at `commands/doctor.ts:36-40`:
            //   const message = error instanceof Error ? error.message : String(error);
            //   console.error(chalk.red(`Failed to categorize agents: ${message}`));
            //   process.exit(1);
            // (No SIGINT/force-closed filter — TS doesn't filter for this
            // subcommand because there's no inquirer prompt in the path.)
            match preview_categorize(dry_run) {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!(
                        "{}",
                        crate::tui::theme::chalk_red(&format!("Failed to categorize agents: {e}")),
                    );
                    Err(e)
                }
            }
        }
    }
}

/// Preview path for `tenex doctor agents categorize`. Mirrors the
/// observable stdout of `backfillAgentCategories`'s discovery phase
/// (`src/commands/doctor.ts:23-41` + `backfillAgentCategories.ts:30-39`):
/// counts agents already-categorised vs needing classification, then
/// surfaces an honest hint identifying the missing LLM substrate.
///
/// The full backfill substrate (`AgentStorage::update_category`,
/// the [`crate::agent_cmd::categorize::Categorizer`] trait,
/// `backfill_agent_categories`) is already in place. When the LLM service
/// lands, a `LlmCategorizer` impl drops in and this becomes:
///
/// ```ignore
/// let result = backfill_agent_categories(&mut storage, &llm_categorizer, opts)?;
/// println!("{}", blue.apply_to(format!(
///     "Processed: {}, Categorized: {}, Skipped: {}, Failed: {}",
///     result.processed, result.categorized, result.skipped, result.failed
/// )));
/// if result.failed > 0 { … exit 1 … }
/// ```
fn preview_categorize(dry_run: bool) -> Result<()> {
    use tenex_agent_registry::AgentStorage;

    let base_dir = crate::store::resolve_base_dir(None);
    let storage = AgentStorage::open(&base_dir)?;

    let agents = storage.get_canonical_active_agents()?;
    let total = agents.len();
    let already = agents.iter().filter(|a| a.category().is_some()).count();
    let uncategorised = total - already;

    let mode = if dry_run { " (dry run)" } else { "" };
    println!(
        "{}",
        crate::tui::theme::chalk_blue(&format!(
            "Total: {total}, Already categorized: {already}, Uncategorized: {uncategorized}{mode}",
            uncategorized = uncategorised,
        )),
    );
    if uncategorised == 0 {
        println!(
            "{}",
            crate::tui::theme::chalk_green(
                "Nothing to categorize — all canonical agents already have a category.",
            ),
        );
        return Ok(());
    }
    display::hint(
        "Agents without a category are auto-classified by the LLM the \
         next time they boot (`tenex-agent` startup). To force batch \
         classification from this command, the LLM call needs to live \
         in a shared crate — wire it in when the operator-driven path \
         becomes load-bearing.",
    );
    Ok(())
}

/// Mirror `findOrphanedAgents` (`src/commands/doctor.ts:74-106`).
///
/// "Orphan" means: the agent's pubkey appears in zero persisted kind:31933
/// project events on disk. Membership is read via
/// [`crate::store::project_members::list_projects_for_agent`] (the canonical
/// source — the agent registry's index is only a cache). Output strings are the
/// TS verbatim:
/// - "No orphaned agents found." (green)
/// - "Found N orphaned agent(s):" (yellow)
/// - "  <slug> (<pubkey-prefix-8>...)  [nostr:<event-id-prefix-10>|local]" (gray)
/// - "Purging N orphaned agent(s)..." (blue), "  ✓ deleted <slug>" (green),
///   "Done: N deleted" (blue)
fn find_orphaned_agents(purge: bool) -> Result<()> {
    use crate::store::project_members::list_projects_for_agent;
    use tenex_agent_registry::{derive_agent_pubkey_from_nsec, AgentStorage};

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

    use crate::tui::theme::{chalk_blue, chalk_gray_str, chalk_green, chalk_yellow};

    if orphans.is_empty() {
        println!("{}", chalk_green("No orphaned agents found."));
        return Ok(());
    }

    println!(
        "{}",
        chalk_yellow(&format!("Found {} orphaned agent(s):", orphans.len())),
    );
    for (slug, pubkey, event_id, _name) in &orphans {
        let prefix8 = pubkey.get(..8).unwrap_or(pubkey.as_str());
        let source = match event_id {
            Some(eid) => format!("nostr:{}", crate::utils::identifiers::shorten_event_id(eid)),
            None => "local".to_string(),
        };
        println!(
            "{}",
            chalk_gray_str(&format!("  {slug} ({prefix8}...)  [{source}]")),
        );
    }

    if !purge {
        return Ok(());
    }

    // TS at doctor.ts:100 — `chalk.blue(\`\\nPurging ${N} orphaned
    // agent(s)...\`)` — the leading `\n` is INSIDE the blue wrap, not
    // a separate empty println.
    println!(
        "{}",
        chalk_blue(&format!("\nPurging {} orphaned agent(s)...", orphans.len())),
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
        println!("{}", chalk_green(&format!("  ✓ deleted {slug}")));
    }
    println!(
        "{}",
        chalk_blue(&format!("Done: {} deleted", orphans.len())),
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

    use crate::tui::theme::{chalk_blue, chalk_green};
    let current_str = current
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    println!(
        "{}",
        chalk_blue(&format!(
            "Current migration version: {current_str} (latest: {LATEST_MIGRATION_VERSION})"
        )),
    );

    if current == Some(LATEST_MIGRATION_VERSION) {
        // TS at `commands/doctor.ts:117-119` prints "No pending migrations."
        // and `return`s — does NOT emit a "Final migration version: …"
        // line in this branch (that line is only printed at line 139,
        // AFTER applied-migration entries, in the with-applied branch).
        // Mirror byte-for-byte by skipping the final-version line here.
        println!("{}", chalk_green("No pending migrations."));
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
        ConversationsCommand::Backfill { project_id, since } => {
            run_conversations_backfill(project_id, since).await
        }
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

    use crate::tui::theme::{chalk_blue, chalk_bold, chalk_gray_str};

    println!(
        "{}",
        chalk_blue("Checking conversation indexing status...\n"),
    );

    let base_dir = crate::store::resolve_base_dir(None);
    let project_ids = list_project_ids_from_disk(&base_dir);
    let mut total_conversations: usize = 0;
    let mut per_project: Vec<(String, usize)> = Vec::with_capacity(project_ids.len());
    for project_id in &project_ids {
        let convs = list_conversation_ids_from_project(&base_dir, project_id);
        total_conversations += convs.len();
        per_project.push((project_id.clone(), convs.len()));
    }

    println!("{}", chalk_bold("On-disk conversation tree:"));
    println!(
        "{}",
        chalk_gray_str(&format!("  Projects: {}", project_ids.len())),
    );
    println!(
        "{}",
        chalk_gray_str(&format!(
            "  Total conversation files: {total_conversations}"
        )),
    );
    if !per_project.is_empty() {
        per_project.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        println!(
            "{}",
            chalk_gray_str("  Top projects by conversation count:"),
        );
        for (project, n) in per_project.iter().take(5) {
            println!("{}", chalk_gray_str(&format!("    {project}: {n}")));
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

/// Fetch and ingest historical kind:1 events for the given project.
///
/// Connects to the configured relays, queries kind:1 events tagged with the
/// project coordinate (`#a = 31933:<owner>:<d-tag>`) from `since` to now,
/// then persists each unseen event into the conversation store. Already-stored
/// events (checked via `has_seen_event`) are skipped, making this safe to run
/// while the daemon is also writing to the same store (WAL mode + 5s
/// busy_timeout serialises concurrent writers).
async fn run_conversations_backfill(project_id: String, since: Option<u64>) -> Result<()> {
    use nostr_sdk::prelude::*;
    use tenex_conversations::{NewMessage, Project as ConversationsProject};
    use tenex_project::Project;

    let base_dir = crate::store::resolve_base_dir(None);
    let cfg = crate::daemon::config::load(&base_dir).context("loading config")?;

    let project = Project::open(&project_id, &base_dir)
        .with_context(|| format!("opening project '{project_id}'"))?;
    let meta = project
        .metadata()?
        .with_context(|| format!("project '{project_id}' has no event.json"))?;
    let owner_pubkey = meta
        .owner_pubkey
        .as_deref()
        .context("project metadata has no owner_pubkey")?;
    let project_addr = format!("31933:{}:{}", owner_pubkey, meta.d_tag);

    let store = ConversationsProject::open_conversations(&meta.d_tag, &base_dir)
        .context("opening conversation store")?;

    let keys = Keys::generate();
    let client = Client::new(keys);
    for relay in &cfg.relays {
        if let Err(e) = client.add_relay(relay.as_str()).await {
            eprintln!("warn: add_relay {relay}: {e}");
        }
    }
    client.connect().await;

    let thirty_days_ago = Timestamp::now().as_secs().saturating_sub(30 * 24 * 60 * 60);
    let since_ts = Timestamp::from(since.unwrap_or(thirty_days_ago));
    let until_ts = Timestamp::now();

    println!("Fetching kind:1 events for {project_addr} since {since_ts} ...");

    let filter = Filter::new()
        .kind(Kind::TextNote)
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::A),
            [project_addr.as_str()],
        )
        .since(since_ts)
        .until(until_ts);

    let events = client
        .fetch_events(filter, Duration::from_secs(30))
        .await
        .context("fetching events from relay")?;

    client.disconnect().await;

    let mut events: Vec<Event> = events.into_iter().collect();
    events.sort_by_key(|e| e.created_at);

    println!("Fetched {} events", events.len());

    let mut ingested = 0usize;
    let mut already_seen = 0usize;

    for event in &events {
        let event_id_hex = event.id.to_hex();
        if store.has_seen_event(&event_id_hex)? {
            already_seen += 1;
            continue;
        }

        let conv_id = tenex_protocol::event_filter::conversation_id_from_event(event);
        let ts = event.created_at.as_secs() as i64;

        let targeted_pubkeys: Vec<String> = event
            .tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                if parts.first().is_some_and(|h| h == "p") {
                    parts.get(1).cloned()
                } else {
                    None
                }
            })
            .collect();

        store.ensure_conversation(&conv_id)?;
        store.append_message(
            &conv_id,
            &NewMessage {
                record_id: format!("event:{event_id_hex}"),
                nostr_event_id: Some(event_id_hex),
                author_pubkey: event.pubkey.to_hex(),
                sender_pubkey: None,
                ral: None,
                message_type: "text".to_string(),
                role: Some("user".to_string()),
                content: event.content.clone(),
                timestamp: Some(ts),
                targeted_pubkeys: if targeted_pubkeys.is_empty() {
                    None
                } else {
                    Some(targeted_pubkeys)
                },
                sender_principal: None,
                targeted_principals: None,
                tool_data: None,
                delegation_marker: None,
                human_readable: None,
                transcript_tool_attributes: None,
            },
        )?;

        ingested += 1;
    }

    println!("Done: {ingested} ingested, {already_seen} already present");
    Ok(())
}

/// Mirror `reindexConversations` (`src/commands/doctor.ts:232-273`) up to
/// the actual `forceFullReindex()` call. The pre-flight confirmation
/// gate, prompt phrasing, exit-on-cancel behavior, and "Cancelled." line
/// are all wired byte-for-byte. The reindex itself surfaces the DB
/// substrate hint.
///
/// The TS source uses raw `readline.question(chalk.blue("Continue? (yes/no): "))`
/// (`commands/doctor.ts:238-246`) — NOT inquirer. So this site routes
/// directly through stdin/stdout to match: blue prompt text, no `?`
/// prefix, no inquirer help-line, trailing space inside the colored
/// span. Empty / EOF / non-yes answers fall through to "Cancelled.".
fn reindex_conversations(confirm: bool) -> Result<()> {
    use std::io::{self, BufRead, Write};

    use crate::tui::theme::{chalk_blue, chalk_gray_str, chalk_yellow};

    if !confirm {
        println!(
            "{}",
            chalk_yellow(
                "This will clear all conversation indexing state and re-index all conversations.",
            ),
        );
        println!(
            "{}",
            chalk_yellow(
                "This may take several minutes depending on the number of conversations.\n",
            ),
        );
        println!(
            "{}",
            chalk_gray_str("Run with --confirm to skip this prompt.\n")
        );

        // TS at `commands/doctor.ts:245`:
        //   rl.question(chalk.blue("Continue? (yes/no): "), resolve)
        // The trailing space is INSIDE the chalk.blue wrap. No newline
        // after the prompt — readline reads on the same line.
        print!("{}", chalk_blue("Continue? (yes/no): "));
        io::stdout()
            .flush()
            .map_err(|e| anyhow::anyhow!("flush reindex confirm prompt: {e}"))?;

        let mut line = String::new();
        let answer = match io::stdin().lock().read_line(&mut line) {
            Ok(_) => line.trim().to_lowercase(),
            Err(e) => return Err(anyhow::anyhow!("reindex confirm read: {e}")),
        };
        if answer != "yes" && answer != "y" {
            println!("{}", chalk_gray_str("Cancelled."));
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
    fn conversations_has_three_leaf_subcommands_in_canonical_order() {
        let cmd = ConversationsArgs::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        assert_eq!(names, vec!["status", "reindex", "backfill"]);
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
            Some("Auto-categorize agents that lack a category")
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

    /// Pin the reindex confirmation prompt's wire bytes.
    ///
    /// TS source (`commands/doctor.ts:245`):
    ///   `rl.question(chalk.blue("Continue? (yes/no): "), resolve)`
    /// The trailing space is INSIDE the chalk.blue wrap (consumed as part
    /// of the colored prompt run). Wire bytes: `\x1b[34m` + the literal
    /// `Continue? (yes/no): ` + `\x1b[39m`. No `?` prefix, no inquirer
    /// `[help]` footer, no SGR-0 full reset — those are inquire-isms that
    /// must NOT leak into this raw-readline-style prompt.
    #[test]
    fn reindex_confirm_prompt_matches_ts_chalk_blue_wire_bytes() {
        let s = crate::tui::theme::chalk_blue("Continue? (yes/no): ");
        assert_eq!(s, "\x1b[34mContinue? (yes/no): \x1b[39m");
        assert!(!s.contains("\x1b[0m"), "must not emit SGR 0 full reset");
    }

    /// Pin the two yellow warnings + gray hint preceding the reindex
    /// confirm prompt. TS source (`commands/doctor.ts:234-236`):
    ///   chalk.yellow("This will clear all conversation indexing state and re-index all conversations.")
    ///   chalk.yellow("This may take several minutes depending on the number of conversations.\n")
    ///   chalk.gray("Run with --confirm to skip this prompt.\n")
    /// Note the embedded `\n` in the second yellow line and the gray
    /// line — those produce the blank line separation TS emits.
    #[test]
    fn reindex_confirm_warnings_match_ts_verbatim() {
        use crate::tui::theme::{chalk_gray_str, chalk_yellow};
        assert_eq!(
            chalk_yellow(
                "This will clear all conversation indexing state and re-index all conversations.",
            ),
            "\x1b[33mThis will clear all conversation indexing state and re-index all conversations.\x1b[39m"
        );
        assert_eq!(
            chalk_yellow(
                "This may take several minutes depending on the number of conversations.\n",
            ),
            "\x1b[33mThis may take several minutes depending on the number of conversations.\n\x1b[39m"
        );
        assert_eq!(
            chalk_gray_str("Run with --confirm to skip this prompt.\n"),
            "\x1b[90mRun with --confirm to skip this prompt.\n\x1b[39m"
        );
    }
}

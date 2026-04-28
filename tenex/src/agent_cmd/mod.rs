//! `tenex agent` — manage TENEX agents.
//!
//! Description: "Manage TENEX agents" (matches TS
//! `src/commands/agent/index.ts:52`).
//!
//! Subcommands (default = manage), per the live TS surface at
//! `src/commands/agent/index.ts:38-58`:
//!
//! - `manage`              — open the interactive agent manager
//! - `delete <pubkey>`     — permanently delete a stored agent
//! - `import openclaw`     — import from a local OpenClaw installation
//!
//! Note: spec doc 10 §2 (`agent add` from a kind:4199 event) is **stale**.
//! Nostr-event-based agent installation (kinds 4199 / 14199 / 24012) was
//! removed in commit `2855d63d`. The current TS source has no `add`
//! subcommand — agents are created via the interactive manager or by
//! importing an OpenClaw installation. The Rust port matches this.

use anyhow::Result;
use clap::{Parser, Subcommand};

pub mod categorize;
pub mod manager_actions;
pub mod manager_logic;
pub mod openclaw_home;
pub mod openclaw_preview;
pub mod openclaw_reader;
pub mod provisioning;
pub mod telegram_config;

#[derive(Parser, Clone)]
pub struct AgentArgs {
    #[command(subcommand)]
    pub command: Option<AgentCommand>,
}

#[derive(Subcommand, Clone)]
pub enum AgentCommand {
    /// Permanently delete a stored agent.
    Delete {
        /// Agent public key.
        pubkey: String,
    },
    /// Open the interactive agent manager.
    Manage,
    /// Import agents from external sources.
    Import(ImportArgs),
}

#[derive(Parser, Clone)]
pub struct ImportArgs {
    #[command(subcommand)]
    pub command: ImportCommand,
}

#[derive(Subcommand, Clone)]
pub enum ImportCommand {
    /// Import agents from a local OpenClaw installation.
    Openclaw {
        /// Preview what would be imported without making changes.
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// Output as JSON array (implies --dry-run).
        #[arg(long)]
        json: bool,
        /// Copy workspace files instead of symlinking them.
        #[arg(long = "no-sync", action = clap::ArgAction::SetTrue)]
        no_sync: bool,
        /// Comma-separated list of agent IDs to import (default: all).
        #[arg(long, value_delimiter = ',')]
        slugs: Vec<String>,
    },
}

pub async fn run(args: AgentArgs) -> Result<()> {
    match args.command {
        None | Some(AgentCommand::Manage) => run_manage().await,
        Some(AgentCommand::Delete { pubkey }) => run_delete(&pubkey).await,
        Some(AgentCommand::Import(import)) => run_import(import).await,
    }
}

async fn run_manage() -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(None);
    manager_actions::show_main_menu(&base_dir).await
}

/// Mirror `tenex agent delete <pubkey>` (`src/commands/agent/index.ts:75-83,
/// 101-106`). Flow:
///
/// 1. Load AgentStorage and call `delete_agent(pubkey)` (local file +
///    index removal — see [`AgentStorage::delete_agent`]).
/// 2. If false (agent not found): red error → `process.exit(1)`.
/// 3. Else: best-effort kind:24011 inventory publish, then green success.
///
/// The TS source runs `initNDKWithBackendAuth()` first to attach the
/// signer used by the publish. The Rust port instead loads the backend
/// signer lazily inside `publish_installed_agents_inventory`. Net effect
/// is the same — the publish carries a backend-signed event that completes
/// any NIP-42 challenge.
async fn run_delete(pubkey: &str) -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(None);
    let deleted = provisioning::delete_stored_agent(
        &base_dir,
        pubkey,
        provisioning::DeleteOptions::new(),
    )
    .await?;

    if !deleted {
        let red = console::Style::new().red();
        eprintln!("{}", red.apply_to(format!("Error: agent {pubkey} not found")));
        // Mirror TS `process.exit(1)` (`commands/agent/index.ts:79-80`)
        // which exits silently — no anyhow wrapper line on stderr.
        std::process::exit(1);
    }

    let green = console::Style::new().green();
    println!("{}", green.apply_to(format!("✓ Deleted agent {pubkey}")));
    Ok(())
}

async fn run_import(import: ImportArgs) -> Result<()> {
    match import.command {
        ImportCommand::Openclaw {
            dry_run,
            json,
            no_sync,
            slugs,
        } => run_openclaw_import(dry_run, json, no_sync, slugs).await,
    }
}

/// Dispatch `tenex agent import openclaw`. Mirrors the early-exit and
/// empty-filter branches of `openclawImportCommand.action` at
/// `src/commands/agent/import/openclaw.ts:155-183` byte-for-byte.
///
/// The local pieces are wired here:
/// 1. Detect state directory → `[]` (json) or red+gray verbatim error
///    (default, exit 1) when not found.
/// 2. Read + filter agents → `[]` (json) or yellow "No matching…"
///    (default) when filter is empty.
///
/// The actual import (LLM distillation + per-agent home-dir
/// materialisation) surfaces an honest hint identifying the missing
/// substrate. The remaining `--no-sync` flag is parameter to that
/// downstream substrate; threaded through so future iterations don't
/// have to re-thread.
async fn run_openclaw_import(
    dry_run: bool,
    json: bool,
    no_sync: bool,
    slugs: Vec<String>,
) -> Result<()> {
    use crate::agent_cmd::{openclaw_preview, openclaw_reader};

    // ── 1. Detect state directory ─────────────────────────────────────
    let Some(state_dir) = openclaw_reader::detect_openclaw_state_dir() else {
        if json {
            println!("[]");
            return Ok(());
        }
        // Red error + gray "Checked: …" line, exit code 1.
        eprint!("{}", openclaw_preview::format_no_installation_detected());
        std::process::exit(1);
    };

    // ── 2. Read + filter agents ───────────────────────────────────────
    let all_agents = openclaw_reader::read_openclaw_agents(&state_dir)?;
    let filtered: Vec<openclaw_reader::OpenClawAgent> = openclaw_preview::filter_agents(
        &all_agents,
        &slugs,
    )
    .into_iter()
    .cloned()
    .collect();

    if filtered.is_empty() {
        if json {
            println!("[]");
        } else {
            let yellow = console::Style::new().yellow();
            println!("{}", yellow.apply_to("No matching OpenClaw agents found."));
        }
        return Ok(());
    }

    // ── 3. LLM distillation gate ──────────────────────────────────────
    //
    // Distill identities from the workspace files via an LLM, then either
    // (a) print the dry-run/JSON preview, or (b) write each agent through
    // `importOneAgent` (storage save + `create_home_dir` materialisation).
    //
    // The LLM service substrate is the only remaining gap. Surface an
    // honest hint citing what's blocking and the verified-local context
    // (`Found OpenClaw installation at: <stateDir>` is the same line TS
    // prints at `openclaw.ts:217-219` once it commits to the import path).
    let _ = (dry_run, no_sync);
    let blue = console::Style::new().blue();
    println!(
        "{}",
        blue.apply_to(format!("Found OpenClaw installation at: {}", state_dir.display()))
    );
    println!(
        "{}",
        blue.apply_to(format!("Found {} agent(s) to import.", filtered.len()))
    );
    crate::tui::display::hint(
        "Identity distillation requires the LLM service (spec doc 10 §5.1, \
         openclaw-distiller.ts) — pending port. The reader, slug derivation, \
         preview formatter, and home-dir materialisation are all wired; only \
         the per-agent LLM call is missing.",
    );
    Ok(())
}

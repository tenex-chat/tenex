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

use crate::store::agent_storage::AgentStorage;

pub mod manager_logic;

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
    crate::tui::display::hint(
        "tenex agent (manage) — interactive manager depends on NDK + the bespoke \
         agentSelect prompt (spec doc 10 §4). Pending port.",
    );
    Ok(())
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
    let mut storage = AgentStorage::open(&base_dir)?;

    let deleted = storage.delete_agent(pubkey)?;
    if !deleted {
        let red = console::Style::new().red();
        eprintln!("{}", red.apply_to(format!("Error: agent {pubkey} not found")));
        // Mirror TS `process.exit(1)` (`commands/agent/index.ts:79-80`)
        // which exits silently — no anyhow wrapper line on stderr.
        std::process::exit(1);
    }

    if let Err(e) =
        crate::nostr_pub::installed_agents::publish_installed_agents_inventory(&base_dir).await
    {
        // Mirror TS: warn-and-continue on publish failure
        // (`AgentProvisioningService.ts:28-32`).
        let yellow = console::Style::new().yellow();
        eprintln!(
            "{}",
            yellow.apply_to(format!(
                "Warning: failed to publish installed-agent inventory: {e}"
            ))
        );
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
        } => {
            let _ = (dry_run, json, no_sync, slugs);
            crate::tui::display::hint(
                "tenex agent import openclaw — depends on the OpenClaw reader + LLM \
                 distillation service (spec doc 10 §5). Pending port.",
            );
            Ok(())
        }
    }
}

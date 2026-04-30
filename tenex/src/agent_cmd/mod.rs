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

pub mod install;
pub mod manager_actions;
pub mod manager_logic;
pub mod openclaw_preview;
pub mod openclaw_reader;
pub mod provisioning;
pub mod telegram_config;

#[cfg(test)]
mod categorize;
#[cfg(test)]
mod openclaw_distiller;
#[cfg(test)]
pub mod openclaw_home;

#[derive(Parser, Clone)]
pub struct AgentArgs {
    #[command(subcommand)]
    pub command: Option<AgentCommand>,
}

#[derive(Subcommand, Clone)]
pub enum AgentCommand {
    /// Permanently delete a stored agent
    Delete {
        /// Agent public key
        pubkey: String,
    },
    /// Install an agent or team from a Nostr event (kind:4199 or kind:34199)
    Install {
        /// nevent1 bech32 reference to the agent or team definition event
        nevent: String,
    },
    /// Open the interactive agent manager
    Manage,
    /// Import agents from external sources
    Import(ImportArgs),
}

#[derive(Parser, Clone)]
pub struct ImportArgs {
    #[command(subcommand)]
    pub command: ImportCommand,
}

#[derive(Subcommand, Clone)]
pub enum ImportCommand {
    /// Import agents from a local OpenClaw installation
    Openclaw {
        /// Preview what would be imported without making changes
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// Output as JSON array (implies --dry-run)
        #[arg(long)]
        json: bool,
        /// Copy workspace files instead of symlinking them
        #[arg(long = "no-sync", action = clap::ArgAction::SetTrue)]
        no_sync: bool,
        /// Comma-separated list of agent IDs to import (default: all)
        #[arg(long, value_delimiter = ',')]
        slugs: Vec<String>,
    },
}

pub async fn run(args: AgentArgs) -> Result<()> {
    match args.command {
        None | Some(AgentCommand::Manage) => run_manage().await,
        Some(AgentCommand::Delete { pubkey }) => run_delete(&pubkey).await,
        Some(AgentCommand::Install { nevent }) => {
            let base_dir = crate::store::resolve_base_dir(None);
            install::run(&base_dir, &nevent).await
        }
        Some(AgentCommand::Import(import)) => run_import(import).await,
    }
}

async fn run_manage() -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(None);
    manager_actions::show_main_menu(&base_dir).await
}

/// Mirror `tenex agent delete <pubkey>` (`src/commands/agent/index.ts:26-34`,
/// command registration at `:44-49`). Flow:
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
    let deleted =
        provisioning::delete_stored_agent(&base_dir, pubkey, provisioning::DeleteOptions::new())
            .await?;

    if !deleted {
        eprintln!(
            "{}",
            crate::tui::theme::chalk_red(&format!("Error: agent {pubkey} not found")),
        );
        // Mirror TS `process.exit(1)` (`commands/agent/index.ts:31`)
        // which exits silently — no anyhow wrapper line on stderr.
        std::process::exit(1);
    }

    println!(
        "{}",
        crate::tui::theme::chalk_green(&format!("✓ Deleted agent {pubkey}")),
    );
    Ok(())
}

async fn run_import(import: ImportArgs) -> Result<()> {
    let result = match import.command {
        ImportCommand::Openclaw {
            dry_run,
            json,
            no_sync,
            slugs,
        } => run_openclaw_import(dry_run, json, no_sync, slugs).await,
    };
    // Mirror the catch wrapper at `agent/import/openclaw.ts:237-244`:
    //   const errorMessage = error instanceof Error ? error.message : String(error);
    //   if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
    //   console.error(chalk.red(`Import failed: ${errorMessage}`));
    //   process.exitCode = 1;
    // SIGINT/force-closed paths from inquire are caught at call sites
    // and converted into clean returns; only real failures reach here.
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = format!("{e}");
            if msg.contains("SIGINT") || msg.contains("force closed") {
                return Ok(());
            }
            eprintln!(
                "{}",
                crate::tui::theme::chalk_red(&format!("Import failed: {e}")),
            );
            Err(e)
        }
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
    let filtered: Vec<openclaw_reader::OpenClawAgent> =
        openclaw_preview::filter_agents(&all_agents, &slugs)
            .into_iter()
            .cloned()
            .collect();

    if filtered.is_empty() {
        if json {
            println!("[]");
        } else {
            println!(
                "{}",
                crate::tui::theme::chalk_yellow("No matching OpenClaw agents found."),
            );
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
    println!(
        "{}",
        crate::tui::theme::chalk_blue(&format!(
            "Found OpenClaw installation at: {}",
            state_dir.display()
        )),
    );
    println!(
        "{}",
        crate::tui::theme::chalk_blue(&format!("Found {} agent(s) to import.", filtered.len())),
    );
    crate::tui::display::hint(
        "Identity distillation requires the LLM service (spec doc 10 §5.1, \
         openclaw-distiller.ts) — pending port. The reader, slug derivation, \
         preview formatter, and home-dir materialisation are all wired; only \
         the per-agent LLM call is missing.",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Pin the descriptions that are visible in `--help`. They must match
    /// the TS source verbatim — no trailing periods (Commander.js doesn't
    /// add them; clap renders our doc comments verbatim).
    #[test]
    fn agent_subcommand_descriptions_match_ts_verbatim() {
        let cmd = AgentArgs::command();

        // `agent manage` — TS `agent/index.ts:39`.
        let manage = cmd.find_subcommand("manage").unwrap();
        assert_eq!(
            manage.get_about().map(|s| s.to_string()).as_deref(),
            Some("Open the interactive agent manager")
        );

        // `agent delete` — TS `agent/index.ts:45`.
        let delete = cmd.find_subcommand("delete").unwrap();
        assert_eq!(
            delete.get_about().map(|s| s.to_string()).as_deref(),
            Some("Permanently delete a stored agent")
        );

        // `agent import` parent — TS `agent/import/index.ts:5`.
        let import = cmd.find_subcommand("import").unwrap();
        assert_eq!(
            import.get_about().map(|s| s.to_string()).as_deref(),
            Some("Import agents from external sources")
        );
    }

    /// `agent import openclaw` description + flag descriptions (TS
    /// `agent/import/openclaw.ts:150-154`).
    #[test]
    fn agent_import_openclaw_descriptions_match_ts_verbatim() {
        let cmd = AgentArgs::command();
        let import = cmd.find_subcommand("import").unwrap();
        let openclaw = import.find_subcommand("openclaw").unwrap();

        assert_eq!(
            openclaw.get_about().map(|s| s.to_string()).as_deref(),
            Some("Import agents from a local OpenClaw installation")
        );

        let by_long: std::collections::HashMap<&str, String> = openclaw
            .get_arguments()
            .filter_map(|a| {
                let long = a.get_long()?;
                let help = a.get_help()?.to_string();
                Some((long, help))
            })
            .collect();
        assert_eq!(
            by_long.get("dry-run").map(|s| s.as_str()),
            Some("Preview what would be imported without making changes")
        );
        assert_eq!(
            by_long.get("json").map(|s| s.as_str()),
            Some("Output as JSON array (implies --dry-run)")
        );
        assert_eq!(
            by_long.get("no-sync").map(|s| s.as_str()),
            Some("Copy workspace files instead of symlinking them")
        );
        assert_eq!(
            by_long.get("slugs").map(|s| s.as_str()),
            Some("Comma-separated list of agent IDs to import (default: all)")
        );
    }
}

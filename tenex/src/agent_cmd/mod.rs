//! `tenex agent` — manage TENEX agents.
//!
//! Description: "Manage TENEX agents"
//! (matches TS `src/commands/agent/index.ts:109`).
//!
//! Five subcommands (default = manage). See `docs/tui-port/10-agent-commands.md`.

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser, Clone)]
pub struct AgentArgs {
    #[command(subcommand)]
    pub command: Option<AgentCommand>,
}

#[derive(Subcommand, Clone)]
pub enum AgentCommand {
    /// Add an agent (interactive when stdin is a TTY).
    Add,
    /// Delete an agent by pubkey.
    Delete {
        /// Agent pubkey (hex64 or npub).
        pubkey: String,
    },
    /// Open the interactive agent manager (default when no subcommand given).
    Manage,
    /// Import agents from another tool.
    Import(ImportArgs),
}

#[derive(Parser, Clone)]
pub struct ImportArgs {
    #[command(subcommand)]
    pub command: ImportCommand,
}

#[derive(Subcommand, Clone)]
pub enum ImportCommand {
    /// Import agents from an OpenClaw state directory.
    Openclaw {
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
        #[arg(long = "no-sync", action = clap::ArgAction::SetTrue)]
        no_sync: bool,
        #[arg(long, value_delimiter = ',')]
        slugs: Vec<String>,
    },
}

pub async fn run(_args: AgentArgs) -> Result<()> {
    eprintln!("agent: subcommands not yet ported.");
    Ok(())
}

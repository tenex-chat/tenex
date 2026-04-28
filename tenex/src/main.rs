mod agent_cmd;
mod config_cmd;
mod daemon;
mod doctor;
mod mcp_cmd;
mod onboard;
mod store;
mod tui;
mod types;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "tenex", version, about = "TENEX Command Line Interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Configure TENEX backend settings.
    Config(config_cmd::ConfigArgs),

    /// Initial setup wizard for TENEX.
    Onboard(onboard::OnboardArgs),

    /// Diagnose and repair TENEX state.
    Doctor(doctor::DoctorArgs),

    /// Manage TENEX agents.
    Agent(agent_cmd::AgentArgs),

    /// Manage project-level MCP servers (.mcp.json).
    Mcp(mcp_cmd::McpArgs),

    /// Run the project supervisor: subscribe to Nostr, boot a per-project
    /// runtime (`tenex-boot`) for each project that receives a kind:1 or
    /// kind:24000 trigger from a whitelisted pubkey, restart on crash.
    Daemon(daemon::DaemonArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    match cli.command {
        Command::Config(args) => config_cmd::run(args).await,
        Command::Onboard(args) => onboard::run(args).await,
        Command::Doctor(args) => doctor::run(args).await,
        Command::Agent(args) => agent_cmd::run(args).await,
        Command::Mcp(args) => mcp_cmd::run(args).await,
        Command::Daemon(args) => daemon::run(args).await,
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,nostr_sdk=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

mod agent_cmd;
mod config_cmd;
mod cron_cmd;
mod daemon;
mod doctor;
mod mcp_cmd;
mod nostr_pub;
mod onboard;
mod runtime_cmd;
mod store;
mod tui;
mod types;
mod utils;

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

    /// Browse, add, and remove scheduled tasks across all projects.
    Cron(cron_cmd::CronArgs),

    /// Run the project supervisor: subscribe to Nostr, spawn `tenex runtime
    /// <d-tag>` for each project that receives a kind:1 or kind:24000 trigger
    /// from a whitelisted pubkey, restart on crash.
    Daemon(daemon::DaemonArgs),

    /// Run a per-project Nostr orchestrator: subscribe, dispatch inbound
    /// kind:1 events to the right agent, publish completions.
    Runtime(runtime_cmd::RuntimeArgs),
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
        Command::Cron(args) => cron_cmd::run(args).await,
        Command::Daemon(args) => daemon::run(args).await,
        Command::Runtime(args) => runtime_cmd::run(args).await,
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,nostr_sdk=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

mod config;
mod daemon;
mod detector;
mod lockfile;
mod model;
mod paths;
mod publish;
mod resolver;
mod state;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use lockfile::Lockfile;

#[derive(Parser)]
#[command(
    name = "tenex-intervention",
    version,
    about = "Daemon that fires review-request events when users go silent after agent completions"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon in the foreground (default).
    Run,
    /// Print daemon status and pending/notified counts.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Run) {
        Command::Run => run_daemon().await,
        Command::Status => status(),
    }
}

async fn run_daemon() -> Result<()> {
    let _lock = Lockfile::acquire(&paths::pid_file())
        .context("acquire singleton lockfile (another tenex-intervention is already running)")?;

    let cfg = config::Config::load().context("load TENEX configuration")?;
    daemon::run(cfg).await
}

fn status() -> Result<()> {
    match Lockfile::probe(&paths::pid_file())? {
        Some(pid) => println!("running (pid {pid})"),
        None => println!("not running"),
    }
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,nostr_sdk=warn,nostr_relay_pool=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

mod categories;
mod config;
mod lockfile;
mod paths;
mod publish;
mod scheduler;
mod source;
mod state;
mod summarize;

use lockfile::Lockfile;

#[derive(Parser)]
#[command(
    name = "tenex-summarizer",
    version,
    about = "TENEX kind:513 metadata daemon"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the summarizer in the foreground (default).
    Run,
    /// Print daemon status.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Run) {
        Command::Run => run().await,
        Command::Status => status(),
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,nostr_sdk=warn,nostr_relay_pool=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

async fn run() -> Result<()> {
    let _lock = Lockfile::acquire(&paths::pid_file())
        .context("acquire singleton lockfile (another tenex-summarizer is already running)")?;

    let cfg = config::Config::load().context("load TENEX configuration")?;
    let state_db =
        state::SummaryStateStore::open(&paths::state_db()).context("open summarizer state db")?;

    scheduler::run(cfg, state_db).await
}

fn status() -> Result<()> {
    let pid_path = paths::pid_file();
    match Lockfile::probe(&pid_path)? {
        Some(pid) => {
            println!("running (pid {pid})");
            Ok(())
        }
        None => {
            println!("not running");
            Ok(())
        }
    }
}

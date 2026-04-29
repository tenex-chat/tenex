use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

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
    install_rustls_crypto_provider();
    let telemetry = tenex_telemetry::init("tenex-summarizer");

    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Run) {
        Command::Run => run().await,
        Command::Status => status(),
    };
    telemetry.shutdown();
    result
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
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

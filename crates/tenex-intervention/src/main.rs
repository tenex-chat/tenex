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
    let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
        service_name: "tenex-intervention".to_string(),
        base_dir: None,
        kind: tenex_telemetry::TelemetryKind::Subprocess,
        extra_resource: vec![],
    });

    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Run) {
        Command::Run => run_daemon().await,
        Command::Status => status(),
    };
    telemetry.shutdown();
    result
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

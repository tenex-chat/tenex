use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use tenex_embedder::backfill::{self, BackfillOptions};
use tenex_embedder::lockfile::Lockfile;
use tenex_embedder::paths;
use tenex_embedder::scheduler;

#[derive(Parser)]
#[command(
    name = "tenex-embedder",
    version,
    about = "TENEX conversation embedder — pulls kind:1 events from relays, walks forward, embeds"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon in the foreground (default).
    Run,
    /// Print daemon status.
    Status,
    /// One-shot bulk embed: walk forward through relay history.
    Backfill(BackfillArgs),
}

#[derive(clap::Args, Debug)]
struct BackfillArgs {
    /// Floor: never walk further back than this Unix timestamp (seconds).
    #[arg(long)]
    since: Option<i64>,
    /// Drop existing chunks + state for owned conversations and re-embed
    /// from `--since` (or 0).
    #[arg(long)]
    reset: bool,
    /// Override embeddings/sec (default 10).
    #[arg(long)]
    rate: Option<f64>,
    /// Page size for relay REQs (default 500).
    #[arg(long)]
    page_size: Option<usize>,
    /// Comma-separated relay URLs; overrides config.
    #[arg(long, value_delimiter = ',')]
    relays: Option<Vec<String>>,
    /// Don't write anything; print pages and counts only.
    #[arg(long)]
    dry_run: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init("tenex-embedder");

    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Run) {
        Command::Run => run().await,
        Command::Status => scheduler::print_status(),
        Command::Backfill(args) => {
            backfill::run(BackfillOptions {
                since_secs: args.since,
                reset: args.reset,
                rate_per_sec: args.rate,
                page_size: args.page_size,
                relays: args.relays,
                dry_run: args.dry_run,
            })
            .await
        }
    };

    telemetry.shutdown();
    result
}

async fn run() -> Result<()> {
    let pid_path = paths::pid_file(&paths::base_dir());
    let _lock = Lockfile::acquire(&pid_path)
        .context("acquire singleton lockfile (another tenex-embedder is already running)")?;
    scheduler::run().await
}

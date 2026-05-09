use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use tenex_embedder::backfill::{self, BackfillOptions};
use tenex_embedder::lockfile::Lockfile;
use tenex_embedder::paths;
use tenex_embedder::republish::{self, RepublishOptions};
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
    Run,
    Status,
    Backfill(BackfillArgs),
    RepublishLocal(RepublishLocalArgs),
}

#[derive(clap::Args, Debug)]
struct RepublishLocalArgs {
    #[arg(long, value_delimiter = ',')]
    relays: Option<Vec<String>>,
    #[arg(long, default_value_t = 50.0)]
    rate: f64,
    #[arg(long)]
    dry_run: bool,
}

#[derive(clap::Args, Debug)]
struct BackfillArgs {
    #[arg(long)]
    since: Option<i64>,
    #[arg(long)]
    reset: bool,
    #[arg(long)]
    rate: Option<f64>,
    #[arg(long)]
    page_size: Option<usize>,
    #[arg(long, value_delimiter = ',')]
    relays: Option<Vec<String>>,
    #[arg(long)]
    dry_run: bool,
    #[arg(long, value_delimiter = ',')]
    projects: Option<Vec<String>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
        service_name: "tenex-embedder".to_string(),
        base_dir: None,
        kind: tenex_telemetry::TelemetryKind::Subprocess,
        extra_resource: vec![],
    });

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
                project_filter: args.projects,
            })
            .await
        }
        Command::RepublishLocal(args) => {
            republish::run(RepublishOptions {
                relays: args.relays,
                rate_per_sec: args.rate,
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

mod config;
mod daemon;
mod lockfile;
mod model;
mod paths;
mod publish;
mod resolver;
mod storage;

use anyhow::{Context, Result};
use chrono::Utc;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use lockfile::Lockfile;
use model::{ScheduledTask, TaskType};

#[derive(Parser)]
#[command(name = "tenex-scheduler", version, about = "TENEX scheduled-task daemon")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon (subscribe to file changes, fire due tasks).
    Run,

    /// Print daemon status.
    Status,

    /// List all scheduled tasks.
    List {
        /// Restrict to a specific project dTag.
        #[arg(long)]
        project: Option<String>,
    },

    /// Add a recurring cron task.
    Add {
        /// Cron expression (5-field, e.g. "0 9 * * mon-fri").
        #[arg(long)]
        schedule: String,
        /// Prompt text to include in the kind:1 event content.
        #[arg(long)]
        prompt: String,
        /// Target agent slug.
        #[arg(long)]
        target: String,
        /// Project dTag.
        #[arg(long)]
        project: String,
        /// Optional task title.
        #[arg(long)]
        title: Option<String>,
        /// Optional e-tag for a channel event.
        #[arg(long)]
        channel: Option<String>,
        /// Optional override for the fromPubkey field.
        #[arg(long)]
        from: Option<String>,
    },

    /// Add a one-off task that fires once at a specific time.
    AddOnce {
        /// ISO 8601 timestamp to execute at.
        #[arg(long)]
        at: String,
        /// Prompt text.
        #[arg(long)]
        prompt: String,
        /// Target agent slug.
        #[arg(long)]
        target: String,
        /// Project dTag.
        #[arg(long)]
        project: String,
        /// Optional task title.
        #[arg(long)]
        title: Option<String>,
        /// Optional e-tag for a channel event.
        #[arg(long)]
        channel: Option<String>,
        /// Optional override for the fromPubkey field.
        #[arg(long)]
        from: Option<String>,
    },

    /// Remove a task by ID.
    Rm {
        /// Task ID.
        task_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    match cli.command {
        Command::Run => run_daemon().await,
        Command::Status => status(),
        Command::List { project } => list_tasks(project),
        Command::Add {
            schedule,
            prompt,
            target,
            project,
            title,
            channel,
            from,
        } => add_cron_task(schedule, prompt, target, project, title, channel, from),
        Command::AddOnce {
            at,
            prompt,
            target,
            project,
            title,
            channel,
            from,
        } => add_oneoff_task(at, prompt, target, project, title, channel, from),
        Command::Rm { task_id } => rm_task(task_id),
    }
}

async fn run_daemon() -> Result<()> {
    let _lock = Lockfile::acquire(&paths::pid_file())
        .context("acquire singleton lockfile (another tenex-scheduler is already running)")?;

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

fn list_tasks(project: Option<String>) -> Result<()> {
    let tasks = if let Some(d_tag) = project {
        storage::load_tasks(&d_tag)?
            .tasks
            .into_iter()
            .map(|t| (d_tag.clone(), t))
            .collect()
    } else {
        storage::all_tasks()?
    };

    if tasks.is_empty() {
        println!("no scheduled tasks");
        return Ok(());
    }

    println!("{:<20}  {:<12}  {:<28}  {}", "PROJECT", "ID", "SCHEDULE", "TITLE");
    println!("{}", "─".repeat(80));
    for (d_tag, task) in tasks {
        let title = task.title.as_deref().unwrap_or("—");
        let schedule = if task.is_oneoff() {
            task.execute_at.as_deref().unwrap_or(&task.schedule).to_string()
        } else {
            task.schedule.clone()
        };
        println!(
            "{:<20}  {:<12}  {:<28}  {}",
            truncate(&d_tag, 20),
            truncate(&task.id, 12),
            truncate(&schedule, 28),
            title
        );
    }
    Ok(())
}

fn add_cron_task(
    schedule: String,
    prompt: String,
    target: String,
    project: String,
    title: Option<String>,
    channel: Option<String>,
    from: Option<String>,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let from_pubkey = from.unwrap_or_default();

    let project_ref = build_project_ref(&project);

    let task = ScheduledTask {
        id: id.clone(),
        title,
        schedule,
        prompt,
        last_run: None,
        next_run: None,
        created_at: Some(now),
        from_pubkey,
        target_agent_slug: target,
        project_id: project.clone(),
        project_ref,
        task_type: Some(TaskType::Cron),
        execute_at: None,
        target_channel: channel,
    };

    storage::add_task(&project, task)?;
    println!("added cron task {id} to project {project}");
    Ok(())
}

fn add_oneoff_task(
    at: String,
    prompt: String,
    target: String,
    project: String,
    title: Option<String>,
    channel: Option<String>,
    from: Option<String>,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let from_pubkey = from.unwrap_or_default();
    let project_ref = build_project_ref(&project);

    let task = ScheduledTask {
        id: id.clone(),
        title,
        schedule: at.clone(),
        prompt,
        last_run: None,
        next_run: None,
        created_at: Some(now),
        from_pubkey,
        target_agent_slug: target,
        project_id: project.clone(),
        project_ref,
        task_type: Some(TaskType::Oneoff),
        execute_at: Some(at),
        target_channel: channel,
    };

    storage::add_task(&project, task)?;
    println!("added one-off task {id} to project {project}");
    Ok(())
}

fn rm_task(task_id: String) -> Result<()> {
    let d_tag = storage::find_project_for_task(&task_id)?
        .ok_or_else(|| anyhow::anyhow!("task {task_id} not found in any project"))?;

    storage::remove_task(&d_tag, &task_id)?;
    println!("removed task {task_id} from project {d_tag}");
    Ok(())
}

fn build_project_ref(d_tag: &str) -> Option<String> {
    // If the dTag looks like a NIP-33 coordinate, use it directly.
    // Otherwise we can't build a full ref without the author pubkey.
    if d_tag.contains(':') {
        Some(d_tag.to_string())
    } else {
        None
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
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

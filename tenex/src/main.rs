mod accounting_cmd;
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
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "tenex", version, about = "TENEX Command Line Interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Configure TENEX backend settings
    Config(config_cmd::ConfigArgs),

    /// Initial setup wizard for TENEX
    Onboard(onboard::OnboardArgs),

    /// Diagnose and repair TENEX state
    Doctor(doctor::DoctorArgs),

    /// Manage TENEX agents
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

    /// Inspect and serve the LLM accounting store.
    Accounting(accounting_cmd::AccountingArgs),

    /// Internal foreground identity daemon process supervised by `tenex daemon`.
    #[command(name = "identity-run", hide = true)]
    IdentityRun,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Normalize the TENEX base dir to an absolute path at process entry so
    // every descendant we spawn (telegram poller, runtime, agent, …) resolves
    // it identically regardless of the cwd it ends up running in. Without
    // this, a relative `--base-dir`/`TENEX_BASE_DIR` would land at different
    // physical directories per child, which silently breaks anything that
    // relies on a shared cache (e.g. the Telegram media gate).
    normalize_base_dir_env();

    let telemetry = {
        let (kind, service_name) = match &cli.command {
            Command::Daemon(_) => (tenex_telemetry::TelemetryKind::Daemon, "tenex-daemon"),
            Command::Runtime(_) => (tenex_telemetry::TelemetryKind::Subprocess, "tenex-runtime"),
            _ => (tenex_telemetry::TelemetryKind::Cli, "tenex-cli"),
        };
        tenex_telemetry::init(tenex_telemetry::TelemetryInit {
            service_name: service_name.to_string(),
            base_dir: command_base_dir(&cli.command).map(std::path::Path::to_path_buf),
            kind,
            extra_resource: vec![],
        })
    };
    let result = match cli.command {
        Command::Config(args) => config_cmd::run(args).await,
        Command::Onboard(args) => onboard::run(args).await,
        Command::Doctor(args) => doctor::run(args).await,
        Command::Agent(args) => agent_cmd::run(args).await,
        Command::Mcp(args) => mcp_cmd::run(args).await,
        Command::Cron(args) => cron_cmd::run(args).await,
        Command::Daemon(args) => daemon::run(args).await,
        Command::Runtime(args) => runtime_cmd::run(args).await,
        Command::Accounting(args) => accounting_cmd::run(args).await,
        Command::IdentityRun => tenex_identity::run_daemon_sync(),
    };
    telemetry.shutdown();
    result
}

fn normalize_base_dir_env() {
    let Ok(value) = std::env::var("TENEX_BASE_DIR") else {
        return;
    };
    // An empty `TENEX_BASE_DIR=` is documented to fall through to
    // `$HOME/.tenex`. Drop the empty value entirely so every helper that
    // reads the env var (not just `resolve_base_dir`) lands on the same
    // default, instead of some treating empty as cwd while others fall
    // through to `$HOME/.tenex` and the parent/child sockets diverge.
    if value.is_empty() {
        std::env::remove_var("TENEX_BASE_DIR");
        return;
    }
    let path = PathBuf::from(&value);
    if path.is_absolute() {
        return;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    std::env::set_var("TENEX_BASE_DIR", cwd.join(path));
}

fn command_base_dir(command: &Command) -> Option<&std::path::Path> {
    match command {
        Command::Daemon(args) => args.base_dir.as_deref(),
        Command::Runtime(args) => args.base_dir.as_deref(),
        Command::IdentityRun => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Pin top-level CLI descriptions visible via `tenex --help`.
    #[test]
    fn top_level_command_descriptions_are_stable() {
        let cmd = Cli::command();
        assert_eq!(
            cmd.get_about().map(|s| s.to_string()).as_deref(),
            Some("TENEX Command Line Interface"),
        );

        let by_name: std::collections::HashMap<&str, String> = cmd
            .get_subcommands()
            .map(|s| {
                (
                    s.get_name(),
                    s.get_about().map(|h| h.to_string()).unwrap_or_default(),
                )
            })
            .collect();

        assert_eq!(
            by_name.get("config").map(|s| s.as_str()),
            Some("Configure TENEX backend settings"),
        );
        assert_eq!(
            by_name.get("onboard").map(|s| s.as_str()),
            Some("Initial setup wizard for TENEX"),
        );
        assert_eq!(
            by_name.get("doctor").map(|s| s.as_str()),
            Some("Diagnose and repair TENEX state"),
        );
        assert_eq!(
            by_name.get("agent").map(|s| s.as_str()),
            Some("Manage TENEX agents"),
        );
    }
}

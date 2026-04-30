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
use clap::{Args, Parser, Subcommand};
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

    /// Internal foreground whitelist process supervised by `tenex daemon`.
    #[command(name = "whitelist-run", hide = true)]
    WhitelistRun(WhitelistRunArgs),

    /// Internal foreground identity daemon process supervised by `tenex daemon`.
    #[command(name = "identity-run", hide = true)]
    IdentityRun,
}

#[derive(Args)]
struct WhitelistRunArgs {
    /// TENEX base directory (default: $TENEX_BASE_DIR or ~/.tenex).
    #[arg(long, value_name = "PATH")]
    base_dir: Option<PathBuf>,
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

    let telemetry =
        tenex_telemetry::init_with_base_dir("tenex-daemon", command_base_dir(&cli.command));
    let result = match cli.command {
        Command::Config(args) => config_cmd::run(args).await,
        Command::Onboard(args) => onboard::run(args).await,
        Command::Doctor(args) => doctor::run(args).await,
        Command::Agent(args) => agent_cmd::run(args).await,
        Command::Mcp(args) => mcp_cmd::run(args).await,
        Command::Cron(args) => cron_cmd::run(args).await,
        Command::Daemon(args) => daemon::run(args).await,
        Command::Runtime(args) => runtime_cmd::run(args).await,
        Command::WhitelistRun(args) => {
            if let Some(base_dir) = args.base_dir {
                std::env::set_var("TENEX_BASE_DIR", base_dir);
            }
            tenex_whitelist::run_foreground()
        }
        Command::IdentityRun => tenex_identity::run_daemon_sync(),
    };
    telemetry.shutdown();
    result
}

fn normalize_base_dir_env() {
    let Ok(value) = std::env::var("TENEX_BASE_DIR") else {
        return;
    };
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
        Command::WhitelistRun(args) => args.base_dir.as_deref(),
        Command::IdentityRun => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Pin the top-level CLI's `about` string and the four TS-mirrored
    /// subcommand descriptions visible via `tenex --help`. They must
    /// match the TS source byte-for-byte:
    ///
    /// - top-level                — `src/index.ts:119`
    /// - `tenex config`           — `src/commands/config/index.ts:126`
    /// - `tenex onboard`          — `src/commands/onboard.ts:1200`
    /// - `tenex doctor`           — `src/commands/doctor.ts:69`
    /// - `tenex agent`            — `src/commands/agent/index.ts:52`
    ///
    /// The other entries (`mcp`, `cron`, `daemon`, `runtime`) are
    /// Rust-only surfaces — no TS counterpart, so their wording isn't
    /// pinned here.
    #[test]
    fn top_level_command_descriptions_match_ts_verbatim() {
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

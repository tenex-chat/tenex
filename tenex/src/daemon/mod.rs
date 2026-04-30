//! Project supervisor: subscribe to Nostr, boot per-project runtimes
//! (`tenex runtime <d-tag>`) when whitelisted authors send kind:1 / kind:24000
//! events a-tagging a known project, restart on crash.

pub mod config;
pub mod control_socket;
pub mod lockfile;
pub mod nostr;
pub mod supervisor;
pub mod whitelist_export;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::{error, info};

const COMPANION_DAEMONS: [&str; 4] = [
    "tenex-summarizer",
    "tenex-scheduler",
    "tenex-intervention",
    "tenex-telegram",
];

#[derive(Parser, Clone)]
pub struct DaemonArgs {
    /// TENEX base directory (default: $TENEX_BASE_DIR or ~/.tenex).
    #[arg(long, value_name = "PATH")]
    pub base_dir: Option<PathBuf>,

    /// Use this TypeScript command as the per-project runtime instead of the
    /// default Rust orchestrator; the d-tag is appended as a positional argument.
    #[arg(long, value_name = "CMD")]
    pub ts: Option<String>,

    /// Boot the project whose d-tag starts with this prefix as soon as it is
    /// discovered on Nostr, without waiting for a kind:1/24000 trigger.
    /// Repeatable. The prefix is matched against discovered d-tags as projects
    /// stream in; if multiple discoveries match, the first one wins and the
    /// later one is logged as ambiguous. Useful for local testing.
    #[arg(long = "boot", value_name = "D_TAG_PREFIX")]
    pub boot: Vec<String>,

    /// Do not start the scheduled-task companion daemon.
    #[arg(long)]
    pub disable_scheduled_jobs: bool,
}

pub async fn run(args: DaemonArgs) -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(args.base_dir.clone());

    // The whitelist daemon resolves its socket path from $TENEX_BASE_DIR / $HOME/.tenex.
    // If the operator passed --base-dir, propagate it to the env so the whitelist
    // daemon agrees with us on which socket to bind / which trust set to read.
    if args.base_dir.is_some() {
        std::env::set_var("TENEX_BASE_DIR", &base_dir);
    }

    let cfg = config::load(&base_dir)
        .with_context(|| format!("loading config from {}", base_dir.display()))?;
    info!(
        base_dir = %base_dir.display(),
        relays = ?cfg.relays,
        whitelisted = cfg.whitelisted_pubkeys.len(),
        "config loaded",
    );

    let _lock = lockfile::Lockfile::acquire(&base_dir).context("acquiring daemon lockfile")?;

    whitelist_export::write_backend_pubkey(&base_dir, cfg.tenex_private_key.as_deref())
        .context("publish backend pubkey for whitelist daemon")?;

    let boot_argv = if let Some(cmd) = args.ts {
        info!(boot_command = %cmd, "boot command resolved (--ts)");
        let argv = shell_words::split(&cmd).with_context(|| format!("parsing --ts: {cmd}"))?;
        if argv.is_empty() {
            return Err(anyhow::anyhow!("--ts is empty"));
        }
        argv
    } else {
        let argv = default_boot_argv();
        info!(boot_command = %argv.join(" "), "boot command resolved (default Rust runtime)");
        argv
    };

    let supervisor = supervisor::Supervisor::new(boot_argv, base_dir.clone());

    // Bootstrap the whitelist trust daemon as a supervised foreground child.
    // Every runtime gates inbound events through it and fails closed on socket
    // errors, so the daemon must be ready before any project runtime starts.
    if let Err(e) = start_whitelist_service(&supervisor, &base_dir).await {
        supervisor.shutdown().await;
        return Err(e);
    }
    info!("whitelist daemon ready");

    // Bootstrap the identity daemon. Runtime code relies on this service for
    // pubkey display names; fail startup if the socket cannot be reached.
    if let Err(e) = start_identity_service(&supervisor).await {
        supervisor.shutdown().await;
        return Err(e);
    }
    info!("identity daemon ready");

    // Start the LLM config IPC server. TypeScript runtimes resolve config
    // names and report key failures through this socket rather than reading
    // providers.json / llms.json directly.
    {
        let llm_base = base_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = tenex_llm_config::Server::start(llm_base).await {
                error!(error = %e, "llm-config IPC server failed");
            }
        });
    }
    info!("llm-config IPC server started");

    // Spawn host-level companion daemons. Binaries are expected alongside the
    // tenex binary (same target/ dir for cargo builds, same bin/ for installs).
    if args.disable_scheduled_jobs {
        info!("scheduled-task companion disabled by --disable-scheduled-jobs");
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in companion_daemon_names(args.disable_scheduled_jobs) {
                let path = dir.join(name);
                if path.exists() {
                    supervisor.boot_binary(name.to_string(), path).await;
                    info!(name, "companion daemon queued");
                } else {
                    tracing::warn!(name, "companion binary not found; skipping");
                }
            }
        }
    }

    // Bind the daemon control socket so transport bridges (tenex-telegram)
    // can request a per-project runtime boot on demand.
    {
        let supervisor = supervisor.clone();
        let base_dir = base_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = control_socket::serve(base_dir, supervisor).await {
                error!(error = %e, "daemon control socket exited");
            }
        });
    }

    if !args.boot.is_empty() {
        info!(prefixes = ?args.boot, "queued --boot prefixes; awaiting matching project discovery");
    }
    let mut nostr_handle = nostr::run(cfg, supervisor.clone(), args.boot).await?;

    // Publish the installed-agent inventory (kind:24011) immediately and then
    // every 30 seconds so Nostr clients always have a fresh view of what agents
    // are available on this installation.
    {
        let base_dir_clone = base_dir.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                if let Err(e) =
                    crate::nostr_pub::installed_agents::publish_installed_agents_inventory(
                        &base_dir_clone,
                    )
                    .await
                {
                    tracing::warn!(error = %e, "24011 inventory publish failed");
                }
            }
        });
    }

    tokio::select! {
        _ = wait_for_signal() => {
            info!("shutdown signal received");
        }
        res = &mut nostr_handle => {
            error!(?res, "nostr task exited unexpectedly; tearing down");
        }
    }

    nostr_handle.abort();
    supervisor.shutdown().await;
    Ok(())
}

fn companion_daemon_names(disable_scheduled_jobs: bool) -> Vec<&'static str> {
    COMPANION_DAEMONS
        .into_iter()
        .filter(|name| !disable_scheduled_jobs || *name != "tenex-scheduler")
        .collect()
}

async fn start_whitelist_service(
    supervisor: &supervisor::Supervisor,
    base_dir: &Path,
) -> Result<()> {
    let exe = std::env::current_exe().context("resolve current tenex executable")?;
    supervisor
        .boot_command(
            "tenex-whitelist".to_string(),
            vec![
                exe.to_string_lossy().into_owned(),
                "whitelist-run".to_string(),
                "--base-dir".to_string(),
                base_dir.to_string_lossy().into_owned(),
            ],
        )
        .await;

    tenex_whitelist::wait_until_ready(Duration::from_secs(5))
        .context("waiting for whitelist daemon readiness")
}

async fn start_identity_service(supervisor: &supervisor::Supervisor) -> Result<()> {
    let exe = std::env::current_exe().context("resolve current tenex executable")?;
    supervisor
        .boot_command(
            "tenex-identity".to_string(),
            vec![
                exe.to_string_lossy().into_owned(),
                "identity-run".to_string(),
            ],
        )
        .await;

    tenex_identity::wait_until_ready(Duration::from_secs(30))
        .context("waiting for identity daemon readiness")
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigint = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGINT handler");
            return;
        }
    };
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGTERM handler");
            return;
        }
    };
    tokio::select! {
        _ = sigint.recv() => {},
        _ = sigterm.recv() => {},
    }
}

fn default_boot_argv() -> Vec<String> {
    let exe = std::env::current_exe()
        .ok()
        .unwrap_or_else(|| PathBuf::from("tenex"));
    vec![exe.to_string_lossy().into_owned(), "runtime".to_string()]
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{companion_daemon_names, DaemonArgs};

    #[test]
    fn scheduled_jobs_are_enabled_by_default() {
        let args = DaemonArgs::parse_from(["tenex", "--boot", "project"]);

        assert!(!args.disable_scheduled_jobs);
        assert!(companion_daemon_names(args.disable_scheduled_jobs).contains(&"tenex-scheduler"));
    }

    #[test]
    fn disable_scheduled_jobs_omits_scheduler_companion() {
        let args = DaemonArgs::parse_from(["tenex", "--disable-scheduled-jobs"]);
        let names = companion_daemon_names(args.disable_scheduled_jobs);

        assert!(!names.contains(&"tenex-scheduler"));
        assert!(names.contains(&"tenex-summarizer"));
        assert!(names.contains(&"tenex-intervention"));
        assert!(names.contains(&"tenex-telegram"));
    }
}

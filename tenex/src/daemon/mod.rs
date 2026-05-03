//! Project supervisor: subscribe to Nostr, boot per-project runtimes
//! (`tenex runtime <d-tag>`) when whitelisted authors send kind:1 / kind:24000
//! events a-tagging a known project, restart on crash.

pub mod config;
pub mod control_socket;
pub mod display;
pub mod lockfile;
pub mod nostr;
pub mod supervisor;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::{error, info, Instrument};

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

    /// Do not start the intervention companion daemon.
    #[arg(long)]
    pub disable_intervention: bool,
}

pub async fn run(args: DaemonArgs) -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(args.base_dir.clone());

    // Companion daemons resolve their data paths from TENEX_BASE_DIR. Keep the
    // environment aligned with the supervisor when the operator passes
    // --base-dir.
    if args.base_dir.is_some() {
        std::env::set_var("TENEX_BASE_DIR", &base_dir);
    }

    let cfg = config::load(&base_dir)
        .with_context(|| format!("loading config from {}", base_dir.display()))?;
    display::header(&base_dir, cfg.relays.len());

    let _lock = lockfile::Lockfile::acquire(&base_dir).context("acquiring daemon lockfile")?;
    let backend_keys = crate::nostr_pub::backend_signer::ensure_backend_keys(&base_dir)
        .context("loading daemon signer")?;

    whitelist_export::write_backend_pubkey(&base_dir, &backend_keys)
        .context("publish backend pubkey for whitelist daemon")?;

    let boot_argv = if let Some(cmd) = args.ts {
        let argv = shell_words::split(&cmd).with_context(|| format!("parsing --ts: {cmd}"))?;
        if argv.is_empty() {
            return Err(anyhow::anyhow!("--ts is empty"));
        }
        argv
    } else {
        default_boot_argv()
    };

    let supervisor = supervisor::Supervisor::new(boot_argv, base_dir.clone());

    // Bootstrap the whitelist trust daemon as a supervised foreground child.
    // Every runtime gates inbound events through it and fails closed on socket
    // errors, so the daemon must be ready before any project runtime starts.
    if let Err(e) = start_whitelist_service(&supervisor, &base_dir).await {
        supervisor.shutdown().await;
        return Err(e);
    }
    display::service_ready("whitelist");


    // Bootstrap the identity daemon. Runtime code relies on this service for
    // pubkey display names; fail startup if the socket cannot be reached.
    if let Err(e) = start_identity_service(&supervisor).await {
        supervisor.shutdown().await;
        return Err(e);
    }
    display::service_ready("identity");

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
    display::service_ready("llm-config");


    // Spawn host-level companion daemons. Binaries are expected alongside the
    // tenex binary (same target/ dir for cargo builds, same bin/ for installs).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in
                companion_daemon_names(args.disable_scheduled_jobs, args.disable_intervention)
            {
                let path = dir.join(name);
                if path.exists() {
                    supervisor.boot_binary(name.to_string(), path).await;
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
    let mut nostr_handle = nostr::run(cfg, base_dir.clone(), backend_keys, supervisor.clone(), args.boot).await?;

    // Publish the backend heartbeat (kind:24012) and installed-agent inventory
    // (kind:24011) immediately and then every 30 seconds so Nostr clients see
    // both backend liveness and a fresh view of what agents are available on
    // this installation.
    {
        let base_dir_clone = base_dir.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                if let Err(e) =
                    crate::nostr_pub::backend_heartbeat::publish_backend_heartbeat(
                        &base_dir_clone,
                    )
                    .await
                {
                    tracing::warn!(error = %e, "24012 heartbeat publish failed");
                }
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

    let signal_received = tokio::select! {
        signal = wait_for_signal() => {
            info!(signal = signal.unwrap_or("unknown"), "shutdown signal received");
            Some(signal.unwrap_or("unknown"))
        }
        res = &mut nostr_handle => {
            error!(?res, "nostr task exited unexpectedly; tearing down");
            None
        }
    };

    if let Some(signal_type) = signal_received {
        let shutdown_start = std::time::Instant::now();
        let span = tracing::info_span!(
            "tenex.daemon.graceful_shutdown",
            "signal.type" = signal_type,
            "shutdown.duration_ms" = tracing::field::Empty,
        );
        async {
            supervisor.shutdown().await;
            nostr_handle.abort();
            tracing::Span::current().record(
                "shutdown.duration_ms",
                shutdown_start.elapsed().as_millis() as i64,
            );
        }
        .instrument(span)
        .await;
    } else {
        nostr_handle.abort();
        supervisor.shutdown().await;
    }

    Ok(())
}

fn companion_daemon_names(
    disable_scheduled_jobs: bool,
    disable_intervention: bool,
) -> Vec<&'static str> {
    COMPANION_DAEMONS
        .into_iter()
        .filter(|name| !(disable_scheduled_jobs && *name == "tenex-scheduler"))
        .filter(|name| !(disable_intervention && *name == "tenex-intervention"))
        .collect()
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

async fn wait_for_signal() -> Option<&'static str> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigint = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGINT handler");
            return None;
        }
    };
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGTERM handler");
            return None;
        }
    };
    tokio::select! {
        _ = sigint.recv() => Some("sigint"),
        _ = sigterm.recv() => Some("sigterm"),
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
    fn companion_daemons_are_enabled_by_default() {
        let args = DaemonArgs::parse_from(["tenex", "--boot", "project"]);

        assert!(!args.disable_scheduled_jobs);
        assert!(!args.disable_intervention);
        let names = companion_daemon_names(args.disable_scheduled_jobs, args.disable_intervention);
        assert!(names.contains(&"tenex-scheduler"));
        assert!(names.contains(&"tenex-intervention"));
    }

    #[test]
    fn disable_scheduled_jobs_omits_scheduler_companion() {
        let args = DaemonArgs::parse_from(["tenex", "--disable-scheduled-jobs"]);
        let names = companion_daemon_names(args.disable_scheduled_jobs, args.disable_intervention);

        assert!(!names.contains(&"tenex-scheduler"));
        assert!(names.contains(&"tenex-summarizer"));
        assert!(names.contains(&"tenex-intervention"));
        assert!(names.contains(&"tenex-telegram"));
    }

    #[test]
    fn disable_intervention_omits_intervention_companion() {
        let args = DaemonArgs::parse_from(["tenex", "--disable-intervention"]);
        let names = companion_daemon_names(args.disable_scheduled_jobs, args.disable_intervention);

        assert!(!names.contains(&"tenex-intervention"));
        assert!(names.contains(&"tenex-scheduler"));
        assert!(names.contains(&"tenex-summarizer"));
        assert!(names.contains(&"tenex-telegram"));
    }
}

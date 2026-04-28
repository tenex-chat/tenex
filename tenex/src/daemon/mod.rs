//! Project supervisor: subscribe to Nostr, boot per-project runtimes
//! (`tenex-boot`) when whitelisted authors send kind:1 / kind:24000 events
//! a-tagging a known project, restart on crash.

pub mod config;
pub mod lockfile;
pub mod nostr;
pub mod supervisor;
pub mod whitelist_export;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::{error, info};

#[derive(Parser, Clone)]
pub struct DaemonArgs {
    /// TENEX base directory (default: $TENEX_BASE_DIR or ~/.tenex).
    #[arg(long, value_name = "PATH")]
    pub base_dir: Option<PathBuf>,

    /// Boot command prefix. The supervisor appends `--boot <d-tag>` per child.
    /// Default: `bun run <repo-root>/src/boot.ts`.
    #[arg(long, value_name = "CMD")]
    pub boot_command: Option<String>,

    /// Repository root used to resolve the default boot script
    /// (ignored when --boot-command is set). Defaults to the parent of the
    /// `tenex` crate dir at compile time (i.e. the workspace root).
    #[arg(long, value_name = "PATH")]
    pub repo_root: Option<PathBuf>,

    /// Boot the project whose d-tag starts with this prefix as soon as it is
    /// discovered on Nostr, without waiting for a kind:1/24000 trigger.
    /// Repeatable. The prefix is matched against discovered d-tags as projects
    /// stream in; if multiple discoveries match, the first one wins and the
    /// later one is logged as ambiguous. Useful for local testing.
    #[arg(long = "boot", value_name = "D_TAG_PREFIX")]
    pub boot: Vec<String>,
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

    // Bootstrap the whitelist trust daemon. Every event the TS runtimes process
    // is gated by it (PubkeyGateService is fail-closed), so there is no useful
    // work this supervisor can do without it bound.
    tenex_whitelist::ensure_running().context("bootstrapping whitelist daemon")?;
    info!("whitelist daemon ready");

    // Bootstrap the identity daemon. Non-fatal: PubkeyService falls back to
    // NDK if the daemon is absent.
    if let Err(e) = tenex_identity::ensure_running() {
        tracing::warn!(error = %e, "identity daemon failed to start; name resolution will use NDK fallback");
    } else {
        info!("identity daemon ready");
    }

    whitelist_export::write_backend_pubkey(&base_dir, cfg.tenex_private_key.as_deref())
        .context("publish backend pubkey for whitelist daemon")?;

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

    let boot_command = match args.boot_command.clone() {
        Some(cmd) => cmd,
        None => {
            let repo_root = args.repo_root.clone().unwrap_or_else(default_repo_root);
            format!("bun run {}", repo_root.join("src/boot.ts").display())
        }
    };
    info!(boot_command, "boot command resolved");

    let boot_argv = shell_words::split(&boot_command)
        .with_context(|| format!("parsing --boot-command: {boot_command}"))?;
    if boot_argv.is_empty() {
        return Err(anyhow::anyhow!("--boot-command is empty"));
    }

    let supervisor = supervisor::Supervisor::new(boot_argv, base_dir.clone());

    // Spawn host-level companion daemons. Binaries are expected alongside the
    // tenex binary (same target/ dir for cargo builds, same bin/ for installs).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["tenex-summarizer", "tenex-scheduler", "tenex-intervention"] {
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

    if !args.boot.is_empty() {
        info!(prefixes = ?args.boot, "queued --boot prefixes; awaiting matching project discovery");
    }
    let mut nostr_handle = nostr::run(cfg, supervisor.clone(), args.boot).await?;

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

fn default_repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is the tenex crate dir at compile time
    // (e.g. <repo>/tenex). The repo root is its parent.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest_dir)
}

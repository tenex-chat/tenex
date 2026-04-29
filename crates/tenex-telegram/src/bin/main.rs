//! `tenex-telegram` daemon — polls Telegram Bot API and publishes backend-signed
//! kind:1 Nostr events addressed to the appropriate agent.
//!
//! Lifecycle:
//!   1. Load ~/.tenex/config.json (backend nsec + relays).
//!   2. Scan installed agents for `telegram` blocks.
//!   3. Scan project events only to map Telegram-enabled agents to candidate projects.
//!   4. For each agent, start one polling loop under that bot token.
//!   5. On each inbound user message, look up the session store to find (or
//!      start) a conversation, then publish a backend-signed kind:1 Nostr event
//!      p-tagging the agent and carrying `telegram-*` tags.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use nostr_sdk::prelude::Keys;
use tenex_telegram::binding::BindingStore;
use tenex_telegram::discovery::discover_registrations;
use tenex_telegram::poller::Poller;
use tracing::{error, info, warn};

#[derive(Debug)]
struct DaemonConfig {
    relays: Vec<String>,
    backend_nsec: String,
}

fn load_config(base_dir: &Path) -> Result<DaemonConfig> {
    let path = base_dir.join("config.json");
    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;

    let backend_nsec = val
        .get("tenexPrivateKey")
        .and_then(|v| v.as_str())
        .context("no tenexPrivateKey in ~/.tenex/config.json")?
        .to_string();

    let relays: Vec<String> = val
        .get("relays")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| s.starts_with("ws://") || s.starts_with("wss://"))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    let relays = if relays.is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        relays
    };

    Ok(DaemonConfig {
        relays,
        backend_nsec,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let base_dir = tenex_project::paths::default_base_dir();
    let cfg = load_config(&base_dir).context("load daemon config")?;
    let backend_keys = Keys::parse(&cfg.backend_nsec).context("parse backend nsec")?;

    let registrations = discover_registrations();
    if registrations.is_empty() {
        info!("no Telegram-enabled agents found; exiting");
        return Ok(());
    }

    info!(
        count = registrations.len(),
        "discovered Telegram-enabled agents"
    );

    let channel_bindings = Arc::new(Mutex::new(BindingStore::open(
        base_dir.join("data").join("transport-bindings.json"),
    )));

    // One bot token identifies exactly one agent. Project routing is resolved
    // later from the Telegram channel binding.
    let mut pollers: HashMap<String, Poller> = HashMap::new();
    for registration in registrations {
        let key = registration.config.bot_token.clone();
        if pollers.contains_key(&key) {
            warn!(
                token_suffix = %&key[key.len().saturating_sub(6)..],
                agent = %registration.pubkey,
                "duplicate bot token skipped; one token must map to one agent"
            );
            continue;
        }

        let session_path = base_dir.join(format!(
            "telegram-sessions-{}.json",
            &registration.pubkey[..12]
        ));

        match Poller::new(
            registration.clone(),
            backend_keys.clone(),
            &cfg.relays,
            session_path,
            Arc::clone(&channel_bindings),
        )
        .await
        {
            Ok(mut poller) => {
                poller.prepare().await;
                pollers.insert(key, poller);
            }
            Err(e) => {
                error!(
                    agent = %registration.pubkey,
                    error = %e,
                    "failed to initialize poller"
                );
            }
        }
    }

    if pollers.is_empty() {
        error!("no pollers initialized; exiting");
        return Ok(());
    }

    info!(count = pollers.len(), "started pollers");

    let handles: Vec<tokio::task::JoinHandle<()>> = pollers
        .into_values()
        .map(|mut poller| {
            tokio::spawn(async move {
                loop {
                    if let Err(e) = poller.run_once().await {
                        warn!(
                            agent = %poller.agent_pubkey(),
                            error = %e,
                            "poll error"
                        );
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                }
            })
        })
        .collect();

    for handle in handles {
        let _ = handle.await;
    }

    Ok(())
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

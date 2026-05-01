use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use tenex_project::{BunkerSigner, Signer};
use tenex_protocol::{SignAsUserRequest, SignAsUserResponse};

#[derive(Debug, Deserialize, Default)]
struct SignerTenexConfig {
    #[serde(default)]
    relays: Vec<String>,
    #[serde(default)]
    nip46: Option<SignerNip46Config>,
}

#[derive(Debug, Deserialize, Default)]
struct SignerNip46Config {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default, rename = "signingTimeoutMs")]
    signing_timeout_ms: Option<u64>,
    #[serde(default)]
    owners: HashMap<String, SignerNip46OwnerConfig>,
}

#[derive(Debug, Deserialize, Default)]
struct SignerNip46OwnerConfig {
    #[serde(rename = "bunkerUri")]
    bunker_uri: Option<String>,
}

pub async fn sign_as_user(base_dir: &Path, req: SignAsUserRequest) -> Result<SignAsUserResponse> {
    let config = load_signer_config(base_dir)?;
    let bunker_uri = resolve_bunker_uri(&config, &req.owner_pubkey)?;
    let client_keys = nostr::Keys::parse(&req.agent_nsec).context("invalid agent signer")?;
    let tags = nostr::Tags::parse(req.tags.clone()).context("invalid Nostr tags")?;
    let mut builder = nostr::EventBuilder::new(nostr::Kind::from(req.kind), req.content).tags(tags);
    if let Some(created_at) = req.created_at {
        builder = builder.custom_created_at(nostr::Timestamp::from(created_at));
    }
    let signing_timeout = config
        .nip46
        .as_ref()
        .and_then(|cfg| cfg.signing_timeout_ms)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(120));

    let signer = BunkerSigner::from_uri_with_client_keys_and_timeout(
        &bunker_uri,
        client_keys,
        signing_timeout,
    )
    .context("create NIP-46 signer")?;
    let signed = signer.sign(builder).await;
    signer.shutdown().await;

    let event = signed.context("NIP-46 signing failed")?;
    let signed_pubkey = event.pubkey.to_hex();
    if signed_pubkey != req.owner_pubkey {
        anyhow::bail!(
            "NIP-46 signer returned pubkey {}, expected project owner {}",
            signed_pubkey,
            req.owner_pubkey
        );
    }
    event.verify().context("signed event verification failed")?;

    Ok(SignAsUserResponse {
        success: true,
        event_id: event.id.to_hex(),
        pubkey: signed_pubkey,
        kind: req.kind,
        description: req.description,
        explanation: req.explanation,
        signed_event: serde_json::to_value(&event).context("serialize signed event")?,
    })
}

fn load_signer_config(base_dir: &Path) -> Result<SignerTenexConfig> {
    let path = base_dir.join("config.json");
    match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SignerTenexConfig::default()),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

fn resolve_bunker_uri(config: &SignerTenexConfig, owner_pubkey: &str) -> Result<String> {
    nostr::PublicKey::from_hex(owner_pubkey).context("invalid project owner pubkey")?;

    if config
        .nip46
        .as_ref()
        .and_then(|c| c.enabled)
        .is_some_and(|enabled| !enabled)
    {
        anyhow::bail!("NIP-46 signing is disabled");
    }

    if let Some(uri) = config
        .nip46
        .as_ref()
        .and_then(|c| c.owners.get(owner_pubkey))
        .and_then(|o| o.bunker_uri.as_deref())
        .filter(|uri| !uri.trim().is_empty())
    {
        let trimmed = uri.trim();
        if !trimmed.starts_with("bunker://") {
            anyhow::bail!("invalid bunker URI for owner {owner_pubkey}: expected bunker:// URI");
        }
        return Ok(trimmed.to_string());
    }

    let relay = config
        .relays
        .iter()
        .find(|relay| !relay.trim().is_empty())
        .map(String::as_str)
        .unwrap_or("wss://tenex.chat");
    let relay = url::form_urlencoded::byte_serialize(relay.as_bytes()).collect::<String>();
    Ok(format!("bunker://{owner_pubkey}?relay={relay}"))
}

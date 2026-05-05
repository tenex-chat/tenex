//! Tells the identity daemon which pubkeys to keep a kind:0 subscription
//! warm for.
//!
//! Every time the project set changes, `nostr.rs` calls
//! [`push_remote_pubkey_watch`] with the current list of `<kind>:<pubkey>:<d_tag>`
//! addresses. We unfold each project's `remote_member_pubkeys()` (members
//! whose agent JSON projection is missing or carries no `signer_ref`),
//! union them, drop the backend's own pubkey, and ship the deduped set to
//! the identity daemon over its Unix socket as `WATCH_AUTHORS`.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{anyhow, Result};
use nostr_sdk::PublicKey;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tracing::debug;

/// Recompute the union of remote (non-locally-signed) member pubkeys across
/// every known project and tell the identity daemon to maintain an always-on
/// kind:0 subscription for that set.
///
/// Excludes this backend's own pubkey defensively — even though it shouldn't
/// appear in a 31933 p-tag, lacking a local agent JSON would otherwise let it
/// slip through the "remote" filter.
pub async fn push_remote_pubkey_watch(
    base_dir: &Path,
    addresses: &[String],
    backend_pubkey: &PublicKey,
) -> Result<()> {
    let backend_hex = backend_pubkey.to_hex();
    let mut union: BTreeSet<String> = BTreeSet::new();
    for address in addresses {
        let parts: Vec<&str> = address.splitn(3, ':').collect();
        if parts.len() != 3 {
            continue;
        }
        let d_tag = parts[2];
        let project = match tenex_project::Project::open(d_tag, base_dir) {
            Ok(p) => p,
            Err(e) => {
                debug!(d_tag, error = %e, "skipping project for remote-pubkey watch");
                continue;
            }
        };
        match project.remote_member_pubkeys() {
            Ok(pubkeys) => {
                for pk in pubkeys {
                    if pk != backend_hex {
                        union.insert(pk);
                    }
                }
            }
            Err(e) => {
                debug!(d_tag, error = %e, "failed to enumerate remote members");
            }
        }
    }

    let pubkeys: Vec<String> = union.into_iter().collect();
    send_watch_authors(base_dir, &pubkeys).await
}

/// Send `WATCH_AUTHORS [<pk>...]` over the identity daemon Unix socket. A
/// missing socket is treated as "identity daemon not up yet" and silently
/// skipped — the next debounce will retry.
async fn send_watch_authors(base_dir: &Path, pubkeys: &[String]) -> Result<()> {
    let socket = base_dir.join(tenex_identity::paths::IDENTITY_SOCKET_FILENAME);
    if !socket.exists() {
        debug!(path = %socket.display(), "identity socket absent; skipping WATCH_AUTHORS");
        return Ok(());
    }

    let stream = UnixStream::connect(&socket).await?;
    let (reader_half, mut writer_half) = stream.into_split();

    let line = if pubkeys.is_empty() {
        "WATCH_AUTHORS\n".to_string()
    } else {
        format!("WATCH_AUTHORS {}\n", pubkeys.join(" "))
    };
    writer_half.write_all(line.as_bytes()).await?;
    writer_half.flush().await?;

    let mut reader = BufReader::new(reader_half);
    let mut response = String::new();
    reader.read_line(&mut response).await?;
    let trimmed = response.trim();
    if trimmed.starts_with("OK") {
        debug!(count = pubkeys.len(), "identity WATCH_AUTHORS updated");
        Ok(())
    } else {
        Err(anyhow!("identity daemon rejected WATCH_AUTHORS: {trimmed}"))
    }
}

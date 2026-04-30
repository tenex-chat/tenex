use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use nostr_sdk::Keys;
use tracing::info;

/// Write the supervisor's backend pubkey to `<base_dir>/whitelist/pubkeys.txt`.
///
/// Consumed by the standalone `tenex-whitelist` daemon as its "backend"
/// trust source. The supervisor is the right writer because it loads before
/// any per-project TS runtime, so the file is available even when no project
/// is currently running.
///
/// Atomic via tmp + rename so the whitelist daemon's fs watcher never
/// observes a partial write.
pub fn write_backend_pubkey(base_dir: &Path, keys: &Keys) -> Result<()> {
    let dir = base_dir.join("whitelist");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;

    let final_path = dir.join("pubkeys.txt");
    let pubkey_hex = keys.public_key().to_hex();

    let tmp_path = dir.join(format!("pubkeys.txt.tmp-{}", std::process::id()));
    fs::write(&tmp_path, format!("{pubkey_hex}\n"))
        .with_context(|| format!("write {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), final_path.display()))?;

    info!(
        path = %final_path.display(),
        pubkey = %pubkey_hex,
        "backend pubkey published for whitelist daemon",
    );
    Ok(())
}

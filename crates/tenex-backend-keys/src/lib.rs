//! Load-or-generate the TENEX backend signer.
//!
//! The backend signer is the keypair every TENEX daemon (runtime, identity,
//! embedder, scheduler, intervention) uses to authenticate to relays via
//! NIP-42. It is persisted as `tenexPrivateKey` (hex) in `<base>/config.json`.
//!
//! [`ensure`] is idempotent: returns the persisted key if present, otherwise
//! generates a fresh keypair, writes it back atomically (preserving the order
//! of every other field in `config.json`), and returns it.
//!
//! Lives in its own crate so daemons that don't depend on the main `tenex`
//! binary's `store` module (e.g. `tenex-identity`, `tenex-embedder`) can boot
//! a fully-authenticated relay client without duplicating the read/generate
//! dance.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use nostr_sdk::Keys;
use serde_json::Value;

/// Load `tenexPrivateKey` from `<base_dir>/config.json`. If absent, generate
/// a fresh keypair, persist the hex private key, and return the new keys.
///
/// Accepts both 64-char hex and bech32 `nsec…` on read; always writes hex
/// (matches NDK `signer.privateKey` semantics).
pub fn ensure(base_dir: &Path) -> Result<Keys> {
    let path = base_dir.join("config.json");
    let mut raw = load_raw(&path)?;

    if let Some(Value::String(existing)) = raw.get("tenexPrivateKey") {
        return Keys::parse(existing).map_err(|e| {
            anyhow!(
                "tenexPrivateKey in {} is malformed (expected 64-char hex or bech32 nsec): {e}",
                path.display()
            )
        });
    }

    let keys = Keys::generate();
    let hex = keys.secret_key().to_secret_hex();
    raw.insert("tenexPrivateKey".to_string(), Value::String(hex));
    save_raw(&path, &raw).context("persist generated tenexPrivateKey")?;
    Ok(keys)
}

fn load_raw(path: &Path) -> Result<IndexMap<String, Value>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IndexMap::new()),
        Err(e) => Err(anyhow!(e)).with_context(|| format!("reading {}", path.display())),
    }
}

fn save_raw(path: &Path, raw: &IndexMap<String, Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }
    let bytes = serialize(raw)?;
    let tmp = tmp_sibling(path);
    {
        let mut file =
            fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(&bytes)
            .with_context(|| format!("write {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", tmp.display()))?;
    }
    fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(256);
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    use serde::Serialize;
    raw.serialize(&mut ser).context("serialize config.json")?;
    Ok(buf)
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let pid = std::process::id();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let tmp_name = format!(".{name}.tmp-{pid}");
    path.parent()
        .map(|p| p.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(tmp_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn generates_and_persists_when_absent() {
        let base = TempDir::new().unwrap();
        let keys = ensure(base.path()).unwrap();

        let bytes = fs::read(base.path().join("config.json")).unwrap();
        let raw: IndexMap<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let stored = raw.get("tenexPrivateKey").and_then(Value::as_str).unwrap();
        assert_eq!(stored, keys.secret_key().to_secret_hex());
        assert_eq!(stored.len(), 64);
        assert!(stored.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn idempotent_when_present() {
        let base = TempDir::new().unwrap();
        let first = ensure(base.path()).unwrap();
        let second = ensure(base.path()).unwrap();
        assert_eq!(
            first.secret_key().to_secret_hex(),
            second.secret_key().to_secret_hex()
        );
    }

    #[test]
    fn preserves_unknown_fields_and_order_when_generating() {
        let base = TempDir::new().unwrap();
        let path = base.path().join("config.json");
        let initial = json!({
            "version": 2,
            "whitelistedPubkeys": ["abc"],
            "customField": "keep me"
        });
        fs::write(&path, serde_json::to_vec_pretty(&initial).unwrap()).unwrap();

        let _ = ensure(base.path()).unwrap();

        let bytes = fs::read(&path).unwrap();
        let raw: IndexMap<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let keys: Vec<&str> = raw.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec!["version", "whitelistedPubkeys", "customField", "tenexPrivateKey"]
        );
        assert_eq!(raw.get("customField"), Some(&Value::String("keep me".into())));
    }

    #[test]
    fn accepts_bech32_form() {
        use nostr_sdk::ToBech32;
        let base = TempDir::new().unwrap();
        let path = base.path().join("config.json");
        let keys = Keys::generate();
        let bech = keys.secret_key().to_bech32().unwrap();
        let initial = json!({ "tenexPrivateKey": bech });
        fs::write(&path, serde_json::to_vec_pretty(&initial).unwrap()).unwrap();

        let loaded = ensure(base.path()).unwrap();
        assert_eq!(
            loaded.secret_key().to_secret_hex(),
            keys.secret_key().to_secret_hex()
        );
    }

    #[test]
    fn rejects_malformed_secret() {
        let base = TempDir::new().unwrap();
        let path = base.path().join("config.json");
        let initial = json!({ "tenexPrivateKey": "not-a-key" });
        fs::write(&path, serde_json::to_vec_pretty(&initial).unwrap()).unwrap();

        let err = ensure(base.path()).unwrap_err().to_string();
        assert!(err.contains("malformed"), "unexpected error: {err}");
    }
}

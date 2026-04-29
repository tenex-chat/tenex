//! Load or generate the TENEX backend signer.
//!
//! Mirrors `ConfigService.ensureBackendPrivateKey` + `getBackendSigner`
//! (`src/services/ConfigService.ts:632-659`):
//!
//! - read `tenexPrivateKey` from `~/.tenex/config.json`
//! - if absent → generate via `NDKPrivateKeySigner.generate()` and persist
//!   the **hex** form (matches `signer.privateKey` which is hex on NDK)
//! - return as `Keys`

use anyhow::{anyhow, Context, Result};
use nostr_sdk::{Keys, SecretKey};

use crate::store::tenex_config::TenexConfigDoc;

/// Load `tenex_private_key` from `<base>/config.json`. If missing, generate
/// a fresh keypair, persist the hex private key, and return the new keys.
pub fn ensure_backend_keys(base_dir: &std::path::Path) -> Result<Keys> {
    let mut doc = TenexConfigDoc::load(base_dir)?;

    if let Some(existing) = doc.tenex_private_key() {
        return parse_secret_to_keys(&existing).with_context(|| {
            "tenexPrivateKey in config.json is malformed — \
             expected 64-char hex or bech32 nsec"
        });
    }

    let keys = Keys::generate();
    let hex = keys.secret_key().to_secret_hex();
    doc.set_tenex_private_key(hex);
    doc.save(base_dir)
        .context("save generated tenexPrivateKey to config.json")?;
    Ok(keys)
}

/// Load `tenex_private_key` from config. Returns `None` if absent. Does
/// **not** generate or write — callers that must mutate state use
/// [`ensure_backend_keys`] instead.
pub fn try_load_backend_keys(base_dir: &std::path::Path) -> Result<Option<Keys>> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let Some(s) = doc.tenex_private_key() else {
        return Ok(None);
    };
    Ok(Some(parse_secret_to_keys(&s)?))
}

fn parse_secret_to_keys(s: &str) -> Result<Keys> {
    // `Keys::parse` accepts both bech32 (`nsec1…`) and 64-char hex.
    Keys::parse(s).map_err(|e| anyhow!("parse secret key: {e}"))
}

/// Convenience: hex-encode the secret key (matches NDK
/// `signer.privateKey` semantics — hex, not bech32).
#[cfg(test)]
fn hex_of(keys: &Keys) -> String {
    keys.secret_key().to_secret_hex()
}

/// Test-only helper: reconstruct keys from a hex string.
#[cfg(test)]
fn keys_from_hex(hex: &str) -> Result<Keys> {
    let sk = SecretKey::from_hex(hex).map_err(|e| anyhow!("from_hex: {e}"))?;
    Ok(Keys::new(sk))
}

// Reference SecretKey to avoid a missing-import warning in non-test builds.
const _: fn() = || {
    let _: Option<SecretKey> = None;
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-backend-signer-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn ensure_generates_and_persists_when_absent() {
        let base = unique_temp();
        let keys = ensure_backend_keys(&base).unwrap();
        // Verify it's persisted as hex.
        let doc = TenexConfigDoc::load(&base).unwrap();
        let stored = doc.tenex_private_key().unwrap();
        assert_eq!(stored.len(), 64);
        assert!(stored.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(stored, hex_of(&keys));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_is_idempotent_when_present() {
        let base = unique_temp();
        let first = ensure_backend_keys(&base).unwrap();
        let second = ensure_backend_keys(&base).unwrap();
        assert_eq!(hex_of(&first), hex_of(&second));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn try_load_returns_none_when_missing() {
        let base = unique_temp();
        assert!(try_load_backend_keys(&base).unwrap().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn try_load_returns_some_when_present() {
        let base = unique_temp();
        let keys = ensure_backend_keys(&base).unwrap();
        let loaded = try_load_backend_keys(&base).unwrap().unwrap();
        assert_eq!(hex_of(&loaded), hex_of(&keys));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parses_bech32_form_from_config() {
        // TS NDKPrivateKeySigner accepts both bech32 and hex.
        let base = unique_temp();
        use nostr_sdk::ToBech32;
        let keys = Keys::generate();
        let bech = keys.secret_key().to_bech32().unwrap();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_tenex_private_key(bech);
        doc.save(&base).unwrap();
        let loaded = ensure_backend_keys(&base).unwrap();
        assert_eq!(hex_of(&loaded), hex_of(&keys));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rejects_malformed_secret() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_tenex_private_key("not-a-key".to_string());
        doc.save(&base).unwrap();
        let err = ensure_backend_keys(&base).unwrap_err().to_string();
        assert!(err.contains("malformed") || err.contains("parse"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn keys_from_hex_round_trips() {
        let keys = Keys::generate();
        let hex = hex_of(&keys);
        let recon = keys_from_hex(&hex).unwrap();
        assert_eq!(hex_of(&recon), hex);
    }
}

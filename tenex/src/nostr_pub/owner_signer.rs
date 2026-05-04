//! Resolve the project owner's nsec into a signing key.
//!
//! Source order:
//! 1. `TENEX_NSEC` env var
//! 2. `ownerNsec` field in the TENEX config
//! 3. `Ok(None)` — callers decide how to handle a missing signer
//!    (refuse, degrade to local-only, or surface a hint).
//!
//! There is deliberately no interactive nsec prompt: TENEX commands
//! must never block on a hidden secret entry. Configure the env var or
//! the config field once; subsequent invocations resolve silently.
//!
//! The returned `Keys` pubkey **must still be validated** against the
//! actual project owner pubkey by the publish layer — this module only
//! resolves "what nsec did the human provide?" — it does not assume the
//! pubkey it derives is the right one.

use anyhow::{anyhow, Result};
use nostr_sdk::Keys;

use crate::store::tenex_config::TenexConfigDoc;

const ENV_VAR: &str = "TENEX_NSEC";

fn build_signer(nsec: &str) -> Result<Keys> {
    Keys::parse(nsec.trim()).map_err(|e| anyhow!("Could not load owner nsec: {e}"))
}

/// Non-prompting resolution: env var, then TENEX config, then `Ok(None)`.
///
/// If the configured value is malformed, the parse error is surfaced
/// rather than silently dropped — that's a misconfiguration, not "no
/// signer".
pub fn try_resolve_owner_signer(base_dir: &std::path::Path) -> Result<Option<Keys>> {
    if let Ok(env) = std::env::var(ENV_VAR) {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return build_signer(trimmed).map(Some);
        }
    }

    let doc = TenexConfigDoc::load(base_dir)?;
    if let Some(configured) = doc.owner_nsec() {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return build_signer(trimmed).map(Some);
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-owner-signer-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_config_owner(base: &std::path::Path, nsec: &str) {
        let mut doc = TenexConfigDoc::load(base).unwrap();
        doc.raw_mut()
            .insert("ownerNsec".into(), serde_json::Value::String(nsec.to_owned()));
        doc.save(base).unwrap();
    }

    /// Helper: stash the env var, run the closure, restore. The
    /// `set_var/remove_var` calls aren't thread-safe in test parallelism,
    /// so each test that uses TENEX_NSEC takes a global lock.
    fn with_env_var<F: FnOnce()>(value: Option<&str>, f: F) {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _g = LOCK.lock().unwrap();
        let prior = std::env::var(ENV_VAR).ok();
        unsafe {
            match value {
                Some(v) => std::env::set_var(ENV_VAR, v),
                None => std::env::remove_var(ENV_VAR),
            }
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        unsafe {
            match prior {
                Some(v) => std::env::set_var(ENV_VAR, v),
                None => std::env::remove_var(ENV_VAR),
            }
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn build_signer_accepts_bech32_nsec() {
        let keys = Keys::generate();
        use nostr_sdk::ToBech32;
        let nsec = keys.secret_key().to_bech32().unwrap();
        let signer = build_signer(&nsec).unwrap();
        assert_eq!(signer.public_key(), keys.public_key());
    }

    #[test]
    fn build_signer_accepts_hex_nsec() {
        let keys = Keys::generate();
        let hex = keys.secret_key().to_secret_hex();
        let signer = build_signer(&hex).unwrap();
        assert_eq!(signer.public_key(), keys.public_key());
    }

    #[test]
    fn build_signer_trims_input() {
        let keys = Keys::generate();
        let hex = keys.secret_key().to_secret_hex();
        let padded = format!("  {hex}\n");
        let signer = build_signer(&padded).unwrap();
        assert_eq!(signer.public_key(), keys.public_key());
    }

    #[test]
    fn build_signer_rejects_garbage_with_verbatim_message() {
        let err = build_signer("not-a-key").unwrap_err().to_string();
        assert!(err.starts_with("Could not load owner nsec:"), "got: {err}");
    }

    #[test]
    fn try_resolve_uses_env_var_first() {
        // Seed a malformed config nsec, then set the env var to a real
        // hex secret. `try_resolve_owner_signer` should pick the env var
        // and never hit the config path. The env-var swap and the
        // resolve call must happen *inside the same* `with_env_var`
        // invocation — the helper's lock is non-reentrant, so nesting
        // two calls deadlocks.
        let keys = Keys::generate();
        let hex = keys.secret_key().to_secret_hex();
        let base = unique_temp();
        seed_config_owner(&base, "nsec1somethingDifferent000000000000");
        with_env_var(Some(&hex), || {
            let resolved = try_resolve_owner_signer(&base).unwrap().unwrap();
            assert_eq!(
                resolved.public_key(),
                keys.public_key(),
                "env var should win over config"
            );
        });
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn try_resolve_falls_back_to_config_when_env_unset() {
        with_env_var(None, || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = try_resolve_owner_signer(&base).unwrap().unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn try_resolve_treats_empty_env_as_unset_and_falls_through_to_config() {
        with_env_var(Some(""), || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = try_resolve_owner_signer(&base).unwrap().unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn try_resolve_treats_whitespace_only_env_as_unset() {
        with_env_var(Some("   \n"), || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = try_resolve_owner_signer(&base).unwrap().unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn try_resolve_returns_none_when_env_and_config_both_unset() {
        // No env var, whitespace-only config — both treated as "no
        // signer". `try_resolve_owner_signer` returns `Ok(None)` so
        // callers can decide how to handle the absence (degrade to
        // local-only, or refuse with a clear hint).
        with_env_var(None, || {
            let base = unique_temp();
            seed_config_owner(&base, "   ");
            let resolved = try_resolve_owner_signer(&base).unwrap();
            assert!(
                resolved.is_none(),
                "whitespace-only config + no env should resolve to None, got: {resolved:?}"
            );
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn try_resolve_surfaces_malformed_configured_value() {
        // A configured value that isn't a valid nsec is a misconfiguration
        // — surface the parse error rather than silently dropping it.
        with_env_var(None, || {
            let base = unique_temp();
            seed_config_owner(&base, "not-a-real-key");
            let err = try_resolve_owner_signer(&base).unwrap_err().to_string();
            assert!(
                err.starts_with("Could not load owner nsec:"),
                "expected parse error to surface; got: {err}"
            );
            std::fs::remove_dir_all(&base).ok();
        });
    }
}

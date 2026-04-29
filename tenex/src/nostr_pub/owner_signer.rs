//! Resolve the project owner's nsec into a signing key.
//!
//! Mirrors `src/commands/agent/ownerSigner.ts` (the TS module that
//! replaced the NIP-46 flow when project-31933 mutations switched to
//! direct nsec signing).
//!
//! Source order (matches TS at `:60-77`):
//! 1. `TENEX_NSEC` env var
//! 2. `ownerNsec` field in the TENEX config
//! 3. Interactive prompt (with optional persistence)
//!
//! Returns `Keys` whose pubkey **must still be validated** against the
//! actual project owner pubkey by the publish layer. This module only
//! resolves "what nsec did the human provide?" — it does not assume the
//! pubkey it derives is the right one.

use anyhow::{anyhow, Context, Result};
use nostr_sdk::Keys;

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

const ENV_VAR: &str = "TENEX_NSEC";

fn build_signer(nsec: &str) -> Result<Keys> {
    Keys::parse(nsec.trim())
        .map_err(|e| anyhow!("Could not load owner nsec: {e}"))
}

/// Resolve the project owner's nsec and return signing keys.
///
/// Errors with the verbatim TS string `"Owner nsec required: set
/// $TENEX_NSEC or \"ownerNsec\" in TENEX config."` if all three sources
/// fail.
pub fn resolve_owner_signer(base_dir: &std::path::Path) -> Result<Keys> {
    if let Ok(env) = std::env::var(ENV_VAR) {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return build_signer(trimmed);
        }
    }

    let mut doc = TenexConfigDoc::load(base_dir)?;
    if let Some(configured) = doc.owner_nsec() {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return build_signer(trimmed);
        }
    }

    // Interactive fallback. TS at agent/ownerSigner.ts:68-70 emits:
    //   console.log(chalk.dim(
    //       `\nNo owner nsec configured. Set $${ENV_VAR}, populate
    //        "ownerNsec" in TENEX config, or enter it now.`,
    //   ));
    // The leading \n is INSIDE the dim wrap — mirror byte-for-byte.
    println!(
        "{}",
        crate::tui::theme::chalk_dim(&format!(
            "\nNo owner nsec configured. Set ${ENV_VAR}, populate \"ownerNsec\" in TENEX config, or enter it now.",
        )),
    );

    let prompted = match prompt_for_nsec()? {
        Some(p) => p,
        None => {
            return Err(anyhow!(
                "Owner nsec required: set ${ENV_VAR} or \"ownerNsec\" in TENEX config."
            ));
        }
    };

    let signer = build_signer(&prompted.nsec)?;

    if prompted.persist {
        doc.set_owner_nsec(prompted.nsec);
        doc.save(base_dir)
            .context("save owner nsec to TENEX config")?;
    }

    Ok(signer)
}

struct PromptedNsec {
    nsec: String,
    persist: bool,
}

fn prompt_for_nsec() -> Result<Option<PromptedNsec>> {
    // Password prompt (masked).
    let nsec = match prompts::password(
        "Owner nsec (hex or bech32) — leave blank to abort:",
    )
    .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("nsec prompt: {e}")),
    };
    let trimmed = nsec.trim().to_owned();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let persist = match prompts::confirm(
        "Save this nsec to your TENEX config for future sessions?",
    )
    .with_default(false)
    .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => false,
        Err(e) => return Err(anyhow!("persist prompt: {e}")),
    };

    Ok(Some(PromptedNsec {
        nsec: trimmed,
        persist,
    }))
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
        doc.set_owner_nsec(nsec.to_owned());
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
        assert!(
            err.starts_with("Could not load owner nsec:"),
            "got: {err}"
        );
    }

    #[test]
    fn resolve_uses_env_var_first() {
        // Seed a malformed config nsec, then set the env var to a real
        // hex secret. `resolve_owner_signer` should pick the env var and
        // never hit the config path. The env-var swap and the resolve
        // call must happen *inside the same* `with_env_var` invocation —
        // the helper's lock is non-reentrant, so nesting two calls
        // deadlocks.
        let keys = Keys::generate();
        let hex = keys.secret_key().to_secret_hex();
        let base = unique_temp();
        seed_config_owner(&base, "nsec1somethingDifferent000000000000");
        with_env_var(Some(&hex), || {
            let resolved = resolve_owner_signer(&base).unwrap();
            assert_eq!(
                resolved.public_key(),
                keys.public_key(),
                "env var should win over config"
            );
        });
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_falls_back_to_config_when_env_unset() {
        with_env_var(None, || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = resolve_owner_signer(&base).unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn resolve_treats_empty_env_as_unset_and_falls_through_to_config() {
        with_env_var(Some(""), || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = resolve_owner_signer(&base).unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn resolve_treats_whitespace_only_env_as_unset() {
        with_env_var(Some("   \n"), || {
            let keys = Keys::generate();
            let hex = keys.secret_key().to_secret_hex();
            let base = unique_temp();
            seed_config_owner(&base, &hex);
            let resolved = resolve_owner_signer(&base).unwrap();
            assert_eq!(resolved.public_key(), keys.public_key());
            std::fs::remove_dir_all(&base).ok();
        });
    }

    #[test]
    fn resolve_treats_empty_config_as_unset_and_skips_to_prompt_path() {
        // We can't run the prompt here, but we can verify that an empty
        // config string does not get fed to `build_signer` (which would
        // error with a different message). The interactive prompt path is
        // unreachable in tests since stdin isn't a TTY — instead the
        // resolve function returns the verbatim "Owner nsec required" error.
        with_env_var(None, || {
            let base = unique_temp();
            seed_config_owner(&base, "   ");
            let err = resolve_owner_signer(&base).unwrap_err().to_string();
            // Either the prompt-required message (ideal) or any error that
            // is NOT the "Could not load owner nsec" build_signer error.
            assert!(
                !err.starts_with("Could not load owner nsec:"),
                "whitespace-only config should not be passed to build_signer; got: {err}"
            );
            std::fs::remove_dir_all(&base).ok();
        });
    }
}

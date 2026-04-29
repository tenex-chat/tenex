//! Onboarding Screen 1: Identity.
//!
//! Spec: `tenex/docs/tui-port/01-cli-entrypoint-and-onboarding.md` §"Screen 1".
//! Source: `src/commands/onboard.ts:1220-1314`.
//!
//! When the user passes `--pubkey <pubkeys...>` on the CLI, this screen is
//! skipped entirely (handled in the parent state machine — `runOnboarding`,
//! `:1220-1222`). When run interactively:
//!
//! 1. **1.A** — choose `Create a new identity` or `I have an existing one (import nsec)`.
//! 2. **1.B / 1.C** *(create branch)* — username prompt with random default
//!    `<adjective>-<noun>`, validate non-empty + min length 2, generate a
//!    fresh keypair via nostr-sdk, display the `npub` / `nsec` summary.
//! 3. **1.D** *(import branch)* — masked nsec password prompt, decode via
//!    `nip19`, surface verbatim error strings.
//!
//! Returns a [`IdentityResult`] capturing the produced state for the parent
//! state machine to roll into the final config. No persistence happens here.

use anyhow::{anyhow, Context, Result};
use nostr_sdk::nips::nip19::FromBech32;
use nostr_sdk::{Keys, SecretKey, ToBech32};

use super::random::random_username;
use crate::tui::display;
use crate::tui::prompts;

const CHOICE_CREATE: &str = "Create a new identity";
const CHOICE_IMPORT: &str = "I have an existing one (import nsec)";

/// Result of running Screen 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityResult {
    /// One-element list — the user's hex pubkey.
    pub whitelisted_pubkeys: Vec<String>,
    /// Hex-encoded private key of the user.
    pub user_private_key_hex: String,
    /// Set only on the `create` branch (`:1265`); `None` after `import`.
    pub generated_nsec: Option<String>,
    /// Username typed during `create`; `None` after `import`.
    pub new_identity_username: Option<String>,
}

/// Drive the identity screen. `json_mode` suppresses the post-acceptance
/// summary lines (matches `:1267`, `:1310` — both gated on `!jsonMode`).
pub fn run(json_mode: bool) -> Result<IdentityResult> {
    let choice = prompts::select(
        "How do you want to set up your identity?",
        vec![CHOICE_CREATE.to_owned(), CHOICE_IMPORT.to_owned()],
    )
    .prompt()
    .map_err(|e| anyhow!("identity choice prompt: {e}"))?;

    if choice == CHOICE_CREATE {
        run_create(json_mode)
    } else {
        run_import(json_mode)
    }
}

fn run_create(json_mode: bool) -> Result<IdentityResult> {
    let default_name = random_username();

    let validator = prompts::adapt_string_validator(validate_username);
    let username_raw =
        prompts::input("Choose a username (this is how agents and other nostr users will see you)")
            .with_default(&default_name)
            .with_validator(validator)
            .prompt()
            .map_err(|e| anyhow!("username prompt: {e}"))?;
    let username = username_raw.trim().to_owned();

    let keys = Keys::generate();
    let secret_key = keys.secret_key().clone();
    let priv_hex = secret_key.to_secret_hex();
    let pubkey_hex = keys.public_key().to_hex();
    let npub = keys
        .public_key()
        .to_bech32()
        .context("encode npub for new identity")?;
    let nsec = secret_key
        .to_bech32()
        .context("encode nsec for new identity")?;

    if !json_mode {
        display::blank();
        display::success("Identity created");
        display::blank();
        display::summary_line("username", &username);
        display::summary_line("npub", &npub);
        display::summary_line("nsec", &nsec);
        display::blank();
        display::hint("Save your nsec somewhere safe. You won't be able to recover it.");
        display::blank();
    }

    Ok(IdentityResult {
        whitelisted_pubkeys: vec![pubkey_hex],
        user_private_key_hex: priv_hex,
        generated_nsec: Some(nsec),
        new_identity_username: Some(username),
    })
}

fn run_import(json_mode: bool) -> Result<IdentityResult> {
    let validator = prompts::adapt_string_validator(validate_nsec);
    let nsec_raw = prompts::password("Paste your nsec (hidden)")
        .with_validator(validator)
        .prompt()
        .map_err(|e| anyhow!("nsec prompt: {e}"))?;
    let nsec = nsec_raw.trim().to_owned();

    let secret_key =
        SecretKey::from_bech32(&nsec).map_err(|e| anyhow!("nsec decode (post-validation): {e}"))?;
    let keys = Keys::new(secret_key);
    let priv_hex = keys.secret_key().to_secret_hex();
    let pubkey_hex = keys.public_key().to_hex();
    let npub = keys.public_key().to_bech32().context("encode npub")?;

    if !json_mode {
        display::blank();
        display::success("Identity imported");
        display::summary_line("npub", &npub);
        display::blank();
    }

    Ok(IdentityResult {
        whitelisted_pubkeys: vec![pubkey_hex],
        user_private_key_hex: priv_hex,
        generated_nsec: None,
        new_identity_username: None,
    })
}

/// Validate the username field. Errors must match the TS strings byte-for-byte:
/// - `"Username is required"` (`:1245`)
/// - `"Username must be at least 2 characters"` (`:1246`)
pub fn validate_username(input: &str) -> Result<(), &'static str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Username is required");
    }
    if trimmed.chars().count() < 2 {
        return Err("Username must be at least 2 characters");
    }
    Ok(())
}

/// Validate the nsec field. Errors must match the TS strings byte-for-byte:
/// - `"nsec is required"` (`:1287`)
/// - `"Invalid nsec"` when decode succeeds but the type is not `nsec` (`:1290`)
/// - `"Invalid nsec format"` when decode throws (`:1292`)
pub fn validate_nsec(input: &str) -> Result<(), &'static str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("nsec is required");
    }
    // The TS code calls `nip19.decode` and inspects `decoded.type !== "nsec"`.
    // In Rust we ask SecretKey::from_bech32 directly; a successful parse
    // implies `type === "nsec"`. Anything else (npub, naddr, malformed) is
    // surfaced as "Invalid nsec format" — the broader of the two error
    // categories — except when the input is a valid bech32 of a different
    // NIP-19 entity, which yields the more specific "Invalid nsec".
    if SecretKey::from_bech32(trimmed).is_ok() {
        return Ok(());
    }
    if is_recognised_non_nsec_bech32(trimmed) {
        Err("Invalid nsec")
    } else {
        Err("Invalid nsec format")
    }
}

fn is_recognised_non_nsec_bech32(s: &str) -> bool {
    use nostr_sdk::nips::nip19::Nip19;
    matches!(Nip19::from_bech32(s), Ok(nip) if !matches!(nip, Nip19::Secret(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_username_rejects_empty_and_whitespace_only() {
        assert_eq!(validate_username(""), Err("Username is required"));
        assert_eq!(validate_username("   "), Err("Username is required"));
    }

    #[test]
    fn validate_username_rejects_single_char() {
        assert_eq!(
            validate_username("a"),
            Err("Username must be at least 2 characters")
        );
    }

    #[test]
    fn validate_username_accepts_two_chars() {
        assert!(validate_username("ab").is_ok());
    }

    #[test]
    fn validate_username_accepts_typical_default_name() {
        assert!(validate_username("clever-otter").is_ok());
    }

    #[test]
    fn validate_username_trims_before_checking() {
        assert!(validate_username("  hi  ").is_ok());
        assert_eq!(
            validate_username(" a "),
            Err("Username must be at least 2 characters")
        );
    }

    #[test]
    fn validate_nsec_rejects_empty() {
        assert_eq!(validate_nsec(""), Err("nsec is required"));
    }

    #[test]
    fn validate_nsec_rejects_garbage_with_format_message() {
        assert_eq!(validate_nsec("not-an-nsec"), Err("Invalid nsec format"));
    }

    #[test]
    fn validate_nsec_rejects_npub_with_invalid_nsec_message() {
        // Build a valid npub from a generated keypair and confirm the
        // distinct error string fires.
        let keys = Keys::generate();
        let npub = keys.public_key().to_bech32().unwrap();
        assert_eq!(validate_nsec(&npub), Err("Invalid nsec"));
    }

    #[test]
    fn validate_nsec_accepts_valid_nsec() {
        let keys = Keys::generate();
        let nsec = keys.secret_key().to_bech32().unwrap();
        assert!(validate_nsec(&nsec).is_ok());
    }

    #[test]
    fn create_choice_label_matches_ts_verbatim() {
        // Pins the prompt-choice strings — these appear in the user's
        // first interactive screen and must not drift.
        assert_eq!(CHOICE_CREATE, "Create a new identity");
        assert_eq!(CHOICE_IMPORT, "I have an existing one (import nsec)");
    }
}

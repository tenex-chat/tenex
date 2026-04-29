//! Bootstrap the agent's `~/.tenex/home/<prefix>/.env` shell file.
//!
//! Mirrors `src/lib/agent-home-env.ts` byte-for-byte. The file lets a
//! shell session auto-load the agent's `NSEC`, `PUBKEY`, `NPUB`, and
//! optionally `RELAYS` so commands run in the agent's home directory
//! sign with the right key.
//!
//! Bootstrap-only: [`ensure_agent_home_env_file`] uses
//! `O_EXCL`-style "create only if missing" semantics so a user who has
//! customised their `.env` keeps their edits across `tenex agent`
//! commands. The `created` field on the result tells the caller
//! whether they just initialised a new file.
//!
//! File permissions are `0o600` (owner read/write only) on creation —
//! the file contains the agent's private key in bech32 form.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use nostr_sdk::{nips::nip19::FromBech32, Keys, SecretKey, ToBech32};

use crate::agent_cmd::openclaw_home::get_agent_home_directory;

/// Outcome of [`ensure_agent_home_env_file`]. `created == true` when a
/// fresh bootstrap was written; `false` when an existing file was kept
/// untouched (preserves user customisations).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureAgentHomeEnvFileResult {
    pub path: PathBuf,
    pub created: bool,
}

/// `agentHomeEnvPath` — the canonical `.env` path for an agent.
pub fn agent_home_env_path(base_dir: &Path, agent_pubkey: &str) -> PathBuf {
    get_agent_home_directory(base_dir, agent_pubkey).join(".env")
}

/// Mirror `normalizeNsecToBech32` (`agent-home-env.ts:16-38`).
///
/// Accepts:
/// - **bech32 nsec** (`nsec1…`) — validated via `SecretKey::from_bech32`,
///   returned as-is on success.
/// - **64-char hex** — parsed via `SecretKey::from_hex`, then re-encoded
///   to bech32.
///
/// Returns an error for empty input or any input that fails to parse
/// as either form. The error messages mirror the TS literals where
/// they exist:
///
/// - empty → `"Agent nsec is empty"`
/// - bech32 decode failure → `"Agent nsec is not a valid bech32 nsec"`
/// - hex decode failure → `"Agent nsec could not be normalized to bech32"`
pub fn normalize_nsec_to_bech32(agent_nsec: &str) -> Result<String> {
    let trimmed = agent_nsec.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Agent nsec is empty"));
    }
    if trimmed.starts_with("nsec1") {
        // Validate by decoding then re-encoding — matches TS
        // `nip19.decode` + structural check + return as-is.
        SecretKey::from_bech32(trimmed)
            .map_err(|_| anyhow!("Agent nsec is not a valid bech32 nsec"))?;
        return Ok(trimmed.to_owned());
    }
    // Hex path — TS uses `new NDKPrivateKeySigner(hex)` then
    // `nsecEncode(privateKey)`. Rust port: parse hex via SecretKey then
    // bech32-encode.
    let sk = SecretKey::from_hex(trimmed)
        .map_err(|_| anyhow!("Agent nsec could not be normalized to bech32"))?;
    sk.to_bech32()
        .map_err(|_| anyhow!("Agent nsec could not be normalized to bech32"))
}

/// `buildAgentHomeEnvBootstrap` — pure string builder for the `.env`
/// file body. Source: `agent-home-env.ts:40-60`.
///
/// Always emits `NSEC`, `PUBKEY`, `NPUB`. `RELAYS` is appended only
/// when at least one relay is supplied. Trailing newline.
pub fn build_agent_home_env_bootstrap(
    normalized_nsec: &str,
    pubkey: &str,
    npub: &str,
    relays: Option<&[String]>,
) -> String {
    let mut out = String::new();
    out.push_str("# TENEX agent shell environment\n");
    out.push_str("# Shell sessions auto-load this file. Add additional KEY=value entries below.\n");
    out.push_str(&format!("NSEC={normalized_nsec}\n"));
    out.push_str(&format!("PUBKEY={pubkey}\n"));
    out.push_str(&format!("NPUB={npub}\n"));
    if let Some(relays) = relays {
        if !relays.is_empty() {
            out.push_str(&format!("RELAYS={}\n", relays.join(",")));
        }
    }
    out
}

/// `ensureAgentHomeEnvFile` — full I/O orchestration. Source:
/// `agent-home-env.ts:66-93`.
///
/// Creates the agent home dir if missing, then atomically attempts to
/// create the `.env` file with `O_EXCL | O_CREAT` semantics + mode
/// `0o600`. Pre-existing file → returns `created: false` without
/// overwriting; new file → writes the bootstrap.
///
/// Computes `pubkey` and `npub` from the (normalised) nsec — the TS
/// source uses `new NDKPrivateKeySigner(nsec).pubkey/npub`.
pub fn ensure_agent_home_env_file(
    base_dir: &Path,
    agent_pubkey: &str,
    agent_nsec: &str,
    relays: Option<&[String]>,
) -> Result<EnsureAgentHomeEnvFileResult> {
    let home_dir = get_agent_home_directory(base_dir, agent_pubkey);
    let env_path = home_dir.join(".env");
    let normalized = normalize_nsec_to_bech32(agent_nsec)?;
    let keys = Keys::parse(&normalized).map_err(|e| anyhow!("parse normalized nsec: {e}"))?;
    let pubkey_hex = keys.public_key().to_hex();
    let npub_bech32 = keys
        .public_key()
        .to_bech32()
        .map_err(|e| anyhow!("encode npub: {e}"))?;

    std::fs::create_dir_all(&home_dir).with_context(|| format!("create {}", home_dir.display()))?;

    let body = build_agent_home_env_bootstrap(&normalized, &pubkey_hex, &npub_bech32, relays);

    match try_create_exclusive(&env_path, body.as_bytes()) {
        Ok(()) => Ok(EnsureAgentHomeEnvFileResult {
            path: env_path,
            created: true,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(EnsureAgentHomeEnvFileResult {
                path: env_path,
                created: false,
            })
        }
        Err(e) => Err(anyhow::Error::new(e).context(format!("write {}", env_path.display()))),
    }
}

/// Unix-only atomic create with `0o600` mode. Mirrors the TS
/// `writeFile(path, body, { flag: "wx", mode: 0o600 })` semantics.
#[cfg(unix)]
fn try_create_exclusive(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body)?;
    Ok(())
}

#[cfg(not(unix))]
fn try_create_exclusive(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-agent-home-env-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixture_keys() -> (String, String, String) {
        // Returns (bech32_nsec, hex_nsec, hex_pubkey)
        let keys = Keys::generate();
        let bech_nsec = keys.secret_key().to_bech32().unwrap();
        let hex_nsec = keys.secret_key().to_secret_hex();
        let hex_pubkey = keys.public_key().to_hex();
        (bech_nsec, hex_nsec, hex_pubkey)
    }

    // ── normalize_nsec_to_bech32 ────────────────────────────────────────

    #[test]
    fn normalize_empty_input_errors_with_verbatim_message() {
        let err = normalize_nsec_to_bech32("").unwrap_err().to_string();
        assert_eq!(err, "Agent nsec is empty");
        let err = normalize_nsec_to_bech32("   ").unwrap_err().to_string();
        assert_eq!(err, "Agent nsec is empty");
    }

    #[test]
    fn normalize_passes_through_bech32_unchanged() {
        let (bech, _, _) = fixture_keys();
        let normalised = normalize_nsec_to_bech32(&bech).unwrap();
        assert_eq!(normalised, bech);
    }

    #[test]
    fn normalize_trims_whitespace_around_bech32() {
        let (bech, _, _) = fixture_keys();
        let padded = format!("  {bech}  ");
        assert_eq!(normalize_nsec_to_bech32(&padded).unwrap(), bech);
    }

    #[test]
    fn normalize_converts_hex_to_bech32() {
        let (bech, hex, _) = fixture_keys();
        assert_eq!(normalize_nsec_to_bech32(&hex).unwrap(), bech);
    }

    #[test]
    fn normalize_invalid_bech32_errors_with_verbatim_message() {
        // Starts with `nsec1` but isn't valid bech32.
        let err = normalize_nsec_to_bech32("nsec1notvalid")
            .unwrap_err()
            .to_string();
        assert_eq!(err, "Agent nsec is not a valid bech32 nsec");
    }

    #[test]
    fn normalize_garbage_errors_with_verbatim_message() {
        let err = normalize_nsec_to_bech32("not-a-key")
            .unwrap_err()
            .to_string();
        assert_eq!(err, "Agent nsec could not be normalized to bech32");
    }

    // ── build_agent_home_env_bootstrap ──────────────────────────────────

    #[test]
    fn bootstrap_emits_canonical_three_lines() {
        let body = build_agent_home_env_bootstrap("nsec1abc", "PK_HEX", "npub1abc", None);
        let expected = "\
# TENEX agent shell environment
# Shell sessions auto-load this file. Add additional KEY=value entries below.
NSEC=nsec1abc
PUBKEY=PK_HEX
NPUB=npub1abc
";
        assert_eq!(body, expected);
    }

    #[test]
    fn bootstrap_appends_relays_when_present() {
        let relays = vec!["wss://relay.example".to_string(), "wss://other".to_string()];
        let body = build_agent_home_env_bootstrap("nsec1abc", "PK", "npub1", Some(&relays));
        assert!(body.contains("RELAYS=wss://relay.example,wss://other\n"));
    }

    #[test]
    fn bootstrap_omits_relays_when_empty() {
        let relays: Vec<String> = Vec::new();
        let body = build_agent_home_env_bootstrap("nsec1abc", "PK", "npub1", Some(&relays));
        assert!(!body.contains("RELAYS"));
    }

    #[test]
    fn bootstrap_ends_with_trailing_newline() {
        let body = build_agent_home_env_bootstrap("a", "b", "c", None);
        assert!(body.ends_with('\n'));
    }

    // ── agent_home_env_path ─────────────────────────────────────────────

    #[test]
    fn env_path_uses_first_8_of_pubkey() {
        let base = Path::new("/tmp/test-base");
        let p = agent_home_env_path(base, "abcdef1234567890abcdef1234567890");
        assert_eq!(p, Path::new("/tmp/test-base/home/abcdef12/.env"));
    }

    // ── ensure_agent_home_env_file ──────────────────────────────────────

    #[test]
    fn ensure_creates_new_file_with_correct_contents_and_mode() {
        let base = unique_temp();
        let (bech_nsec, _, _) = fixture_keys();
        // `agent_pubkey` for the home-dir lookup just needs to be a
        // string with at least 8 chars — using a literal here so we
        // can predict the directory.
        let agent_pubkey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let result = ensure_agent_home_env_file(&base, agent_pubkey, &bech_nsec, None).unwrap();
        assert!(result.created);
        let body = std::fs::read_to_string(&result.path).unwrap();
        assert!(body.contains("# TENEX agent shell environment"));
        assert!(body.contains(&format!("NSEC={bech_nsec}\n")));
        assert!(body.contains("PUBKEY="));
        assert!(body.contains("NPUB=npub1"));

        // Mode check (unix only).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let meta = std::fs::metadata(&result.path).unwrap();
            let mode = meta.permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "got mode {mode:o}");
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_does_not_overwrite_existing_file() {
        let base = unique_temp();
        let (bech_nsec, _, _) = fixture_keys();
        let agent_pubkey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

        // First call creates.
        let first = ensure_agent_home_env_file(&base, agent_pubkey, &bech_nsec, None).unwrap();
        assert!(first.created);

        // Mutate the file — user-customised content.
        std::fs::write(&first.path, b"USER_CUSTOM_CONTENT\n").unwrap();

        // Second call respects existing file.
        let second = ensure_agent_home_env_file(&base, agent_pubkey, &bech_nsec, None).unwrap();
        assert!(!second.created);
        let body = std::fs::read_to_string(&second.path).unwrap();
        assert_eq!(body, "USER_CUSTOM_CONTENT\n");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_creates_intermediate_dirs() {
        let base = unique_temp();
        let (bech_nsec, _, _) = fixture_keys();
        let agent_pubkey = "fffefdfcfbfaf9f8fffefdfcfbfaf9f8fffefdfcfbfaf9f8fffefdfcfbfaf9f8";
        // No `home/` dir exists in `base` yet — ensure mkdir's it.
        let result = ensure_agent_home_env_file(&base, agent_pubkey, &bech_nsec, None).unwrap();
        assert!(result.created);
        assert!(result.path.exists());
        assert!(base.join("home").is_dir());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_propagates_normalize_error() {
        let base = unique_temp();
        let agent_pubkey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let err = ensure_agent_home_env_file(&base, agent_pubkey, "", None).unwrap_err();
        assert_eq!(err.to_string(), "Agent nsec is empty");
        std::fs::remove_dir_all(&base).ok();
    }
}

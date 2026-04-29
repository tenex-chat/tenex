use nostr::{nips::nip19::ToBech32, SecretKey};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Write the agent `.env` file if it does not already exist.
/// Returns `Ok(true)` if created, `Ok(false)` if already present.
pub fn write_agent_env_file(
    home_dir: &Path,
    nsec: &str,
    pubkey_hex: &str,
) -> std::io::Result<bool> {
    let env_path = home_dir.join(".env");

    let nsec_bech32 = SecretKey::parse(nsec)
        .ok()
        .and_then(|sk| sk.to_bech32().ok())
        .unwrap_or_else(|| nsec.to_string());

    let npub = nostr::PublicKey::from_hex(pubkey_hex)
        .ok()
        .and_then(|pk| pk.to_bech32().ok())
        .unwrap_or_else(|| pubkey_hex.to_string());

    let content = format!(
        "# TENEX agent shell environment\n\
         # Shell sessions auto-load this file. Add additional KEY=value entries below.\n\
         NSEC={nsec_bech32}\n\
         PUBKEY={pubkey_hex}\n\
         NPUB={npub}\n\n"
    );

    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&env_path)
    {
        Ok(mut f) => {
            f.write_all(content.as_bytes())?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Parse a simple `KEY=VALUE` dotenv file, skipping comments and blank lines.
/// Does not handle quoting, multiline values, or variable substitution.
pub fn parse_dotenv(path: &Path) -> Vec<(String, String)> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|l| !l.starts_with('#') && l.contains('='))
        .filter_map(|line| {
            let eq = line.find('=')?;
            let key = line[..eq].trim().to_string();
            if key.is_empty() {
                return None;
            }
            let val = line[eq + 1..].to_string();
            Some((key, val))
        })
        .collect()
}

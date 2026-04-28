use nostr::{nips::nip19::ToBech32, SecretKey};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub use tenex_system_prompt::InjectedFile;

const MAX_INJECTED_FILES: usize = 10;
const MAX_INJECTED_FILE_LENGTH: usize = 1500;

pub fn agent_home_dir(base_dir: &Path, pubkey_hex: &str) -> PathBuf {
    base_dir.join("home").join(&pubkey_hex[..8.min(pubkey_hex.len())])
}

pub fn ensure_agent_home_dir(home_dir: &Path) -> bool {
    fs::create_dir_all(home_dir).is_ok()
}

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

/// Return files from `home_dir` whose names start with `+`.
/// Reads at most `MAX_INJECTED_FILES`, truncating content to `MAX_INJECTED_FILE_LENGTH`.
pub fn get_injected_files(home_dir: &Path) -> Vec<InjectedFile> {
    let Ok(read_dir) = fs::read_dir(home_dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<String> = read_dir
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.starts_with('+') && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    candidates.sort();
    candidates.truncate(MAX_INJECTED_FILES);

    candidates
        .into_iter()
        .filter_map(|filename| {
            let content = fs::read_to_string(home_dir.join(&filename)).ok()?;
            let truncated = content.len() > MAX_INJECTED_FILE_LENGTH;
            let content: String = content.chars().take(MAX_INJECTED_FILE_LENGTH).collect();
            Some(InjectedFile { filename, content, truncated })
        })
        .collect()
}

/// Summarise the visible (non-dotfile) contents of `home_dir`.
pub fn count_home_files(home_dir: &Path) -> String {
    let Ok(read_dir) = fs::read_dir(home_dir) else {
        return "(home directory unavailable)".to_string();
    };

    let entries: Vec<_> = read_dir
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();

    if entries.is_empty() {
        return "(empty)".to_string();
    }

    let file_count =
        entries.iter().filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).count();
    let dir_count =
        entries.iter().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).count();

    let mut parts: Vec<String> = Vec::new();
    if file_count > 0 {
        parts.push(format!("{file_count} file{}", if file_count != 1 { "s" } else { "" }));
    }
    if dir_count > 0 {
        parts.push(format!(
            "{dir_count} director{}",
            if dir_count != 1 { "ies" } else { "y" }
        ));
    }
    parts.join(", ")
}

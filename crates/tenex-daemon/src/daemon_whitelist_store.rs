//! Durable persisted whitelist for restart recovery.
//!
//! Writes the current set of whitelisted owner pubkeys to
//! `<daemon_dir>/whitelist.json` so the subscription gateway can rehydrate
//! its initial filter set on restart, even when `config.json` is written
//! after the daemon first started (e.g. via CLI onboarding or SIGHUP reload).
//!
//! The file uses an atomic write (tmp + rename) so a SIGKILL mid-write never
//! leaves a truncated or partially-written file.
//!
//! Format: a JSON object `{ "whitelistedPubkeys": ["hex...", ...] }`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const DAEMON_WHITELIST_FILE_NAME: &str = "whitelist.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonWhitelistFile {
    whitelisted_pubkeys: Vec<String>,
}

fn whitelist_path(daemon_dir: &Path) -> PathBuf {
    daemon_dir.join(DAEMON_WHITELIST_FILE_NAME)
}

/// Read the persisted whitelist from `<daemon_dir>/whitelist.json`.
///
/// Returns an empty `Vec` when the file does not exist or cannot be parsed —
/// the caller is expected to fall back to `config.json` in that case.
pub fn read_daemon_whitelist(daemon_dir: &Path) -> Vec<String> {
    let path = whitelist_path(daemon_dir);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<DaemonWhitelistFile>(&content) {
        Ok(file) => file
            .whitelisted_pubkeys
            .into_iter()
            .filter(|pk| !pk.is_empty())
            .collect(),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "failed to parse daemon whitelist file; ignoring and starting without persisted whitelist"
            );
            Vec::new()
        }
    }
}

/// Write `pubkeys` to `<daemon_dir>/whitelist.json` atomically.
///
/// Errors are logged but not propagated — whitelist persistence is
/// best-effort. A failure here degrades restart recovery but does not break
/// the current daemon session.
pub fn write_daemon_whitelist(daemon_dir: &Path, pubkeys: &[String]) {
    if let Err(error) = try_write_daemon_whitelist(daemon_dir, pubkeys) {
        tracing::warn!(
            daemon_dir = %daemon_dir.display(),
            error = %error,
            "failed to persist daemon whitelist; restart may start without persisted whitelist"
        );
    }
}

fn try_write_daemon_whitelist(daemon_dir: &Path, pubkeys: &[String]) -> io::Result<()> {
    fs::create_dir_all(daemon_dir)?;
    let path = whitelist_path(daemon_dir);
    let tmp_path = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        now_nanos()
    ));
    let file = DaemonWhitelistFile {
        whitelisted_pubkeys: pubkeys.to_vec(),
    };
    {
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        serde_json::to_writer_pretty(&mut handle, &file)?;
        handle.write_all(b"\n")?;
        handle.sync_all()?;
    }
    fs::rename(&tmp_path, &path)?;
    File::open(daemon_dir)?.sync_all()?;
    Ok(())
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time after epoch")
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_non_empty_whitelist() {
        let dir = tempdir().expect("tempdir");
        let pubkeys = vec!["a".repeat(64), "b".repeat(64)];

        write_daemon_whitelist(dir.path(), &pubkeys);
        let read_back = read_daemon_whitelist(dir.path());

        assert_eq!(read_back, pubkeys);
    }

    #[test]
    fn returns_empty_when_file_absent() {
        let dir = tempdir().expect("tempdir");
        assert!(read_daemon_whitelist(dir.path()).is_empty());
    }

    #[test]
    fn returns_empty_on_malformed_file() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join(DAEMON_WHITELIST_FILE_NAME), b"not-json").unwrap();
        assert!(read_daemon_whitelist(dir.path()).is_empty());
    }

    #[test]
    fn filters_empty_pubkeys_on_read() {
        let dir = tempdir().expect("tempdir");
        let raw = r#"{"whitelistedPubkeys": ["", "abc", ""]}"#;
        fs::write(dir.path().join(DAEMON_WHITELIST_FILE_NAME), raw).unwrap();
        let read_back = read_daemon_whitelist(dir.path());
        assert_eq!(read_back, vec!["abc".to_string()]);
    }

    #[test]
    fn overwrites_previous_file_atomically() {
        let dir = tempdir().expect("tempdir");
        let first = vec!["first".to_string()];
        let second = vec!["second".to_string()];

        write_daemon_whitelist(dir.path(), &first);
        write_daemon_whitelist(dir.path(), &second);

        let read_back = read_daemon_whitelist(dir.path());
        assert_eq!(read_back, second);
    }
}

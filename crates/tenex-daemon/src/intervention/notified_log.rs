use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::intervention::state::intervention_dir;

pub const INTERVENTION_NOTIFIED_LOG_FILE: &str = "notified-log.jsonl";
pub const INTERVENTION_NOTIFIED_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const COMPACTION_SIZE_THRESHOLD_BYTES: u64 = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterventionNotifiedEntry {
    pub project_d_tag: String,
    pub conversation_id: String,
    pub notified_at_ms: u64,
}

#[derive(Debug, Error)]
pub enum InterventionNotifiedLogError {
    #[error("intervention notified log io error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("intervention notified log json error at {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}

pub type InterventionNotifiedLogResult<T> = Result<T, InterventionNotifiedLogError>;

pub fn notified_log_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    intervention_dir(daemon_dir).join(INTERVENTION_NOTIFIED_LOG_FILE)
}

pub fn append_notified(
    daemon_dir: impl AsRef<Path>,
    entry: &InterventionNotifiedEntry,
) -> InterventionNotifiedLogResult<()> {
    let dir = intervention_dir(&daemon_dir);
    fs::create_dir_all(&dir)
        .map_err(|source| InterventionNotifiedLogError::Io { path: dir, source })?;
    let path = notified_log_path(&daemon_dir);
    let line =
        serde_json::to_string(entry).map_err(|source| InterventionNotifiedLogError::Json {
            path: path.clone(),
            source,
        })?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|source| InterventionNotifiedLogError::Io {
            path: path.clone(),
            source,
        })?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|source| InterventionNotifiedLogError::Io {
            path: path.clone(),
            source,
        })?;
    file.sync_all()
        .map_err(|source| InterventionNotifiedLogError::Io { path, source })
}

pub fn read_notified_entries(
    daemon_dir: impl AsRef<Path>,
) -> InterventionNotifiedLogResult<Vec<InterventionNotifiedEntry>> {
    let path = notified_log_path(&daemon_dir);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(InterventionNotifiedLogError::Io { path, source }),
    };
    let mut entries = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: InterventionNotifiedEntry =
            serde_json::from_str(line).map_err(|source| InterventionNotifiedLogError::Json {
                path: path.clone(),
                source,
            })?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn is_notified_recently(
    daemon_dir: impl AsRef<Path>,
    project_d_tag: &str,
    conversation_id: &str,
    now_ms: u64,
    ttl_ms: u64,
) -> InterventionNotifiedLogResult<bool> {
    let entries = read_notified_entries(daemon_dir)?;
    Ok(entries.iter().any(|entry| {
        entry.project_d_tag == project_d_tag
            && entry.conversation_id == conversation_id
            && now_ms.saturating_sub(entry.notified_at_ms) < ttl_ms
    }))
}

pub fn compact_if_needed(
    daemon_dir: impl AsRef<Path>,
    now_ms: u64,
    ttl_ms: u64,
) -> InterventionNotifiedLogResult<bool> {
    let path = notified_log_path(&daemon_dir);
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(InterventionNotifiedLogError::Io { path, source }),
    };
    if size < COMPACTION_SIZE_THRESHOLD_BYTES {
        return Ok(false);
    }
    compact(daemon_dir, now_ms, ttl_ms).map(|_| true)
}

pub fn compact(
    daemon_dir: impl AsRef<Path>,
    now_ms: u64,
    ttl_ms: u64,
) -> InterventionNotifiedLogResult<usize> {
    let dir = intervention_dir(&daemon_dir);
    fs::create_dir_all(&dir)
        .map_err(|source| InterventionNotifiedLogError::Io { path: dir, source })?;
    let retained: Vec<InterventionNotifiedEntry> = read_notified_entries(&daemon_dir)?
        .into_iter()
        .filter(|entry| now_ms.saturating_sub(entry.notified_at_ms) < ttl_ms)
        .collect();

    let path = notified_log_path(&daemon_dir);
    let tmp = path.with_extension(format!("jsonl.tmp.{}", std::process::id()));
    {
        let mut file =
            fs::File::create(&tmp).map_err(|source| InterventionNotifiedLogError::Io {
                path: tmp.clone(),
                source,
            })?;
        for entry in &retained {
            let line = serde_json::to_string(entry).map_err(|source| {
                InterventionNotifiedLogError::Json {
                    path: tmp.clone(),
                    source,
                }
            })?;
            file.write_all(line.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|source| InterventionNotifiedLogError::Io {
                    path: tmp.clone(),
                    source,
                })?;
        }
        file.sync_all()
            .map_err(|source| InterventionNotifiedLogError::Io {
                path: tmp.clone(),
                source,
            })?;
    }
    fs::rename(&tmp, &path).map_err(|source| InterventionNotifiedLogError::Io {
        path: path.clone(),
        source,
    })?;
    Ok(retained.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tenex-intervention-log-{nanos}-{counter}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn unknown_conversation_is_not_recently_notified() {
        let dir = unique_temp_daemon_dir();
        assert!(!is_notified_recently(&dir, "p", "c", 1_000, 500).expect("read"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn matches_within_ttl_and_ignores_after_ttl() {
        let dir = unique_temp_daemon_dir();
        append_notified(
            &dir,
            &InterventionNotifiedEntry {
                project_d_tag: "p".to_string(),
                conversation_id: "c".to_string(),
                notified_at_ms: 1_000,
            },
        )
        .expect("append");
        assert!(is_notified_recently(&dir, "p", "c", 1_200, 500).expect("read"));
        assert!(!is_notified_recently(&dir, "p", "c", 2_000, 500).expect("read"));
        assert!(!is_notified_recently(&dir, "p", "other", 1_200, 500).expect("read"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn compact_removes_expired_entries() {
        let dir = unique_temp_daemon_dir();
        for entry in [
            InterventionNotifiedEntry {
                project_d_tag: "p".to_string(),
                conversation_id: "old".to_string(),
                notified_at_ms: 100,
            },
            InterventionNotifiedEntry {
                project_d_tag: "p".to_string(),
                conversation_id: "fresh".to_string(),
                notified_at_ms: 2_000,
            },
        ] {
            append_notified(&dir, &entry).expect("append");
        }
        let retained = compact(&dir, 2_500, 1_000).expect("compact");
        assert_eq!(retained, 1);
        let entries = read_notified_entries(&dir).expect("read entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].conversation_id, "fresh");
        fs::remove_dir_all(&dir).ok();
    }
}

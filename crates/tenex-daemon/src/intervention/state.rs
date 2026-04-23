use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const INTERVENTION_DIR_NAME: &str = "intervention";
pub const INTERVENTION_STATE_FILE: &str = "state.json";
const INTERVENTION_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterventionState {
    pub schema_version: u32,
    pub last_processed_ral_sequence: u64,
}

impl Default for InterventionState {
    fn default() -> Self {
        Self {
            schema_version: INTERVENTION_STATE_SCHEMA_VERSION,
            last_processed_ral_sequence: 0,
        }
    }
}

#[derive(Debug, Error)]
pub enum InterventionStateError {
    #[error("intervention state io error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("intervention state json error at {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error(
        "intervention state at {path} has unsupported schema version {found}, expected {expected}"
    )]
    UnsupportedSchemaVersion {
        path: PathBuf,
        found: u32,
        expected: u32,
    },
}

pub type InterventionStateResult<T> = Result<T, InterventionStateError>;

pub fn intervention_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(INTERVENTION_DIR_NAME)
}

pub fn intervention_state_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    intervention_dir(daemon_dir).join(INTERVENTION_STATE_FILE)
}

pub fn read_intervention_state(
    daemon_dir: impl AsRef<Path>,
) -> InterventionStateResult<InterventionState> {
    let path = intervention_state_path(&daemon_dir);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(InterventionState::default());
        }
        Err(source) => return Err(InterventionStateError::Io { path, source }),
    };

    let state: InterventionState =
        serde_json::from_str(&content).map_err(|source| InterventionStateError::Json {
            path: path.clone(),
            source,
        })?;

    if state.schema_version != INTERVENTION_STATE_SCHEMA_VERSION {
        return Err(InterventionStateError::UnsupportedSchemaVersion {
            path,
            found: state.schema_version,
            expected: INTERVENTION_STATE_SCHEMA_VERSION,
        });
    }

    Ok(state)
}

pub fn write_intervention_state(
    daemon_dir: impl AsRef<Path>,
    state: &InterventionState,
) -> InterventionStateResult<()> {
    let dir = intervention_dir(&daemon_dir);
    fs::create_dir_all(&dir).map_err(|source| InterventionStateError::Io {
        path: dir.clone(),
        source,
    })?;
    let path = intervention_state_path(&daemon_dir);
    let payload = InterventionState {
        schema_version: INTERVENTION_STATE_SCHEMA_VERSION,
        last_processed_ral_sequence: state.last_processed_ral_sequence,
    };
    let serialized =
        serde_json::to_string_pretty(&payload).map_err(|source| InterventionStateError::Json {
            path: path.clone(),
            source,
        })?;
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    fs::write(&tmp, serialized.as_bytes()).map_err(|source| InterventionStateError::Io {
        path: tmp.clone(),
        source,
    })?;
    fs::rename(&tmp, &path).map_err(|source| InterventionStateError::Io {
        path: path.clone(),
        source,
    })
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
        let dir = std::env::temp_dir().join(format!("tenex-intervention-state-{nanos}-{counter}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn defaults_when_state_file_missing() {
        let dir = unique_temp_daemon_dir();
        let state = read_intervention_state(&dir).expect("read state");
        assert_eq!(state.last_processed_ral_sequence, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = unique_temp_daemon_dir();
        write_intervention_state(
            &dir,
            &InterventionState {
                schema_version: INTERVENTION_STATE_SCHEMA_VERSION,
                last_processed_ral_sequence: 1234,
            },
        )
        .expect("write state");
        let state = read_intervention_state(&dir).expect("read state");
        assert_eq!(state.last_processed_ral_sequence, 1234);
        fs::remove_dir_all(&dir).ok();
    }
}

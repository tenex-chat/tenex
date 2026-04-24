use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::dispatch_queue::workers_dir;

const STOP_REQUESTS_DIR: &str = "stop-requests";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStopRequest {
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub stop_event_id: String,
    pub requested_at: u64,
}

pub fn write_worker_stop_request(
    daemon_dir: impl AsRef<Path>,
    request: &WorkerStopRequest,
) -> io::Result<()> {
    let dir = stop_requests_dir(daemon_dir.as_ref());
    fs::create_dir_all(&dir)?;
    let path = stop_request_path(&dir, &request.agent_pubkey, &request.conversation_id);
    let content = serde_json::to_vec_pretty(request)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(path, content)
}

pub fn take_worker_stop_request(
    daemon_dir: impl AsRef<Path>,
    agent_pubkey: &str,
    conversation_id: &str,
) -> io::Result<Option<WorkerStopRequest>> {
    let dir = stop_requests_dir(daemon_dir.as_ref());
    let path = stop_request_path(&dir, agent_pubkey, conversation_id);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let request = serde_json::from_str::<WorkerStopRequest>(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let _ = fs::remove_file(&path);
    Ok(Some(request))
}

fn stop_requests_dir(daemon_dir: &Path) -> PathBuf {
    workers_dir(daemon_dir).join(STOP_REQUESTS_DIR)
}

fn stop_request_path(dir: &Path, agent_pubkey: &str, conversation_id: &str) -> PathBuf {
    dir.join(format!("{agent_pubkey}_{conversation_id}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_and_take_stop_request_roundtrip() {
        let dir = tempdir().expect("temp dir must create");
        let request = WorkerStopRequest {
            agent_pubkey: "a".repeat(64),
            conversation_id: "c".repeat(64),
            stop_event_id: "e".repeat(64),
            requested_at: 1_710_000_000_000,
        };

        write_worker_stop_request(dir.path(), &request).expect("write must succeed");

        let taken =
            take_worker_stop_request(dir.path(), &request.agent_pubkey, &request.conversation_id)
                .expect("take must succeed");
        assert_eq!(taken, Some(request));
    }

    #[test]
    fn take_returns_none_when_no_request_exists() {
        let dir = tempdir().expect("temp dir must create");
        let result = take_worker_stop_request(dir.path(), &"a".repeat(64), &"c".repeat(64))
            .expect("take must succeed");
        assert_eq!(result, None);
    }

    #[test]
    fn take_consumes_the_request() {
        let dir = tempdir().expect("temp dir must create");
        let request = WorkerStopRequest {
            agent_pubkey: "a".repeat(64),
            conversation_id: "c".repeat(64),
            stop_event_id: "e".repeat(64),
            requested_at: 1_710_000_000_000,
        };

        write_worker_stop_request(dir.path(), &request).expect("write must succeed");
        take_worker_stop_request(dir.path(), &request.agent_pubkey, &request.conversation_id)
            .expect("first take must succeed");
        let second =
            take_worker_stop_request(dir.path(), &request.agent_pubkey, &request.conversation_id)
                .expect("second take must succeed");
        assert_eq!(second, None);
    }
}

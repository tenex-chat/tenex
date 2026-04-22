use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const WORKERS_DIR_NAME: &str = "workers";
pub const DISPATCH_QUEUE_FILE_NAME: &str = "dispatch-queue.jsonl";
pub const DISPATCH_QUEUE_RECORD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum DispatchQueueError {
    #[error("dispatch queue io error: {0}")]
    Io(#[from] io::Error),
    #[error("dispatch queue json error on line {line}: {source}")]
    Json {
        line: usize,
        source: serde_json::Error,
    },
}

pub type DispatchQueueResult<T> = Result<T, DispatchQueueError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRalIdentity {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub ral_number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchQueueStatus {
    Queued,
    Leased,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchQueueRecord {
    pub schema_version: u32,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub ral: DispatchRalIdentity,
    pub triggering_event_id: String,
    pub claim_token: String,
    pub status: DispatchQueueStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchQueueRecordParams {
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub ral: DispatchRalIdentity,
    pub triggering_event_id: String,
    pub claim_token: String,
    pub status: DispatchQueueStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DispatchQueueState {
    pub queued: Vec<DispatchQueueRecord>,
    pub leased: Vec<DispatchQueueRecord>,
    pub terminal: Vec<DispatchQueueRecord>,
}

pub fn workers_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(WORKERS_DIR_NAME)
}

pub fn dispatch_queue_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join(DISPATCH_QUEUE_FILE_NAME)
}

pub fn build_dispatch_queue_record(params: DispatchQueueRecordParams) -> DispatchQueueRecord {
    DispatchQueueRecord {
        schema_version: DISPATCH_QUEUE_RECORD_SCHEMA_VERSION,
        sequence: params.sequence,
        timestamp: params.timestamp,
        correlation_id: params.correlation_id,
        dispatch_id: params.dispatch_id,
        ral: params.ral,
        triggering_event_id: params.triggering_event_id,
        claim_token: params.claim_token,
        status: params.status,
    }
}

pub fn append_dispatch_queue_record(
    daemon_dir: impl AsRef<Path>,
    record: &DispatchQueueRecord,
) -> DispatchQueueResult<()> {
    let path = dispatch_queue_path(daemon_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(record)
            .map_err(|source| { DispatchQueueError::Json { line: 0, source } })?
    )?;
    Ok(())
}

pub fn read_dispatch_queue_records(
    daemon_dir: impl AsRef<Path>,
) -> DispatchQueueResult<Vec<DispatchQueueRecord>> {
    read_dispatch_queue_records_from_path(dispatch_queue_path(daemon_dir))
}

pub fn read_dispatch_queue_records_from_path(
    path: impl AsRef<Path>,
) -> DispatchQueueResult<Vec<DispatchQueueRecord>> {
    let path = path.as_ref();
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut records = Vec::new();
    let content_has_complete_final_line = content.ends_with('\n');
    let line_count = content.lines().count();

    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<DispatchQueueRecord>(line) {
            Ok(record) => records.push(record),
            Err(source) if index + 1 == line_count && !content_has_complete_final_line => {
                break;
            }
            Err(source) => {
                return Err(DispatchQueueError::Json {
                    line: index + 1,
                    source,
                });
            }
        }
    }

    Ok(records)
}

pub fn replay_dispatch_queue(
    daemon_dir: impl AsRef<Path>,
) -> DispatchQueueResult<DispatchQueueState> {
    replay_dispatch_queue_records(read_dispatch_queue_records(daemon_dir)?)
}

pub fn replay_dispatch_queue_records(
    records: Vec<DispatchQueueRecord>,
) -> DispatchQueueResult<DispatchQueueState> {
    let mut latest_by_dispatch_id: BTreeMap<String, DispatchQueueRecord> = BTreeMap::new();

    for record in records {
        latest_by_dispatch_id.insert(record.dispatch_id.clone(), record);
    }

    let mut state = DispatchQueueState::default();
    for record in latest_by_dispatch_id.into_values() {
        match record.status {
            DispatchQueueStatus::Queued => state.queued.push(record),
            DispatchQueueStatus::Leased => state.leased.push(record),
            DispatchQueueStatus::Completed | DispatchQueueStatus::Cancelled => {
                state.terminal.push(record);
            }
        }
    }

    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn dispatch_queue_appends_and_reads_jsonl_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);

        append_dispatch_queue_record(&daemon_dir, &record).expect("append must succeed");

        assert_eq!(
            read_dispatch_queue_records(&daemon_dir).expect("read must succeed"),
            vec![record]
        );
    }

    #[test]
    fn dispatch_queue_replay_keeps_latest_record_per_dispatch() {
        let identity = build_identity();
        let records = vec![
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1000,
                correlation_id: "correlation-1".to_string(),
                dispatch_id: "dispatch-1".to_string(),
                ral: identity.clone(),
                triggering_event_id: "event-1".to_string(),
                claim_token: "claim-1".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 2,
                timestamp: 1001,
                correlation_id: "correlation-1".to_string(),
                dispatch_id: "dispatch-1".to_string(),
                ral: identity.clone(),
                triggering_event_id: "event-1".to_string(),
                claim_token: "claim-1".to_string(),
                status: DispatchQueueStatus::Leased,
            }),
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 3,
                timestamp: 1002,
                correlation_id: "correlation-2".to_string(),
                dispatch_id: "dispatch-2".to_string(),
                ral: identity,
                triggering_event_id: "event-2".to_string(),
                claim_token: "claim-2".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        ];

        let state = replay_dispatch_queue_records(records).expect("replay must succeed");

        assert_eq!(state.queued.len(), 1);
        assert_eq!(state.queued[0].dispatch_id, "dispatch-2");
        assert_eq!(state.leased.len(), 1);
        assert_eq!(state.leased[0].dispatch_id, "dispatch-1");
        assert!(state.terminal.is_empty());
    }

    #[test]
    fn dispatch_queue_replay_separates_terminal_records() {
        let records = vec![
            build_record(1, "dispatch-1", DispatchQueueStatus::Queued),
            build_record(2, "dispatch-1", DispatchQueueStatus::Completed),
            build_record(3, "dispatch-2", DispatchQueueStatus::Cancelled),
        ];

        let state = replay_dispatch_queue_records(records).expect("replay must succeed");

        assert!(state.queued.is_empty());
        assert!(state.leased.is_empty());
        assert_eq!(
            state
                .terminal
                .iter()
                .map(|record| record.dispatch_id.as_str())
                .collect::<Vec<_>>(),
            vec!["dispatch-1", "dispatch-2"]
        );
    }

    #[test]
    fn dispatch_queue_read_ignores_truncated_final_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let path = dispatch_queue_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("queue file must have parent"))
            .expect("workers dir must be created");
        fs::write(
            &path,
            format!(
                "{}\n{{\"schemaVersion\":1,\"dispatchId\"",
                serde_json::to_string(&record).expect("record must serialize")
            ),
        )
        .expect("queue file write must succeed");

        assert_eq!(
            read_dispatch_queue_records(&daemon_dir).expect("read must succeed"),
            vec![record]
        );
    }

    #[test]
    fn dispatch_queue_read_rejects_corrupt_non_final_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let path = dispatch_queue_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("queue file must have parent"))
            .expect("workers dir must be created");
        fs::write(
            &path,
            format!(
                "{{\"schemaVersion\":1,\"dispatchId\"\n{}\n",
                serde_json::to_string(&record).expect("record must serialize")
            ),
        )
        .expect("queue file write must succeed");

        let error =
            read_dispatch_queue_records(&daemon_dir).expect_err("corrupt middle line must fail");

        assert!(matches!(error, DispatchQueueError::Json { line: 1, .. }));
    }

    fn build_record(
        sequence: u64,
        dispatch_id: &str,
        status: DispatchQueueStatus,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1710000000000 + sequence,
            correlation_id: format!("correlation-{sequence}"),
            dispatch_id: dispatch_id.to_string(),
            ral: build_identity(),
            triggering_event_id: format!("event-{sequence}"),
            claim_token: format!("claim-{sequence}"),
            status,
        })
    }

    fn build_identity() -> DispatchRalIdentity {
        DispatchRalIdentity {
            project_id: "project-1".to_string(),
            agent_pubkey: "agent-pubkey-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            ral_number: 1,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-daemon-dispatch-queue-test-{}-{nanos}-{counter}",
            std::process::id()
        ))
    }
}

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::routing_shadow::{
    ROUTING_SHADOW_SCHEMA_VERSION, ROUTING_SHADOW_WRITER, RoutingShadowRecord,
};

pub const ROUTING_DIR_NAME: &str = "routing";
pub const ROUTING_SHADOW_LOG_FILE_NAME: &str = "shadow-decisions.jsonl";

#[derive(Debug, Error)]
pub enum RoutingShadowLogError {
    #[error("routing shadow io error: {0}")]
    Io(#[from] io::Error),
    #[error("routing shadow json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("routing shadow json error at line {line}: {source}")]
    JsonLine {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "routing shadow schema version {schema_version} is unsupported at line {line}; supported version is {supported_schema_version}"
    )]
    UnsupportedSchemaVersion {
        line: usize,
        schema_version: u32,
        supported_schema_version: u32,
    },
    #[error(
        "routing shadow writer {writer} is unsupported at line {line}; supported writer is {supported_writer}"
    )]
    UnsupportedWriter {
        line: usize,
        writer: String,
        supported_writer: String,
    },
}

pub type RoutingShadowLogResult<T> = Result<T, RoutingShadowLogError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RoutingShadowLogDiagnostics {
    pub record_count: usize,
    pub latest_observed_at: Option<u64>,
    pub distinct_decision_methods: Vec<String>,
    pub distinct_target_project_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingShadowLogReplay {
    pub records: Vec<RoutingShadowRecord>,
    pub diagnostics: RoutingShadowLogDiagnostics,
}

pub fn routing_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(ROUTING_DIR_NAME)
}

pub fn routing_shadow_log_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    routing_dir(daemon_dir).join(ROUTING_SHADOW_LOG_FILE_NAME)
}

pub fn append_routing_shadow_record(
    daemon_dir: impl AsRef<Path>,
    record: &RoutingShadowRecord,
) -> RoutingShadowLogResult<()> {
    let path = routing_shadow_log_path(daemon_dir);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{}", serde_json::to_string(record)?)?;
    file.sync_all()?;
    sync_parent_dir(&path)?;
    Ok(())
}

pub fn read_routing_shadow_records(
    daemon_dir: impl AsRef<Path>,
) -> RoutingShadowLogResult<Vec<RoutingShadowRecord>> {
    read_routing_shadow_records_from_path(routing_shadow_log_path(daemon_dir))
}

pub fn read_routing_shadow_records_from_path(
    path: impl AsRef<Path>,
) -> RoutingShadowLogResult<Vec<RoutingShadowRecord>> {
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

        match serde_json::from_str::<RoutingShadowRecord>(line) {
            Ok(record) => {
                validate_routing_shadow_record(&record, index + 1)?;
                records.push(record);
            }
            Err(source)
                if index + 1 == line_count
                    && !content_has_complete_final_line
                    && source.is_eof() =>
            {
                break;
            }
            Err(source) => {
                return Err(RoutingShadowLogError::JsonLine {
                    line: index + 1,
                    source,
                });
            }
        }
    }

    Ok(records)
}

pub fn replay_routing_shadow_log(
    daemon_dir: impl AsRef<Path>,
) -> RoutingShadowLogResult<RoutingShadowLogReplay> {
    replay_routing_shadow_records(read_routing_shadow_records(daemon_dir)?)
}

pub fn replay_routing_shadow_records(
    records: Vec<RoutingShadowRecord>,
) -> RoutingShadowLogResult<RoutingShadowLogReplay> {
    for (index, record) in records.iter().enumerate() {
        validate_routing_shadow_record(record, index + 1)?;
    }

    let diagnostics = build_routing_shadow_log_diagnostics(&records);
    Ok(RoutingShadowLogReplay {
        records,
        diagnostics,
    })
}

pub fn build_routing_shadow_log_diagnostics(
    records: &[RoutingShadowRecord],
) -> RoutingShadowLogDiagnostics {
    let latest_observed_at = records.iter().map(|record| record.observed_at).max();
    let mut decision_methods = BTreeSet::new();
    let mut target_project_ids = BTreeSet::new();

    for record in records {
        decision_methods.insert(record.decision.method.clone());

        if let Some(project_id) = &record.decision.project_id {
            target_project_ids.insert(project_id.clone());
        }
    }

    RoutingShadowLogDiagnostics {
        record_count: records.len(),
        latest_observed_at,
        distinct_decision_methods: decision_methods.into_iter().collect(),
        distinct_target_project_ids: target_project_ids.into_iter().collect(),
    }
}

fn validate_routing_shadow_record(
    record: &RoutingShadowRecord,
    line: usize,
) -> RoutingShadowLogResult<()> {
    if record.schema_version != ROUTING_SHADOW_SCHEMA_VERSION {
        return Err(RoutingShadowLogError::UnsupportedSchemaVersion {
            line,
            schema_version: record.schema_version,
            supported_schema_version: ROUTING_SHADOW_SCHEMA_VERSION,
        });
    }

    if record.writer != ROUTING_SHADOW_WRITER {
        return Err(RoutingShadowLogError::UnsupportedWriter {
            line,
            writer: record.writer.clone(),
            supported_writer: ROUTING_SHADOW_WRITER.to_string(),
        });
    }
    Ok(())
}

fn sync_parent_dir(path: &Path) -> RoutingShadowLogResult<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let dir = File::open(parent)?;
    dir.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::{ProjectFixture, RoutingEvent};
    use crate::routing_shadow::{RoutingShadowInput, build_routing_shadow_record};
    use serde_json::json;
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn append_and_read_routing_shadow_record_round_trip() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = sample_a_tag_record(1_710_001_000_100);

        append_routing_shadow_record(&daemon_dir, &record)
            .expect("shadow record append must succeed");

        let records = read_routing_shadow_records(&daemon_dir).expect("shadow records must read");
        assert_eq!(records, vec![record]);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn reads_multiple_shadow_records_in_append_order() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_a_tag_record(1_710_001_000_100);
        let second = sample_p_tag_record(1_710_001_000_200);

        append_routing_shadow_record(&daemon_dir, &first)
            .expect("first shadow record append must succeed");
        append_routing_shadow_record(&daemon_dir, &second)
            .expect("second shadow record append must succeed");

        let replay = replay_routing_shadow_log(&daemon_dir).expect("shadow replay must succeed");
        assert_eq!(replay.records, vec![first.clone(), second.clone()]);
        assert_eq!(replay.diagnostics.record_count, 2);
        assert_eq!(
            replay.diagnostics.latest_observed_at,
            Some(1_710_001_000_200)
        );
        assert_eq!(
            replay.diagnostics.distinct_decision_methods,
            vec!["a_tag".to_string(), "p_tag_agent".to_string()]
        );
        assert_eq!(
            replay.diagnostics.distinct_target_project_ids,
            vec!["project-alpha".to_string(), "project-beta".to_string()]
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_ignores_truncated_final_jsonl_line() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = sample_a_tag_record(1_710_001_000_100);
        append_routing_shadow_record(&daemon_dir, &record)
            .expect("shadow record append must succeed");

        let mut file = OpenOptions::new()
            .append(true)
            .open(routing_shadow_log_path(&daemon_dir))
            .expect("shadow log must open");
        file.write_all(b"{\"schemaVersion\":1,\"writer\"")
            .expect("truncated line write must succeed");
        file.sync_all().expect("shadow log sync must succeed");

        let records = read_routing_shadow_records(&daemon_dir).expect("shadow records must read");
        assert_eq!(records, vec![record]);

        let replay = replay_routing_shadow_log(&daemon_dir).expect("shadow replay must succeed");
        assert_eq!(replay.diagnostics.record_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_fails_on_corrupt_non_final_jsonl_line() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = routing_shadow_log_path(&daemon_dir);
        fs::create_dir_all(
            path.parent()
                .expect("shadow log path must have parent directory"),
        )
        .expect("shadow log directory must be created");

        let valid_first = serde_json::to_string(&sample_a_tag_record(1_710_001_000_100))
            .expect("first record must serialize");
        let valid_third = serde_json::to_string(&sample_p_tag_record(1_710_001_000_300))
            .expect("third record must serialize");
        fs::write(
            &path,
            format!("{valid_first}\n{{\"schemaVersion\":\n{valid_third}\n"),
        )
        .expect("corrupt shadow log must be written");

        match replay_routing_shadow_log(&daemon_dir) {
            Err(RoutingShadowLogError::JsonLine { line, source }) => {
                assert_eq!(line, 2);
                assert!(source.is_eof());
            }
            other => panic!("expected corrupt non-final JSONL error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_rejects_unsupported_schema_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = routing_shadow_log_path(&daemon_dir);
        fs::create_dir_all(
            path.parent()
                .expect("shadow log path must have parent directory"),
        )
        .expect("shadow log directory must be created");
        let record = sample_a_tag_record(1_710_001_000_100);
        let mut value = serde_json::to_value(&record).expect("record must serialize to value");
        value["schemaVersion"] = json!(ROUTING_SHADOW_SCHEMA_VERSION + 1);

        fs::write(
            &path,
            serde_json::to_string(&value).expect("value must serialize"),
        )
        .expect("shadow log must be written");

        match replay_routing_shadow_log(&daemon_dir) {
            Err(RoutingShadowLogError::UnsupportedSchemaVersion {
                line,
                schema_version,
                supported_schema_version,
            }) => {
                assert_eq!(line, 1);
                assert_eq!(schema_version, ROUTING_SHADOW_SCHEMA_VERSION + 1);
                assert_eq!(supported_schema_version, ROUTING_SHADOW_SCHEMA_VERSION);
            }
            other => panic!("expected unsupported schema version error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_rejects_unsupported_writer() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = routing_shadow_log_path(&daemon_dir);
        fs::create_dir_all(
            path.parent()
                .expect("shadow log path must have parent directory"),
        )
        .expect("shadow log directory must be created");
        let record = sample_a_tag_record(1_710_001_000_100);
        let mut value = serde_json::to_value(&record).expect("record must serialize to value");
        value["writer"] = json!("other-writer");

        fs::write(
            &path,
            serde_json::to_string(&value).expect("value must serialize"),
        )
        .expect("shadow log must be written");

        match replay_routing_shadow_log(&daemon_dir) {
            Err(RoutingShadowLogError::UnsupportedWriter {
                line,
                writer,
                supported_writer,
            }) => {
                assert_eq!(line, 1);
                assert_eq!(writer, "other-writer");
                assert_eq!(supported_writer, ROUTING_SHADOW_WRITER);
            }
            other => panic!("expected unsupported writer error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn sample_a_tag_record(observed_at: u64) -> RoutingShadowRecord {
        build_routing_shadow_record(RoutingShadowInput {
            observed_at,
            writer_version: "test-version".to_string(),
            event: RoutingEvent {
                id: "event-a".to_string(),
                kind: 1,
                pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                content: String::new(),
                tags: vec![vec![
                    "a".to_string(),
                    "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:project-beta"
                        .to_string(),
                ]],
            },
            projects: sample_projects(),
            active_project_ids: vec!["project-beta".to_string()],
        })
    }

    fn sample_p_tag_record(observed_at: u64) -> RoutingShadowRecord {
        build_routing_shadow_record(RoutingShadowInput {
            observed_at,
            writer_version: "test-version".to_string(),
            event: RoutingEvent {
                id: "event-p".to_string(),
                kind: 1,
                pubkey: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_string(),
                content: String::new(),
                tags: vec![vec![
                    "p".to_string(),
                    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_string(),
                ]],
            },
            projects: sample_projects(),
            active_project_ids: vec!["project-alpha".to_string()],
        })
    }

    fn sample_projects() -> Vec<ProjectFixture> {
        vec![
            ProjectFixture {
                d_tag: "project-alpha".to_string(),
                address: "31933:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:project-alpha"
                    .to_string(),
                title: "Alpha".to_string(),
                agents: vec![crate::routing::AgentFixture {
                    pubkey: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                        .to_string(),
                    slug: "alpha-agent".to_string(),
                }],
            },
            ProjectFixture {
                d_tag: "project-beta".to_string(),
                address: "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:project-beta"
                    .to_string(),
                title: "Beta".to_string(),
                agents: vec![crate::routing::AgentFixture {
                    pubkey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_string(),
                    slug: "beta-agent".to_string(),
                }],
            },
        ]
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-routing-shadow-log-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}

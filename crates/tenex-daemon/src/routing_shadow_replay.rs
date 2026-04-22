use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::routing::RoutingDecision;
use crate::routing::determine_target_project;
use crate::routing_shadow::RoutingShadowRecord;
use crate::routing_shadow_log::{RoutingShadowLogError, read_routing_shadow_records};

const NO_TARGET_PROJECT: &str = "none";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingShadowReplayReport {
    pub total_records: usize,
    pub matched_decisions: usize,
    pub mismatches: Vec<RoutingShadowReplayMismatch>,
    pub method_counts: BTreeMap<String, usize>,
    pub target_project_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingShadowReplayMismatch {
    pub event_id: String,
    pub reason: String,
    pub stored_decision: RoutingShadowReplayDecision,
    pub recomputed_decision: RoutingShadowReplayDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingShadowReplayDecision {
    pub method: String,
    pub project_id: Option<String>,
}

pub fn replay_routing_shadow_log(
    daemon_dir: impl AsRef<Path>,
) -> Result<RoutingShadowReplayReport, RoutingShadowLogError> {
    let records = read_routing_shadow_records(daemon_dir)?;
    Ok(replay_routing_shadow_records(&records))
}

pub fn replay_routing_shadow_records(records: &[RoutingShadowRecord]) -> RoutingShadowReplayReport {
    let mut matched_decisions = 0usize;
    let mut mismatches = Vec::new();
    let mut method_counts = BTreeMap::<String, usize>::new();
    let mut target_project_counts = BTreeMap::<String, usize>::new();

    for record in records {
        let recomputed_decision =
            determine_target_project(&record.event, &record.projects, &record.active_project_ids);

        increment_count(&mut method_counts, recomputed_decision.method.clone());
        increment_count(
            &mut target_project_counts,
            target_project_key(recomputed_decision.project_id.as_deref()),
        );

        if record.decision == recomputed_decision {
            matched_decisions += 1;
        } else {
            mismatches.push(RoutingShadowReplayMismatch {
                event_id: compact_event_id(&record.event.id),
                reason: describe_decision_diff(&record.decision, &recomputed_decision),
                stored_decision: routing_shadow_replay_decision(&record.decision),
                recomputed_decision: routing_shadow_replay_decision(&recomputed_decision),
            });
        }
    }

    RoutingShadowReplayReport {
        total_records: records.len(),
        matched_decisions,
        mismatches,
        method_counts,
        target_project_counts,
    }
}

fn routing_shadow_replay_decision(decision: &RoutingDecision) -> RoutingShadowReplayDecision {
    RoutingShadowReplayDecision {
        method: decision.method.clone(),
        project_id: decision.project_id.clone(),
    }
}

fn describe_decision_diff(stored: &RoutingDecision, recomputed: &RoutingDecision) -> String {
    let mut parts = Vec::new();

    if stored.method != recomputed.method {
        parts.push(format!("method {} -> {}", stored.method, recomputed.method));
    }

    if stored.project_id != recomputed.project_id {
        parts.push(format!(
            "project {} -> {}",
            compact_option(&stored.project_id),
            compact_option(&recomputed.project_id)
        ));
    }

    if stored.matched_tags != recomputed.matched_tags {
        parts.push(format!(
            "matched_tags {} -> {}",
            compact_string_list(&stored.matched_tags),
            compact_string_list(&recomputed.matched_tags)
        ));
    }

    if stored.reason != recomputed.reason {
        parts.push(format!(
            "reason {} -> {}",
            compact_text(&stored.reason, 64),
            compact_text(&recomputed.reason, 64)
        ));
    }

    if parts.is_empty() {
        "decision differs".to_string()
    } else {
        parts.join("; ")
    }
}

fn increment_count(map: &mut BTreeMap<String, usize>, key: String) {
    *map.entry(key).or_insert(0) += 1;
}

fn target_project_key(project_id: Option<&str>) -> String {
    project_id.unwrap_or(NO_TARGET_PROJECT).to_string()
}

fn compact_event_id(event_id: &str) -> String {
    compact_text(event_id, 12)
}

fn compact_option(value: &Option<String>) -> String {
    match value {
        Some(value) => compact_text(value, 24),
        None => NO_TARGET_PROJECT.to_string(),
    }
}

fn compact_string_list(values: &[String]) -> String {
    if values.is_empty() {
        return "[]".to_string();
    }

    let preview = values
        .iter()
        .take(2)
        .map(|value| format!("\"{}\"", compact_text(value, 16)))
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if values.len() > 2 { ", ..." } else { "" };
    format!("[{preview}{suffix}]")
}

fn compact_text(value: &str, max_len: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_len {
        return collapsed;
    }

    let mut compacted = collapsed.chars().take(max_len).collect::<String>();
    compacted.push_str("...");
    compacted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::{AgentFixture, ProjectFixture, RoutingEvent};
    use crate::routing_shadow::{RoutingShadowInput, build_routing_shadow_record};
    use crate::routing_shadow_log::{
        RoutingShadowLogError, replay_routing_shadow_log, routing_shadow_log_path,
    };
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn replay_reports_matches_and_counts() {
        let records = vec![
            sample_a_tag_record(1_710_001_000_100),
            sample_p_tag_record(1_710_001_000_200),
        ];

        let report = replay_routing_shadow_records(&records);

        assert_eq!(
            serde_json::to_value(&report).expect("report must serialize"),
            json!({
                "totalRecords": 2,
                "matchedDecisions": 2,
                "mismatches": [],
                "methodCounts": {
                    "a_tag": 1,
                    "p_tag_agent": 1,
                },
                "targetProjectCounts": {
                    "project-alpha": 1,
                    "project-beta": 1,
                },
            })
        );
    }

    #[test]
    fn replay_reports_intentional_mismatch() {
        let mut record = sample_a_tag_record(1_710_001_000_100);
        record.decision.method = "none".to_string();
        record.decision.project_id = None;
        record.decision.matched_tags.clear();
        record.decision.reason = "tampered".to_string();

        let report = replay_routing_shadow_records(&[record]);

        assert_eq!(report.total_records, 1);
        assert_eq!(report.matched_decisions, 0);
        assert_eq!(report.mismatches.len(), 1);
        assert_eq!(
            report.method_counts,
            BTreeMap::from([("a_tag".to_string(), 1)])
        );
        assert_eq!(
            report.target_project_counts,
            BTreeMap::from([("project-beta".to_string(), 1)])
        );

        let mismatch = &report.mismatches[0];
        assert_eq!(mismatch.event_id, "event-a");
        assert_eq!(mismatch.stored_decision.method, "none");
        assert_eq!(mismatch.recomputed_decision.method, "a_tag");
        assert_eq!(mismatch.stored_decision.project_id, None);
        assert_eq!(
            mismatch.recomputed_decision.project_id,
            Some("project-beta".to_string())
        );
        assert!(mismatch.reason.contains("method"));
        assert!(mismatch.reason.contains("project"));
        assert!(mismatch.reason.contains("matched_tags"));
        assert!(mismatch.reason.contains("reason"));
    }

    #[test]
    fn replay_handles_empty_log() {
        let report = replay_routing_shadow_records(&[]);

        assert_eq!(
            serde_json::to_value(&report).expect("report must serialize"),
            json!({
                "totalRecords": 0,
                "matchedDecisions": 0,
                "mismatches": [],
                "methodCounts": {},
                "targetProjectCounts": {},
            })
        );
    }

    #[test]
    fn file_replay_propagates_corrupt_log_errors() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = routing_shadow_log_path(&daemon_dir);

        fs::create_dir_all(
            path.parent()
                .expect("routing shadow log path must have parent"),
        )
        .expect("routing shadow log directory must be created");
        fs::write(&path, "{not-json}\n").expect("corrupt shadow log must be written");

        match replay_routing_shadow_log(&daemon_dir) {
            Err(RoutingShadowLogError::JsonLine { line, .. }) => assert_eq!(line, 1),
            other => panic!("expected corrupt log error, got {other:?}"),
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
                agents: vec![AgentFixture {
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
                agents: vec![AgentFixture {
                    pubkey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_string(),
                    slug: "beta-agent".to_string(),
                }],
            },
        ]
    }

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-routing-shadow-replay-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}

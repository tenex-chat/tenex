use serde::{Deserialize, Serialize};

use crate::routing::{ProjectFixture, RoutingDecision, RoutingEvent, determine_target_project};

pub const ROUTING_SHADOW_SCHEMA_VERSION: u32 = 1;
pub const ROUTING_SHADOW_WRITER: &str = "rust-daemon";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingShadowInput {
    pub observed_at: u64,
    pub writer_version: String,
    pub event: RoutingEvent,
    pub projects: Vec<ProjectFixture>,
    pub active_project_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingShadowRecord {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub observed_at: u64,
    pub event: RoutingEvent,
    pub projects: Vec<ProjectFixture>,
    pub active_project_ids: Vec<String>,
    pub decision: RoutingDecision,
}

pub fn build_routing_shadow_record(input: RoutingShadowInput) -> RoutingShadowRecord {
    let decision =
        determine_target_project(&input.event, &input.projects, &input.active_project_ids);

    RoutingShadowRecord {
        schema_version: ROUTING_SHADOW_SCHEMA_VERSION,
        writer: ROUTING_SHADOW_WRITER.to_string(),
        writer_version: input.writer_version,
        observed_at: input.observed_at,
        event: input.event,
        projects: input.projects,
        active_project_ids: input.active_project_ids,
        decision,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::RoutingFixture;
    use serde_json::json;

    const ROUTING_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/routing-decisions.compat.json");

    #[test]
    fn routing_shadow_record_matches_routing_fixture() {
        let fixture: RoutingFixture =
            serde_json::from_str(ROUTING_FIXTURE).expect("fixture must parse");
        let projects = fixture.projects.clone();

        for case in fixture.cases {
            let case_name = case.name.clone();
            let event = case.event.clone();
            let active_project_ids = case.active_project_ids.clone();
            let expected_decision = case.expected.clone();

            let record = build_routing_shadow_record(RoutingShadowInput {
                observed_at: 1_710_000_000_000,
                writer_version: "test-version".to_string(),
                event: event.clone(),
                projects: projects.clone(),
                active_project_ids: active_project_ids.clone(),
            });

            let serialized = serde_json::to_value(&record).expect("record must serialize");
            let expected = json!({
                "schemaVersion": 1,
                "writer": "rust-daemon",
                "writerVersion": "test-version",
                "observedAt": 1_710_000_000_000_u64,
                "event": event,
                "projects": projects,
                "activeProjectIds": active_project_ids,
                "decision": expected_decision,
            });

            assert_eq!(serialized, expected, "case {}", case_name);
        }
    }
}

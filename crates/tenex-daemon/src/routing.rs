use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFixture {
    pub name: String,
    pub description: String,
    pub projects: Vec<ProjectFixture>,
    pub cases: Vec<RoutingCaseFixture>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFixture {
    pub d_tag: String,
    pub address: String,
    pub title: String,
    pub agents: Vec<AgentFixture>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct AgentFixture {
    pub pubkey: String,
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingCaseFixture {
    pub name: String,
    pub active_project_ids: Vec<String>,
    pub event: RoutingEvent,
    pub expected: RoutingDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RoutingEvent {
    pub id: String,
    pub kind: u64,
    pub pubkey: String,
    pub content: String,
    pub tags: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecision {
    pub project_id: Option<String>,
    pub method: String,
    pub matched_tags: Vec<String>,
    pub reason: String,
}

struct RoutingContext<'a> {
    known_projects: HashSet<&'a str>,
    agent_project_index: HashMap<&'a str, Vec<&'a str>>,
    project_agents: HashMap<&'a str, HashSet<&'a str>>,
    active_project_ids: HashSet<&'a str>,
}

pub fn determine_target_project(
    event: &RoutingEvent,
    projects: &[ProjectFixture],
    active_project_ids: &[String],
) -> RoutingDecision {
    if event.kind == 0 || event.kind == 3 {
        return RoutingDecision {
            project_id: None,
            method: "none".to_string(),
            matched_tags: Vec::new(),
            reason: format!(
                "Global identity kind ({}) - not project-specific",
                event.kind
            ),
        };
    }

    let context = RoutingContext::new(projects, active_project_ids);

    if let Some(decision) = route_by_a_tag(event, &context) {
        return decision;
    }

    if let Some(decision) = route_by_p_tag(event, &context) {
        return decision;
    }

    no_match_decision(event)
}

fn route_by_a_tag(event: &RoutingEvent, context: &RoutingContext<'_>) -> Option<RoutingDecision> {
    for tag in project_a_tags(event) {
        let Some(address) = tag.get(1) else {
            continue;
        };
        let Some(d_tag) = try_extract_d_tag_from_address(address) else {
            continue;
        };

        if context.known_projects.contains(d_tag.as_str()) {
            return Some(RoutingDecision {
                project_id: Some(d_tag),
                method: "a_tag".to_string(),
                matched_tags: vec![address.clone()],
                reason: format!("Matched project a-tag: {address}"),
            });
        }
    }

    None
}

fn route_by_p_tag(event: &RoutingEvent, context: &RoutingContext<'_>) -> Option<RoutingDecision> {
    for tag in event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == "p"))
    {
        let Some(pubkey) = tag.get(1) else {
            continue;
        };
        let Some(project_ids) = context.agent_project_index.get(pubkey.as_str()) else {
            continue;
        };

        let active_projects_for_agent: Vec<&str> = project_ids
            .iter()
            .copied()
            .filter(|project_id| context.active_project_ids.contains(project_id))
            .filter(|project_id| {
                context
                    .project_agents
                    .get(project_id)
                    .is_some_and(|agents| agents.contains(pubkey.as_str()))
            })
            .collect();

        if active_projects_for_agent.len() != 1 {
            return None;
        }

        return Some(RoutingDecision {
            project_id: Some(active_projects_for_agent[0].to_string()),
            method: "p_tag_agent".to_string(),
            matched_tags: vec![pubkey.clone()],
            reason: format!("Matched agent P-tag: {}", first_chars(pubkey, 8)),
        });
    }

    None
}

fn no_match_decision(event: &RoutingEvent) -> RoutingDecision {
    let a_tags = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == "a"));
    let p_tags: Vec<&Vec<String>> = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == "p"))
        .collect();
    let project_a_tags: Vec<String> = a_tags
        .filter_map(|tag| tag.get(1))
        .filter(|value| value.starts_with("31933:"))
        .cloned()
        .collect();

    let reason = if !project_a_tags.is_empty() {
        format!(
            "A-tags found but no matching known projects: {}",
            project_a_tags.join(", ")
        )
    } else if !p_tags.is_empty() {
        let p_tag_prefixes: Vec<String> = p_tags
            .iter()
            .filter_map(|tag| tag.get(1))
            .map(|pubkey| first_chars(pubkey, 8))
            .collect();
        format!(
            "P-tags found but no matching agents: {}",
            p_tag_prefixes.join(", ")
        )
    } else {
        "No A-tags or P-tags found".to_string()
    };

    RoutingDecision {
        project_id: None,
        method: "none".to_string(),
        matched_tags: Vec::new(),
        reason,
    }
}

fn project_a_tags(event: &RoutingEvent) -> impl Iterator<Item = &Vec<String>> {
    event.tags.iter().filter(|tag| {
        tag.first().is_some_and(|name| name == "a")
            && tag.get(1).is_some_and(|value| value.starts_with("31933:"))
    })
}

fn try_extract_d_tag_from_address(value: &str) -> Option<String> {
    let first_colon = value.find(':')?;
    let second_colon = value[first_colon + 1..].find(':')? + first_colon + 1;
    let kind = &value[..first_colon];
    let pubkey = &value[first_colon + 1..second_colon];
    let d_tag = &value[second_colon + 1..];

    if kind != "31933"
        || pubkey.len() != 64
        || !pubkey
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
        || d_tag.is_empty()
    {
        return None;
    }

    Some(d_tag.to_string())
}

fn first_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

impl<'a> RoutingContext<'a> {
    fn new(projects: &'a [ProjectFixture], active_project_ids: &'a [String]) -> Self {
        let known_projects = projects
            .iter()
            .map(|project| project.d_tag.as_str())
            .collect::<HashSet<_>>();
        let active_project_ids = active_project_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut agent_project_index: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut project_agents: HashMap<&str, HashSet<&str>> = HashMap::new();

        for project in projects {
            let agents = project
                .agents
                .iter()
                .map(|agent| agent.pubkey.as_str())
                .collect::<HashSet<_>>();
            project_agents.insert(project.d_tag.as_str(), agents);

            for agent in &project.agents {
                agent_project_index
                    .entry(agent.pubkey.as_str())
                    .or_default()
                    .push(project.d_tag.as_str());
            }
        }

        Self {
            known_projects,
            agent_project_index,
            project_agents,
            active_project_ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTING_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/routing-decisions.compat.json");

    #[test]
    fn routing_fixture_matches_rust_router() {
        let fixture: RoutingFixture =
            serde_json::from_str(ROUTING_FIXTURE).expect("fixture must parse");

        for test_case in &fixture.cases {
            assert_eq!(
                determine_target_project(
                    &test_case.event,
                    &fixture.projects,
                    &test_case.active_project_ids
                ),
                test_case.expected,
                "{}",
                test_case.name
            );
        }
    }
}

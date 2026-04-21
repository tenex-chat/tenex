use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionFilterFixture {
    pub name: String,
    pub description: String,
    pub since: u64,
    pub whitelisted_pubkeys: Vec<String>,
    pub known_project_addresses: Vec<String>,
    pub agent_pubkeys: Vec<String>,
    pub lesson_definition_id: String,
    pub filters: DaemonSubscriptionFilters,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSubscriptionFilters {
    #[serde(rename = "static")]
    pub static_filters: Vec<NostrFilter>,
    pub project_tagged: Option<NostrFilter>,
    pub agent_mentions: Option<NostrFilter>,
    pub lesson: NostrFilter,
    pub empty_static: Vec<NostrFilter>,
    pub empty_project_tagged: Option<NostrFilter>,
    pub empty_agent_mentions: Option<NostrFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NostrFilter {
    #[serde(default)]
    pub kinds: Vec<u64>,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(rename = "#a", default)]
    pub project_addresses: Vec<String>,
    #[serde(rename = "#p", default)]
    pub pubkeys: Vec<String>,
    #[serde(rename = "#e", default)]
    pub event_ids: Vec<String>,
    #[serde(rename = "#K", default)]
    pub referenced_kinds: Vec<String>,
    pub limit: Option<u64>,
    pub since: Option<u64>,
}

pub fn build_static_filters(authors: &[String], since: Option<u64>) -> Vec<NostrFilter> {
    if authors.is_empty() {
        return Vec::new();
    }

    vec![
        NostrFilter {
            kinds: vec![31933],
            authors: authors.to_vec(),
            ..NostrFilter::default()
        },
        NostrFilter {
            kinds: vec![24001, 24020, 24030],
            authors: authors.to_vec(),
            since,
            ..NostrFilter::default()
        },
        NostrFilter {
            kinds: vec![1111],
            authors: authors.to_vec(),
            referenced_kinds: vec!["4129".to_string()],
            since,
            ..NostrFilter::default()
        },
    ]
}

pub fn build_project_tagged_filter(
    known_project_addresses: &[String],
    since: Option<u64>,
) -> Option<NostrFilter> {
    if known_project_addresses.is_empty() {
        return None;
    }

    Some(NostrFilter {
        project_addresses: known_project_addresses.to_vec(),
        limit: Some(0),
        since,
        ..NostrFilter::default()
    })
}

pub fn build_agent_mentions_filter(
    agent_pubkeys: &[String],
    since: Option<u64>,
) -> Option<NostrFilter> {
    if agent_pubkeys.is_empty() {
        return None;
    }

    Some(NostrFilter {
        pubkeys: agent_pubkeys.to_vec(),
        limit: Some(0),
        since,
        ..NostrFilter::default()
    })
}

pub fn build_lesson_filter(definition_id: &str) -> NostrFilter {
    NostrFilter {
        kinds: vec![4129],
        event_ids: vec![definition_id.to_string()],
        ..NostrFilter::default()
    }
}

impl Default for NostrFilter {
    fn default() -> Self {
        Self {
            kinds: Vec::new(),
            authors: Vec::new(),
            project_addresses: Vec::new(),
            pubkeys: Vec::new(),
            event_ids: Vec::new(),
            referenced_kinds: Vec::new(),
            limit: None,
            since: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBSCRIPTION_FILTER_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/subscription-filters.compat.json");

    #[test]
    fn subscription_filter_fixture_matches_rust_builder() {
        let fixture: SubscriptionFilterFixture =
            serde_json::from_str(SUBSCRIPTION_FILTER_FIXTURE).expect("fixture must parse");

        assert_eq!(
            build_static_filters(&fixture.whitelisted_pubkeys, Some(fixture.since)),
            fixture.filters.static_filters
        );
        assert_eq!(
            build_project_tagged_filter(&fixture.known_project_addresses, Some(fixture.since)),
            fixture.filters.project_tagged
        );
        assert_eq!(
            build_agent_mentions_filter(&fixture.agent_pubkeys, Some(fixture.since)),
            fixture.filters.agent_mentions
        );
        assert_eq!(
            build_lesson_filter(&fixture.lesson_definition_id),
            fixture.filters.lesson
        );
        assert_eq!(
            build_static_filters(&[], Some(fixture.since)),
            fixture.filters.empty_static
        );
        assert_eq!(
            build_project_tagged_filter(&[], Some(fixture.since)),
            fixture.filters.empty_project_tagged
        );
        assert_eq!(
            build_agent_mentions_filter(&[], Some(fixture.since)),
            fixture.filters.empty_agent_mentions
        );
    }
}

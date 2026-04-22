use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::nostr_event::{NostrEventError, SignedNostrEvent, verify_signed_event};

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

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct NostrFilter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(rename = "#a", default, skip_serializing_if = "Vec::is_empty")]
    pub project_addresses: Vec<String>,
    #[serde(rename = "#p", default, skip_serializing_if = "Vec::is_empty")]
    pub pubkeys: Vec<String>,
    #[serde(rename = "#e", default, skip_serializing_if = "Vec::is_empty")]
    pub event_ids: Vec<String>,
    #[serde(rename = "#K", default, skip_serializing_if = "Vec::is_empty")]
    pub referenced_kinds: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaySubscriptionFrame {
    Event {
        subscription_id: String,
        event: SignedNostrEvent,
    },
    Eose {
        subscription_id: String,
    },
    Notice {
        message: String,
    },
    Closed {
        subscription_id: String,
        message: String,
    },
    Auth {
        challenge: String,
    },
}

#[derive(Debug, Error)]
pub enum SubscriptionMessageError {
    #[error("subscription message json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("subscription message frame is invalid: {0}")]
    InvalidFrame(String),
    #[error("subscription event failed NIP-01 verification: {0}")]
    Nostr(#[from] NostrEventError),
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
            kinds: vec![24000, 24001, 24020, 24030],
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

pub fn build_req_message(
    subscription_id: &str,
    filters: &[NostrFilter],
) -> Result<String, serde_json::Error> {
    let mut frame = Vec::with_capacity(filters.len() + 2);
    frame.push(Value::String("REQ".to_string()));
    frame.push(Value::String(subscription_id.to_string()));
    for filter in filters {
        frame.push(serde_json::to_value(filter)?);
    }
    serde_json::to_string(&frame)
}

pub fn build_close_message(subscription_id: &str) -> Result<String, serde_json::Error> {
    serde_json::to_string(&serde_json::json!(["CLOSE", subscription_id]))
}

pub fn parse_relay_subscription_message(
    message: &str,
) -> Result<RelaySubscriptionFrame, SubscriptionMessageError> {
    let value: Value = serde_json::from_str(message)?;
    let frame = value
        .as_array()
        .ok_or_else(|| invalid_frame("message must be a JSON array"))?;
    let frame_type = frame
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_frame("missing frame type"))?;

    match frame_type {
        "EVENT" => parse_event_frame(frame),
        "EOSE" => Ok(RelaySubscriptionFrame::Eose {
            subscription_id: required_string(frame, 1, "EOSE subscription id")?,
        }),
        "NOTICE" => Ok(RelaySubscriptionFrame::Notice {
            message: required_string(frame, 1, "NOTICE message")?,
        }),
        "CLOSED" => Ok(RelaySubscriptionFrame::Closed {
            subscription_id: required_string(frame, 1, "CLOSED subscription id")?,
            message: optional_string(frame, 2).unwrap_or_default(),
        }),
        "AUTH" => Ok(RelaySubscriptionFrame::Auth {
            challenge: required_string(frame, 1, "AUTH challenge")?,
        }),
        other => Err(invalid_frame(format!("unsupported frame type: {other}"))),
    }
}

fn parse_event_frame(frame: &[Value]) -> Result<RelaySubscriptionFrame, SubscriptionMessageError> {
    let subscription_id = required_string(frame, 1, "EVENT subscription id")?;
    let event_value = frame
        .get(2)
        .ok_or_else(|| invalid_frame("missing EVENT payload"))?
        .clone();
    let event: SignedNostrEvent = serde_json::from_value(event_value)?;
    verify_signed_event(&event)?;
    Ok(RelaySubscriptionFrame::Event {
        subscription_id,
        event,
    })
}

fn required_string(
    frame: &[Value],
    index: usize,
    field: &'static str,
) -> Result<String, SubscriptionMessageError> {
    frame
        .get(index)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_frame(format!("missing {field}")))
}

fn optional_string(frame: &[Value], index: usize) -> Option<String> {
    frame.get(index).and_then(Value::as_str).map(str::to_string)
}

fn invalid_frame(message: impl Into<String>) -> SubscriptionMessageError {
    SubscriptionMessageError::InvalidFrame(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::Nip01EventFixture;
    use serde_json::json;

    const SUBSCRIPTION_FILTER_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/subscription-filters.compat.json");
    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

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

    #[test]
    fn req_and_close_messages_use_nip01_wire_shape() {
        let filters = vec![
            NostrFilter {
                kinds: vec![31933],
                authors: vec!["owner".to_string()],
                since: Some(1_710_001_000),
                ..NostrFilter::default()
            },
            NostrFilter {
                pubkeys: vec!["agent".to_string()],
                limit: Some(0),
                ..NostrFilter::default()
            },
        ];

        let req = build_req_message("tenex-main", &filters).expect("REQ must serialize");
        let value: Value = serde_json::from_str(&req).expect("REQ must parse");
        assert_eq!(
            value,
            json!([
                "REQ",
                "tenex-main",
                {
                    "kinds": [31933],
                    "authors": ["owner"],
                    "since": 1_710_001_000
                },
                {
                    "#p": ["agent"],
                    "limit": 0
                }
            ])
        );
        assert_eq!(
            build_close_message("tenex-main").expect("CLOSE must serialize"),
            r#"["CLOSE","tenex-main"]"#
        );
    }

    #[test]
    fn parses_and_verifies_event_frames() {
        let fixture: Nip01EventFixture =
            serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse");
        let message = serde_json::to_string(&json!(["EVENT", "tenex-main", fixture.signed]))
            .expect("EVENT message must serialize");

        let frame =
            parse_relay_subscription_message(&message).expect("EVENT frame must verify and parse");

        assert_eq!(
            frame,
            RelaySubscriptionFrame::Event {
                subscription_id: "tenex-main".to_string(),
                event: fixture.signed,
            }
        );
    }

    #[test]
    fn rejects_event_frames_with_invalid_signatures() {
        let fixture: Nip01EventFixture =
            serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse");
        let mut event = fixture.signed;
        event.content.push_str(" tampered");
        let message =
            serde_json::to_string(&json!(["EVENT", "tenex-main", event])).expect("serialize");

        let error = parse_relay_subscription_message(&message)
            .expect_err("tampered EVENT frame must fail verification");

        assert!(matches!(error, SubscriptionMessageError::Nostr(_)));
    }

    #[test]
    fn parses_terminal_and_control_frames() {
        assert_eq!(
            parse_relay_subscription_message(r#"["EOSE","tenex-main"]"#).expect("EOSE"),
            RelaySubscriptionFrame::Eose {
                subscription_id: "tenex-main".to_string(),
            }
        );
        assert_eq!(
            parse_relay_subscription_message(r#"["NOTICE","relay maintenance"]"#).expect("NOTICE"),
            RelaySubscriptionFrame::Notice {
                message: "relay maintenance".to_string(),
            }
        );
        assert_eq!(
            parse_relay_subscription_message(r#"["CLOSED","tenex-main","auth-required"]"#)
                .expect("CLOSED"),
            RelaySubscriptionFrame::Closed {
                subscription_id: "tenex-main".to_string(),
                message: "auth-required".to_string(),
            }
        );
        assert_eq!(
            parse_relay_subscription_message(r#"["AUTH","challenge"]"#).expect("AUTH"),
            RelaySubscriptionFrame::Auth {
                challenge: "challenge".to_string(),
            }
        );
    }
}

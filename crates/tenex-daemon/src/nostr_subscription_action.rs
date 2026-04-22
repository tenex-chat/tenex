use serde::Serialize;

use crate::subscription_filters::{
    RelaySubscriptionFrame, SubscriptionMessageError, parse_relay_subscription_message,
};

#[derive(Debug, Clone, Copy)]
pub struct NostrSubscriptionIntakeActionInput<'a> {
    pub planned_subscription_id: &'a str,
    pub raw_message: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NostrSubscriptionIntakeAction {
    ProcessFrame {
        frame: RelaySubscriptionFrame,
    },
    Ignore {
        reason: NostrSubscriptionIntakeIgnoredReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionIntakeIgnoredReason {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    pub detail: String,
}

pub fn plan_nostr_subscription_intake_action(
    input: NostrSubscriptionIntakeActionInput<'_>,
) -> NostrSubscriptionIntakeAction {
    let frame = match parse_relay_subscription_message(input.raw_message) {
        Ok(frame) => frame,
        Err(error) => {
            return NostrSubscriptionIntakeAction::Ignore {
                reason: parse_error_ignored_reason(&error),
            };
        }
    };

    if let Some(subscription_id) = frame_subscription_id(&frame)
        && subscription_id != input.planned_subscription_id
    {
        return NostrSubscriptionIntakeAction::Ignore {
            reason: subscription_mismatch_ignored_reason(
                subscription_id,
                input.planned_subscription_id,
            ),
        };
    }

    NostrSubscriptionIntakeAction::ProcessFrame { frame }
}

fn frame_subscription_id(frame: &RelaySubscriptionFrame) -> Option<&str> {
    match frame {
        RelaySubscriptionFrame::Event {
            subscription_id, ..
        }
        | RelaySubscriptionFrame::Eose { subscription_id }
        | RelaySubscriptionFrame::Closed {
            subscription_id, ..
        } => Some(subscription_id),
        RelaySubscriptionFrame::Notice { .. } | RelaySubscriptionFrame::Auth { .. } => None,
    }
}

fn parse_error_ignored_reason(
    error: &SubscriptionMessageError,
) -> NostrSubscriptionIntakeIgnoredReason {
    NostrSubscriptionIntakeIgnoredReason {
        code: parse_error_code(error).to_string(),
        subscription_id: None,
        detail: error.to_string(),
    }
}

fn parse_error_code(error: &SubscriptionMessageError) -> &'static str {
    match error {
        SubscriptionMessageError::Json(_) => "invalid_json",
        SubscriptionMessageError::InvalidFrame(_) => "invalid_frame",
        SubscriptionMessageError::Nostr(_) => "invalid_event",
    }
}

fn subscription_mismatch_ignored_reason(
    subscription_id: &str,
    planned_subscription_id: &str,
) -> NostrSubscriptionIntakeIgnoredReason {
    NostrSubscriptionIntakeIgnoredReason {
        code: "subscription_mismatch".to_string(),
        subscription_id: Some(subscription_id.to_string()),
        detail: format!(
            "relay frame subscription id {subscription_id:?} does not match planned subscription id {planned_subscription_id:?}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::Nip01EventFixture;
    use serde_json::json;

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

    #[test]
    fn matching_event_frame_is_processed_after_signature_verification() {
        let fixture: Nip01EventFixture =
            serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse");
        let message = serde_json::to_string(&json!(["EVENT", "tenex-main", fixture.signed]))
            .expect("EVENT message must serialize");

        let action = plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
            planned_subscription_id: "tenex-main",
            raw_message: &message,
        });

        assert_eq!(
            action,
            NostrSubscriptionIntakeAction::ProcessFrame {
                frame: RelaySubscriptionFrame::Event {
                    subscription_id: "tenex-main".to_string(),
                    event: fixture.signed,
                },
            }
        );
    }

    #[test]
    fn lifecycle_and_connection_frames_are_normalized_to_processable_frames() {
        let cases = [
            (
                r#"["EOSE","tenex-main"]"#,
                RelaySubscriptionFrame::Eose {
                    subscription_id: "tenex-main".to_string(),
                },
            ),
            (
                r#"["NOTICE","relay maintenance"]"#,
                RelaySubscriptionFrame::Notice {
                    message: "relay maintenance".to_string(),
                },
            ),
            (
                r#"["CLOSED","tenex-main","auth-required"]"#,
                RelaySubscriptionFrame::Closed {
                    subscription_id: "tenex-main".to_string(),
                    message: "auth-required".to_string(),
                },
            ),
            (
                r#"["AUTH","challenge"]"#,
                RelaySubscriptionFrame::Auth {
                    challenge: "challenge".to_string(),
                },
            ),
        ];

        for (raw_message, frame) in cases {
            assert_eq!(
                plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
                    planned_subscription_id: "tenex-main",
                    raw_message,
                }),
                NostrSubscriptionIntakeAction::ProcessFrame { frame }
            );
        }
    }

    #[test]
    fn mismatched_subscription_frame_is_ignored_before_ingress() {
        let action = plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
            planned_subscription_id: "tenex-main",
            raw_message: r#"["EOSE","other-subscription"]"#,
        });

        assert_eq!(
            action,
            NostrSubscriptionIntakeAction::Ignore {
                reason: NostrSubscriptionIntakeIgnoredReason {
                    code: "subscription_mismatch".to_string(),
                    subscription_id: Some("other-subscription".to_string()),
                    detail:
                        "relay frame subscription id \"other-subscription\" does not match planned subscription id \"tenex-main\""
                            .to_string(),
                },
            }
        );
    }

    #[test]
    fn parse_failures_use_stable_intake_reason_codes() {
        let invalid_json =
            plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
                planned_subscription_id: "tenex-main",
                raw_message: "not-json",
            });
        assert_ignored_code(invalid_json, "invalid_json");

        let invalid_frame =
            plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
                planned_subscription_id: "tenex-main",
                raw_message: r#"["EVENT","tenex-main"]"#,
            });
        assert_ignored_code(invalid_frame, "invalid_frame");

        let fixture: Nip01EventFixture =
            serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse");
        let mut event = fixture.signed;
        event.content.push_str(" tampered");
        let invalid_event_message = serde_json::to_string(&json!(["EVENT", "tenex-main", event]))
            .expect("EVENT message must serialize");
        let invalid_event =
            plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
                planned_subscription_id: "tenex-main",
                raw_message: &invalid_event_message,
            });
        assert_ignored_code(invalid_event, "invalid_event");
    }

    fn assert_ignored_code(action: NostrSubscriptionIntakeAction, expected_code: &str) {
        let NostrSubscriptionIntakeAction::Ignore { reason } = action else {
            panic!("expected ignored action");
        };
        assert_eq!(reason.code, expected_code);
        assert_eq!(reason.subscription_id, None);
        assert!(!reason.detail.is_empty());
    }
}

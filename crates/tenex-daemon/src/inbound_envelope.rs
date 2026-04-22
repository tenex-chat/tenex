//! Rust mirror of `src/events/runtime/InboundEnvelope.ts`.
//!
//! The Rust daemon carries triggering envelopes across the worker protocol
//! and (in later slices) derives transport-native delivery records from
//! them. The wire shape must round-trip byte-identically with the TS
//! definition so the worker can deserialize the execute frame's
//! `triggeringEnvelope` the exact same way it does today.
//!
//! All field names are camelCase via `#[serde(rename_all = "camelCase")]`
//! so the JSON produced here matches what TypeScript emits/consumes.
//!
//! Only the fields TypeScript actually uses are modelled. New fields added
//! upstream must be mirrored here in lockstep.

use serde::{Deserialize, Serialize};

/// The transport a principal, channel, or message belongs to. Matches the
/// `RuntimeTransport` union in `InboundEnvelope.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeTransport {
    Local,
    Mcp,
    Nostr,
    Telegram,
}

/// Kind a principal plays in the envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    Agent,
    Human,
    System,
}

/// Kind of channel. Matches the TS `"conversation" | "dm" | "group" |
/// "project" | "topic"` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Conversation,
    Dm,
    Group,
    Project,
    Topic,
}

/// Telegram chat type, mirroring the Bot API's `Chat.type` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TelegramChatType {
    Private,
    Group,
    Supergroup,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChatAdministratorMetadata {
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSeenParticipantMetadata {
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramTransportMetadata {
    pub update_id: i64,
    pub chat_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub chat_type: TelegramChatType,
    pub is_edited_message: bool,
    pub sender_user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub administrators: Option<Vec<TelegramChatAdministratorMetadata>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_participants: Option<Vec<TelegramSeenParticipantMetadata>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalRef {
    pub id: String,
    pub transport: RuntimeTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_pubkey: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PrincipalKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRef {
    pub id: String,
    pub transport: RuntimeTransport,
    pub kind: ChannelKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_binding: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMessageRef {
    pub id: String,
    pub transport: RuntimeTransport,
    pub native_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransportMetadataBag {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram: Option<TelegramTransportMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboundMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_kind: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_tag_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub article_references: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_parent_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_event_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_kill_signal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kill_signal_delegation_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<TransportMetadataBag>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundEnvelope {
    pub transport: RuntimeTransport,
    pub principal: PrincipalRef,
    pub channel: ChannelRef,
    pub message: ExternalMessageRef,
    pub recipients: Vec<PrincipalRef>,
    pub content: String,
    pub occurred_at: i64,
    pub capabilities: Vec<String>,
    pub metadata: InboundMetadata,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn telegram_envelope_round_trips_against_ts_shape() {
        // This is a golden sample that matches what
        // `TelegramInboundAdapter.toEnvelope` produces for a supergroup
        // topic message with administrators, seen participants, and a reply
        // reference. Any drift between TS and Rust will fail this test.
        let golden = json!({
            "transport": "telegram",
            "principal": {
                "id": "telegram:user:12345",
                "transport": "telegram",
                "displayName": "Ada Lovelace",
                "username": "ada_admin",
                "kind": "human"
            },
            "channel": {
                "id": "telegram:group:-1002:topic:7",
                "transport": "telegram",
                "kind": "topic",
                "projectBinding": "project-alpha"
            },
            "message": {
                "id": "telegram:tg_n1002_88",
                "transport": "telegram",
                "nativeId": "tg_n1002_88",
                "replyToId": "telegram:tg_n1002_80"
            },
            "recipients": [{
                "id": "nostr:abc123",
                "transport": "nostr",
                "linkedPubkey": "abc123",
                "displayName": "Agent Smith",
                "kind": "agent"
            }],
            "content": "hello world",
            "occurredAt": 1_700_000_000,
            "capabilities": ["telegram-bot", "telegram-group"],
            "metadata": {
                "eventKind": 1,
                "eventTagCount": 3,
                "transport": {
                    "telegram": {
                        "updateId": 42,
                        "chatId": "-1002",
                        "messageId": "88",
                        "threadId": "7",
                        "chatType": "supergroup",
                        "isEditedMessage": false,
                        "senderUserId": "12345",
                        "chatTitle": "Operators",
                        "topicTitle": "Ops Topic",
                        "chatUsername": "ops_chat",
                        "memberCount": 14,
                        "administrators": [{
                            "userId": "7",
                            "displayName": "Ada",
                            "username": "ada_admin",
                            "customTitle": "Owner"
                        }],
                        "seenParticipants": [{
                            "userId": "12345",
                            "displayName": "Ada Lovelace",
                            "username": "ada_admin",
                            "lastSeenAt": 1_700_000_000_000_u64
                        }],
                        "botId": "999",
                        "botUsername": "tenex_bot"
                    }
                }
            }
        });

        let envelope: InboundEnvelope =
            serde_json::from_value(golden.clone()).expect("parses golden");
        assert_eq!(envelope.transport, RuntimeTransport::Telegram);
        assert_eq!(envelope.principal.id, "telegram:user:12345");
        assert_eq!(envelope.channel.kind, ChannelKind::Topic);
        assert_eq!(envelope.message.native_id, "tg_n1002_88");
        let telegram = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|t| t.telegram.as_ref())
            .expect("telegram metadata present");
        assert_eq!(telegram.update_id, 42);
        assert_eq!(telegram.chat_type, TelegramChatType::Supergroup);
        assert_eq!(telegram.administrators.as_ref().map(|a| a.len()), Some(1));

        let re_serialized = serde_json::to_value(&envelope).expect("serializes back to JSON");
        assert_eq!(re_serialized, golden, "round trip must be byte-identical");
    }

    #[test]
    fn dm_envelope_skips_null_optional_fields() {
        let envelope = InboundEnvelope {
            transport: RuntimeTransport::Telegram,
            principal: PrincipalRef {
                id: "telegram:user:99".to_string(),
                transport: RuntimeTransport::Telegram,
                linked_pubkey: None,
                display_name: Some("Solo".to_string()),
                username: None,
                kind: Some(PrincipalKind::Human),
            },
            channel: ChannelRef {
                id: "telegram:chat:99".to_string(),
                transport: RuntimeTransport::Telegram,
                kind: ChannelKind::Dm,
                project_binding: None,
            },
            message: ExternalMessageRef {
                id: "telegram:tg_99_1".to_string(),
                transport: RuntimeTransport::Telegram,
                native_id: "tg_99_1".to_string(),
                reply_to_id: None,
            },
            recipients: Vec::new(),
            content: "hi".to_string(),
            occurred_at: 1,
            capabilities: vec!["telegram-bot".to_string(), "telegram-dm".to_string()],
            metadata: InboundMetadata::default(),
        };
        let value: Value = serde_json::to_value(&envelope).unwrap();
        // The optional fields that serialize-skip when None must not be
        // present in the emitted JSON; TS treats an explicit `null` vs
        // missing property as the same thing, but matching the TS runtime
        // (which omits `undefined` properties) keeps the fixtures diff-free.
        assert!(
            value
                .get("principal")
                .unwrap()
                .get("linkedPubkey")
                .is_none()
        );
        assert!(
            value
                .get("channel")
                .unwrap()
                .get("projectBinding")
                .is_none()
        );
        assert!(value.get("message").unwrap().get("replyToId").is_none());
        // Round trip still works.
        let parsed: InboundEnvelope = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, envelope);
    }

    #[test]
    fn unknown_transport_rejected() {
        let value = json!({
            "transport": "irc",
            "principal": { "id": "irc:u", "transport": "irc" },
            "channel": { "id": "irc:c", "transport": "irc", "kind": "group" },
            "message": { "id": "irc:m", "transport": "irc", "nativeId": "m1" },
            "recipients": [],
            "content": "",
            "occurredAt": 0,
            "capabilities": [],
            "metadata": {}
        });
        let result: Result<InboundEnvelope, _> = serde_json::from_value(value);
        assert!(
            result.is_err(),
            "unknown transport must fail to deserialize"
        );
    }
}

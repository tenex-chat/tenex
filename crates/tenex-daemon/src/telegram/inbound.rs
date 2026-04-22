//! Normalize a raw Telegram Bot API update into an [`InboundEnvelope`].
//!
//! Behavior oracle: `src/services/telegram/TelegramInboundAdapter.ts` plus the
//! filter gate in `TelegramGatewayService.processUpdate` (bot-authored
//! messages, unsupported chat types, unprocessable messages) and the
//! transport-metadata enrichment in
//! `src/telemetry/TelegramTelemetry.ts::buildTelegramTransportMetadata`.
//!
//! The normalizer is a pure function. All side effects (downloading media,
//! looking up identity bindings, refreshing chat context) stay out of this
//! module: callers thread in everything the TS adapter relied on as
//! parameters via [`InboundNormalizationInput`]. The only runtime dependency
//! is [`serde_json`] for reading the already-parsed [`Update`] shape.
//!
//! Shape parity with TypeScript: the returned [`InboundEnvelope`] serializes
//! to the exact JSON the TS runtime emits. The round-trip golden test lives
//! in `crate::inbound_envelope::tests::telegram_envelope_round_trips_against_ts_shape`.
//!
//! Return semantics:
//!
//! - `None` when the update is not routable. Matches the TS gateway filters:
//!   missing `message`/`edited_message`, missing sender, bot-authored
//!   messages, `channel` chat type, and messages with neither text nor
//!   caption (media-only messages are routable in TS only after media
//!   download produces synthesized text; Rust leaves that to the gateway
//!   slice and drops media-only messages here).
//! - `Some(envelope)` otherwise. The caller is responsible for the recipient
//!   list (agent pubkey) and the project binding.

use serde_json::Value;

use crate::inbound_envelope::{
    ChannelKind, ChannelRef, ExternalMessageRef, InboundEnvelope, InboundMetadata, PrincipalKind,
    PrincipalRef, RuntimeTransport, TelegramChatType, TelegramTransportMetadata,
    TransportMetadataBag,
};
use crate::telegram::chat_context::ChatContextSnapshot;

/// `NDKKind.Text` in the TS codebase. Duplicated here to avoid coupling the
/// inbound normalizer to a kinds module.
const NDK_KIND_TEXT: i64 = 1;

/// A recipient to include in the envelope's `recipients` array. One entry
/// per agent registration that the incoming message is being routed to.
/// Mirrors the TS adapter's `toRecipient(agent.pubkey, agent.name)` helper.
#[derive(Debug, Clone)]
pub struct InboundRecipient<'a> {
    pub agent_pubkey: &'a str,
    pub agent_name: &'a str,
}

/// Optional media attachment enrichment. Mirrors the TS adapter's
/// `mediaInfo` parameter, which is produced by a prior media download step.
///
/// The `local_path` must already be an absolute path on disk; the normalizer
/// does not touch the filesystem. The TS adapter formats the text with the
/// attachment marker inline (e.g. `"caption\n[voice message: /path, duration: 3s]"`).
#[derive(Debug, Clone)]
pub struct InboundMediaInfo<'a> {
    pub local_path: &'a str,
    pub media_type: InboundMediaType,
    pub duration_seconds: Option<u64>,
    pub file_name: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundMediaType {
    Voice,
    Audio,
    Document,
    Video,
    Photo,
}

impl InboundMediaType {
    fn marker_prefix(self) -> &'static str {
        match self {
            InboundMediaType::Voice => "voice message",
            InboundMediaType::Audio => "audio",
            InboundMediaType::Document => "document",
            InboundMediaType::Video => "video",
            InboundMediaType::Photo => "photo",
        }
    }
}

/// Input to [`normalize_telegram_update`]. Every field the TS adapter and
/// gateway consult to build an envelope is an explicit parameter here; there
/// is no hidden ambient state.
#[derive(Debug, Clone)]
pub struct InboundNormalizationInput<'a> {
    /// The raw Bot API update, exactly as [`crate::telegram::client::Update`]
    /// surfaced it. The normalizer reads `message`, `edited_message`,
    /// `callback_query`, and `update_id` off this value.
    pub update: &'a Value,

    /// The bot's own Telegram user id (`getMe().id`). Used to drop the bot's
    /// own echoed messages.
    pub bot_id: u64,
    /// The bot's username. Surfaced into `TelegramTransportMetadata.botUsername`.
    pub bot_username: Option<&'a str>,

    /// Durable chat-context snapshot for the chat this update targets. The
    /// normalizer reads administrators / member count / seen participants /
    /// topic titles from here; it never mutates. A snapshot refresh must
    /// happen before this call (see `chat_context::refresh_chat_context`).
    pub chat_context_snapshot: Option<&'a ChatContextSnapshot>,

    /// `linked_pubkey` for the sender's principal, as stored by the identity
    /// binding layer. The TS adapter reads this from `IdentityBindingStore`.
    pub sender_linked_pubkey: Option<&'a str>,

    /// Optional media attachment descriptor (populated by the gateway's
    /// media-download step).
    pub media_info: Option<&'a InboundMediaInfo<'a>>,

    /// `replyToId` hint: the previous message the current chat session is
    /// replying to. The TS adapter takes this as
    /// `replyToNativeMessageId: session?.lastMessageId`. When `None`, and the
    /// update carries its own `reply_to_message.message_id`, that native id is
    /// used instead, matching the fallback TS derivation.
    pub session_reply_to_native_id: Option<&'a str>,

    /// Agent recipients. Usually one entry (the registration's agent); the
    /// TS gateway emits exactly one.
    pub recipients: &'a [InboundRecipient<'a>],

    /// The project this chat is bound to. Goes into
    /// `ChannelRef.projectBinding`. `None` means "unbound chat"; the TS
    /// gateway won't reach the adapter without a binding, but the shape
    /// allows for it (the binding field itself is optional on the envelope).
    pub project_binding: Option<&'a str>,
}

/// Convert a Telegram update into an [`InboundEnvelope`]. Returns `None`
/// when the update is not routable per the TS gateway's filter rules.
pub fn normalize_telegram_update(input: InboundNormalizationInput<'_>) -> Option<InboundEnvelope> {
    // 1. Resolve the message we'll work with. TS treats
    //    `callback_query.message` as routable only for config flows; the
    //    runtime inbound path drops callback queries at
    //    `configCommandService.getCallbackContext` and never calls
    //    `toEnvelope` for them. We mirror that here: callback queries return
    //    None.
    let update = input.update.as_object()?;
    if update.contains_key("callback_query") {
        return None;
    }

    let (raw_message, is_edited) =
        if let Some(value) = update.get("message").filter(|v| !v.is_null()) {
            (value, false)
        } else if let Some(value) = update.get("edited_message").filter(|v| !v.is_null()) {
            (value, true)
        } else {
            return None;
        };
    let message = raw_message.as_object()?;

    // 2. Sender. No `from` means the update is not routable.
    let from = message.get("from").and_then(Value::as_object)?;
    let sender_id = from.get("id").and_then(Value::as_i64)?;
    let sender_is_bot = from.get("is_bot").and_then(Value::as_bool).unwrap_or(false);

    // Drop the bot's own echoed messages. Matches
    // `TelegramGatewayService.processUpdate`'s `message.from.is_bot` guard:
    // any bot-authored message is a non-routable echo, including messages
    // authored by a different bot which the TS gateway also drops.
    if sender_is_bot {
        return None;
    }
    // Defense in depth: also drop our own bot id even if `is_bot=false`
    // somehow slipped through (should not happen in practice).
    if sender_id as u64 == input.bot_id {
        return None;
    }

    // 3. Chat.
    let chat = message.get("chat").and_then(Value::as_object)?;
    let chat_id = chat.get("id").and_then(Value::as_i64)?;
    let chat_type_raw = chat.get("type").and_then(Value::as_str)?;
    let chat_type = match chat_type_raw {
        "private" => TelegramChatType::Private,
        "group" => TelegramChatType::Group,
        "supergroup" => TelegramChatType::Supergroup,
        // `channel` chats are explicitly filtered by
        // `isSupportedTelegramChatType` in the TS oracle.
        _ => return None,
    };

    // 4. Thread / topic id. Optional, used for forum-topic messages.
    let message_thread_id = message.get("message_thread_id").and_then(Value::as_i64);

    // 5. Content. Matches `TelegramInboundAdapter.toEnvelope`:
    //    text?.trim() || caption?.trim() || "", optionally augmented with a
    //    media marker. Empty content + no media is unprocessable.
    let text_content = message
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
        .or_else(|| {
            message
                .get("caption")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|trimmed| !trimmed.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default();

    let content = build_content_with_media(&text_content, input.media_info);
    if content.is_empty() {
        return None;
    }

    // 6. Message id + native id.
    let message_id = message.get("message_id").and_then(Value::as_i64)?;
    let native_id = create_telegram_native_message_id(chat_id, message_id);
    let envelope_message_id = format!("telegram:{native_id}");

    // 7. Reply-to resolution. Session hint takes precedence (matches the TS
    //    gateway, which passes `session?.lastMessageId` explicitly). Falling
    //    back to the update's own `reply_to_message.message_id` captures the
    //    native-Telegram reply context the adapter doesn't otherwise have.
    let reply_to_id = if let Some(session) = input.session_reply_to_native_id {
        Some(format!("telegram:{session}"))
    } else {
        message
            .get("reply_to_message")
            .and_then(Value::as_object)
            .and_then(|reply| reply.get("message_id").and_then(Value::as_i64))
            .map(|reply_id| {
                let native = create_telegram_native_message_id(chat_id, reply_id);
                format!("telegram:{native}")
            })
    };

    // 8. Channel id + kind.
    let chat_id_str = chat_id.to_string();
    let channel_id = create_telegram_channel_id(&chat_id_str, message_thread_id);
    let channel_kind = match chat_type {
        TelegramChatType::Private => ChannelKind::Dm,
        _ => {
            if message_thread_id.is_some() {
                ChannelKind::Topic
            } else {
                ChannelKind::Group
            }
        }
    };

    // 9. Principal.
    let display_name = telegram_display_name(from);
    let username = from
        .get("username")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let principal = PrincipalRef {
        id: format!("telegram:user:{sender_id}"),
        transport: RuntimeTransport::Telegram,
        linked_pubkey: input.sender_linked_pubkey.map(str::to_string),
        display_name,
        username,
        kind: Some(PrincipalKind::Human),
    };

    // 10. Recipients.
    let recipients = input
        .recipients
        .iter()
        .map(|entry| PrincipalRef {
            id: format!("nostr:{}", entry.agent_pubkey),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: Some(entry.agent_pubkey.to_string()),
            display_name: Some(entry.agent_name.to_string()),
            username: None,
            kind: Some(PrincipalKind::Agent),
        })
        .collect::<Vec<_>>();

    // 11. Capabilities.
    let capabilities = vec![
        "telegram-bot".to_string(),
        match chat_type {
            TelegramChatType::Private => "telegram-dm".to_string(),
            _ => "telegram-group".to_string(),
        },
    ];

    // 12. Date.
    let occurred_at = message.get("date").and_then(Value::as_i64).unwrap_or(0);

    // 13. Equivalent tag count, matching the TS adapter.
    let equivalent_tag_count =
        1 + if input.project_binding.is_some() {
            1
        } else {
            0
        } + if reply_to_id.is_some() { 1 } else { 0 };

    // 14. Transport metadata.
    let update_id = update.get("update_id").and_then(Value::as_i64).unwrap_or(0);
    let transport_metadata = build_transport_metadata(BuildTransportMetadataInput {
        update_id,
        chat_id_str: &chat_id_str,
        message_id,
        thread_id: message_thread_id,
        chat_type,
        is_edited,
        sender_user_id: sender_id,
        chat_title_from_message: chat.get("title").and_then(Value::as_str),
        chat_username_from_message: chat.get("username").and_then(Value::as_str),
        bot_id: input.bot_id,
        bot_username: input.bot_username,
        snapshot: input.chat_context_snapshot,
    });

    let metadata = InboundMetadata {
        event_kind: Some(NDK_KIND_TEXT),
        event_tag_count: Some(equivalent_tag_count),
        transport: Some(TransportMetadataBag {
            telegram: Some(transport_metadata),
        }),
        ..InboundMetadata::default()
    };

    Some(InboundEnvelope {
        transport: RuntimeTransport::Telegram,
        principal,
        channel: ChannelRef {
            id: channel_id,
            transport: RuntimeTransport::Telegram,
            kind: channel_kind,
            project_binding: input.project_binding.map(str::to_string),
        },
        message: ExternalMessageRef {
            id: envelope_message_id,
            transport: RuntimeTransport::Telegram,
            native_id,
            reply_to_id,
        },
        recipients,
        content,
        occurred_at,
        capabilities,
        metadata,
    })
}

/// Format a Telegram user's display name the same way the TS adapter does:
/// `first_name + " " + last_name` trimmed, falling back to `username`.
fn telegram_display_name(from: &serde_json::Map<String, Value>) -> Option<String> {
    let first = from.get("first_name").and_then(Value::as_str).unwrap_or("");
    let last = from.get("last_name").and_then(Value::as_str).unwrap_or("");
    let combined = [first, last]
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = combined.trim().to_string();
    if !trimmed.is_empty() {
        Some(trimmed)
    } else {
        from.get("username")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
}

/// Produce `tg_<chat>_<message>` with the same normalization as the TS
/// `createTelegramNativeMessageId`: replace a leading `-` with `n`, then
/// replace any non `[A-Za-z0-9_]` with `_`.
fn create_telegram_native_message_id(chat_id: i64, message_id: i64) -> String {
    let chat_segment = normalize_numeric_segment(&chat_id.to_string());
    let message_segment = normalize_numeric_segment(&message_id.to_string());
    format!("tg_{chat_segment}_{message_segment}")
}

/// Produce the channel id. Matches `createTelegramChannelId` in the TS
/// oracle: `telegram:chat:<id>` for non-topic chats,
/// `telegram:group:<id>:topic:<thread_id>` for forum topics.
fn create_telegram_channel_id(chat_id: &str, message_thread_id: Option<i64>) -> String {
    match message_thread_id {
        Some(thread_id) => format!("telegram:group:{chat_id}:topic:{thread_id}"),
        None => format!("telegram:chat:{chat_id}"),
    }
}

fn normalize_numeric_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for (index, ch) in value.chars().enumerate() {
        if index == 0 && ch == '-' {
            out.push('n');
            continue;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    out
}

fn build_content_with_media(text: &str, media: Option<&InboundMediaInfo<'_>>) -> String {
    let Some(media) = media else {
        return text.to_string();
    };
    let tag = match media.media_type {
        InboundMediaType::Voice | InboundMediaType::Audio | InboundMediaType::Video => {
            match media.duration_seconds {
                Some(duration) => format!(
                    "[{}: {}, duration: {}s]",
                    media.media_type.marker_prefix(),
                    media.local_path,
                    duration
                ),
                None => format!(
                    "[{}: {}]",
                    media.media_type.marker_prefix(),
                    media.local_path
                ),
            }
        }
        InboundMediaType::Document => match media.file_name {
            Some(name) => format!("[document: {name} — {}]", media.local_path),
            None => format!("[document: {}]", media.local_path),
        },
        InboundMediaType::Photo => format!("[photo: {}]", media.local_path),
    };
    if text.is_empty() {
        tag
    } else {
        format!("{text}\n{tag}")
    }
}

struct BuildTransportMetadataInput<'a> {
    update_id: i64,
    chat_id_str: &'a str,
    message_id: i64,
    thread_id: Option<i64>,
    chat_type: TelegramChatType,
    is_edited: bool,
    sender_user_id: i64,
    chat_title_from_message: Option<&'a str>,
    chat_username_from_message: Option<&'a str>,
    bot_id: u64,
    bot_username: Option<&'a str>,
    snapshot: Option<&'a ChatContextSnapshot>,
}

fn build_transport_metadata(input: BuildTransportMetadataInput<'_>) -> TelegramTransportMetadata {
    // Mirror `buildTelegramTransportMetadata`: snapshot fields override the
    // message-level fields if present (the TS helper takes a `context`
    // object and uses `context.chatTitle ?? message.chat.title?.trim()`).
    let chat_title = input
        .snapshot
        .and_then(|snapshot| snapshot.chat_title.clone())
        .or_else(|| trim_owned(input.chat_title_from_message));

    let chat_username = input
        .snapshot
        .and_then(|snapshot| snapshot.chat_username.clone())
        .or_else(|| trim_owned(input.chat_username_from_message));

    let topic_title = input.snapshot.and_then(|snapshot| {
        let thread_id = input.thread_id?;
        snapshot.topic_titles.get(&thread_id.to_string()).cloned()
    });

    let administrators = input.snapshot.and_then(|snapshot| {
        if snapshot.administrators.is_empty() {
            None
        } else {
            Some(snapshot.administrators.clone())
        }
    });

    let member_count = input.snapshot.and_then(|snapshot| snapshot.member_count);

    let seen_participants = input.snapshot.and_then(|snapshot| {
        if snapshot.seen_participants.is_empty() {
            None
        } else {
            Some(snapshot.seen_participants.clone())
        }
    });

    TelegramTransportMetadata {
        update_id: input.update_id,
        chat_id: input.chat_id_str.to_string(),
        message_id: input.message_id.to_string(),
        thread_id: input.thread_id.map(|id| id.to_string()),
        chat_type: input.chat_type,
        is_edited_message: input.is_edited,
        sender_user_id: input.sender_user_id.to_string(),
        chat_title,
        topic_title,
        chat_username,
        member_count,
        administrators,
        seen_participants,
        bot_id: Some(input.bot_id.to_string()),
        bot_username: input.bot_username.map(str::to_string),
    }
}

fn trim_owned(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbound_envelope::{
        TelegramChatAdministratorMetadata, TelegramSeenParticipantMetadata,
    };
    use crate::telegram::chat_context::{
        ChatContextSnapshot, TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION, TELEGRAM_CHAT_CONTEXT_WRITER,
    };
    use serde_json::json;

    fn default_recipients<'a>() -> Vec<InboundRecipient<'a>> {
        vec![InboundRecipient {
            agent_pubkey: "agent_pub",
            agent_name: "Agent Smith",
        }]
    }

    fn base_snapshot(chat_id: &str) -> ChatContextSnapshot {
        ChatContextSnapshot {
            schema_version: TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION,
            writer: TELEGRAM_CHAT_CONTEXT_WRITER.to_string(),
            writer_version: "0.0.0-test".to_string(),
            created_at: 1,
            updated_at: 1,
            chat_id: chat_id.to_string(),
            chat_type: None,
            chat_title: None,
            chat_username: None,
            member_count: None,
            administrators: Vec::new(),
            seen_participants: Vec::new(),
            topic_titles: std::collections::BTreeMap::new(),
            last_api_sync_at: None,
        }
    }

    #[test]
    fn private_text_message_builds_dm_envelope() {
        let update = json!({
            "update_id": 100,
            "message": {
                "message_id": 5,
                "date": 1_700_000_000,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice",
                    "last_name": "Smith",
                    "username": "alice"
                },
                "chat": { "id": 42, "type": "private" },
                "text": "hello"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 9999,
            bot_username: Some("tenex_bot"),
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: Some("proj-1"),
        })
        .expect("envelope built");

        assert_eq!(envelope.transport, RuntimeTransport::Telegram);
        assert_eq!(envelope.channel.kind, ChannelKind::Dm);
        assert_eq!(envelope.channel.id, "telegram:chat:42");
        assert_eq!(envelope.channel.project_binding.as_deref(), Some("proj-1"));
        assert_eq!(envelope.principal.id, "telegram:user:42");
        assert_eq!(envelope.principal.kind, Some(PrincipalKind::Human));
        assert_eq!(
            envelope.principal.display_name.as_deref(),
            Some("Alice Smith")
        );
        assert_eq!(envelope.principal.username.as_deref(), Some("alice"));
        assert_eq!(envelope.message.native_id, "tg_42_5");
        assert_eq!(envelope.message.id, "telegram:tg_42_5");
        assert!(envelope.message.reply_to_id.is_none());
        assert_eq!(envelope.content, "hello");
        assert_eq!(
            envelope.capabilities,
            vec!["telegram-bot".to_string(), "telegram-dm".to_string()]
        );
        assert_eq!(envelope.occurred_at, 1_700_000_000);
        assert_eq!(envelope.metadata.event_kind, Some(1));
        // tag count = 1 (base) + 1 (project binding) + 0 (no reply)
        assert_eq!(envelope.metadata.event_tag_count, Some(2));

        let transport = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|bag| bag.telegram.as_ref())
            .expect("transport metadata");
        assert_eq!(transport.update_id, 100);
        assert_eq!(transport.chat_id, "42");
        assert_eq!(transport.chat_type, TelegramChatType::Private);
        assert!(!transport.is_edited_message);
        assert_eq!(transport.sender_user_id, "42");
        assert_eq!(transport.bot_id.as_deref(), Some("9999"));
        assert_eq!(transport.bot_username.as_deref(), Some("tenex_bot"));
        assert!(transport.thread_id.is_none());
    }

    #[test]
    fn group_text_message_builds_group_envelope() {
        let update = json!({
            "update_id": 101,
            "message": {
                "message_id": 12,
                "date": 1_700_000_100,
                "from": {
                    "id": 7,
                    "is_bot": false,
                    "first_name": "Bob"
                },
                "chat": {
                    "id": -500,
                    "type": "group",
                    "title": "Ops"
                },
                "text": "group ping"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 9999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");

        assert_eq!(envelope.channel.kind, ChannelKind::Group);
        assert_eq!(envelope.channel.id, "telegram:chat:-500");
        assert!(envelope.channel.project_binding.is_none());
        assert_eq!(envelope.message.native_id, "tg_n500_12");
        assert_eq!(envelope.principal.display_name.as_deref(), Some("Bob"));

        let transport = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|bag| bag.telegram.as_ref())
            .expect("telegram metadata");
        assert_eq!(transport.chat_type, TelegramChatType::Group);
        assert_eq!(transport.chat_title.as_deref(), Some("Ops"));
        // Without snapshot, no topic title / administrators / member count.
        assert!(transport.topic_title.is_none());
        assert!(transport.administrators.is_none());
        assert!(transport.member_count.is_none());

        assert_eq!(envelope.capabilities[1], "telegram-group");
        // tag count = 1 base only (no project binding, no reply)
        assert_eq!(envelope.metadata.event_tag_count, Some(1));
    }

    #[test]
    fn supergroup_forum_topic_pulls_topic_title_from_snapshot() {
        let update = json!({
            "update_id": 88,
            "message": {
                "message_id": 321,
                "date": 1_700_000_200,
                "from": {
                    "id": 12345,
                    "is_bot": false,
                    "first_name": "Ada",
                    "username": "ada_admin"
                },
                "chat": {
                    "id": -1002,
                    "type": "supergroup",
                    "title": "Operators",
                    "username": "ops_chat"
                },
                "message_thread_id": 7,
                "text": "forum message"
            }
        });

        let mut snapshot = base_snapshot("-1002");
        snapshot
            .topic_titles
            .insert("7".to_string(), "Ops Topic".to_string());
        snapshot.member_count = Some(14);
        snapshot.administrators = vec![TelegramChatAdministratorMetadata {
            user_id: "7".to_string(),
            display_name: Some("Ada".to_string()),
            username: Some("ada_admin".to_string()),
            custom_title: Some("Owner".to_string()),
        }];
        snapshot.seen_participants = vec![TelegramSeenParticipantMetadata {
            user_id: "12345".to_string(),
            display_name: Some("Ada Lovelace".to_string()),
            username: Some("ada_admin".to_string()),
            last_seen_at: 1_700_000_000_000,
        }];

        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: Some("tenex_bot"),
            chat_context_snapshot: Some(&snapshot),
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: Some("project-alpha"),
        })
        .expect("envelope");

        assert_eq!(envelope.channel.kind, ChannelKind::Topic);
        assert_eq!(envelope.channel.id, "telegram:group:-1002:topic:7");
        let transport = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|bag| bag.telegram.as_ref())
            .expect("telegram metadata");
        assert_eq!(transport.thread_id.as_deref(), Some("7"));
        assert_eq!(transport.topic_title.as_deref(), Some("Ops Topic"));
        assert_eq!(transport.chat_title.as_deref(), Some("Operators"));
        assert_eq!(transport.chat_username.as_deref(), Some("ops_chat"));
        assert_eq!(transport.member_count, Some(14));
        assert_eq!(transport.administrators.as_ref().map(Vec::len), Some(1));
        assert_eq!(transport.chat_type, TelegramChatType::Supergroup);
    }

    #[test]
    fn edited_message_sets_is_edited_flag() {
        let update = json!({
            "update_id": 200,
            "edited_message": {
                "message_id": 77,
                "date": 1_700_000_300,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": 42, "type": "private" },
                "text": "edited content"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        let transport = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|bag| bag.telegram.as_ref())
            .expect("telegram metadata");
        assert!(transport.is_edited_message);
        assert_eq!(envelope.content, "edited content");
    }

    #[test]
    fn reply_to_message_populates_reply_to_id() {
        let update = json!({
            "update_id": 300,
            "message": {
                "message_id": 50,
                "date": 1_700_000_400,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": -600, "type": "group" },
                "reply_to_message": { "message_id": 49 },
                "text": "threaded reply"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: Some("proj"),
        })
        .expect("envelope");

        assert_eq!(
            envelope.message.reply_to_id.as_deref(),
            Some("telegram:tg_n600_49")
        );
        // tag count = 1 base + 1 project binding + 1 reply
        assert_eq!(envelope.metadata.event_tag_count, Some(3));
    }

    #[test]
    fn session_reply_hint_wins_over_message_reply() {
        let update = json!({
            "update_id": 301,
            "message": {
                "message_id": 60,
                "date": 1_700_000_500,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": -600, "type": "group" },
                "reply_to_message": { "message_id": 49 },
                "text": "hi"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: Some("tg_session_42"),
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        assert_eq!(
            envelope.message.reply_to_id.as_deref(),
            Some("telegram:tg_session_42")
        );
    }

    #[test]
    fn voice_message_with_caption_builds_combined_content() {
        let update = json!({
            "update_id": 400,
            "message": {
                "message_id": 11,
                "date": 1_700_000_600,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": 42, "type": "private" },
                "voice": {
                    "file_id": "f_id",
                    "file_unique_id": "uniq",
                    "duration": 5
                },
                "caption": "check this"
            }
        });
        let recipients = default_recipients();
        let media = InboundMediaInfo {
            local_path: "/tmp/voice.ogg",
            media_type: InboundMediaType::Voice,
            duration_seconds: Some(5),
            file_name: None,
        };
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: Some(&media),
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        assert_eq!(
            envelope.content,
            "check this\n[voice message: /tmp/voice.ogg, duration: 5s]"
        );
    }

    #[test]
    fn voice_message_without_text_uses_marker_only() {
        let update = json!({
            "update_id": 401,
            "message": {
                "message_id": 12,
                "date": 1_700_000_700,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": 42, "type": "private" },
                "voice": {
                    "file_id": "f_id",
                    "file_unique_id": "uniq",
                    "duration": 3
                }
            }
        });
        let recipients = default_recipients();
        let media = InboundMediaInfo {
            local_path: "/data/v.ogg",
            media_type: InboundMediaType::Voice,
            duration_seconds: Some(3),
            file_name: None,
        };
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: Some(&media),
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        assert_eq!(
            envelope.content,
            "[voice message: /data/v.ogg, duration: 3s]"
        );
    }

    #[test]
    fn bot_authored_message_returns_none() {
        let update = json!({
            "update_id": 500,
            "message": {
                "message_id": 1,
                "date": 1_700_000_800,
                "from": {
                    "id": 777,
                    "is_bot": true,
                    "first_name": "OtherBot"
                },
                "chat": { "id": 42, "type": "private" },
                "text": "echo"
            }
        });
        let recipients = default_recipients();
        let result = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        });
        assert!(result.is_none());
    }

    #[test]
    fn our_own_bot_id_returns_none_even_if_is_bot_flag_missing() {
        let update = json!({
            "update_id": 501,
            "message": {
                "message_id": 2,
                "date": 1_700_000_900,
                "from": {
                    "id": 999,
                    "first_name": "Self"
                },
                "chat": { "id": 42, "type": "private" },
                "text": "self"
            }
        });
        let recipients = default_recipients();
        let result = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        });
        assert!(result.is_none());
    }

    #[test]
    fn channel_chat_type_returns_none() {
        let update = json!({
            "update_id": 502,
            "message": {
                "message_id": 3,
                "date": 1_700_001_000,
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Alice"
                },
                "chat": { "id": -1003, "type": "channel", "title": "News" },
                "text": "announcement"
            }
        });
        let recipients = default_recipients();
        let result = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        });
        assert!(result.is_none());
    }

    #[test]
    fn callback_query_returns_none() {
        let update = json!({
            "update_id": 600,
            "callback_query": {
                "id": "cb1",
                "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
                "data": "noop"
            }
        });
        let recipients = default_recipients();
        let result = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        });
        assert!(result.is_none());
    }

    #[test]
    fn empty_text_without_media_returns_none() {
        let update = json!({
            "update_id": 700,
            "message": {
                "message_id": 4,
                "date": 1_700_001_100,
                "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
                "chat": { "id": 42, "type": "private" },
                "text": "   "
            }
        });
        let recipients = default_recipients();
        let result = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        });
        assert!(result.is_none());
    }

    #[test]
    fn sender_linked_pubkey_populates_principal() {
        let update = json!({
            "update_id": 800,
            "message": {
                "message_id": 1,
                "date": 1_700_001_200,
                "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
                "chat": { "id": 42, "type": "private" },
                "text": "hi"
            }
        });
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: Some("npub_hex"),
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        assert_eq!(
            envelope.principal.linked_pubkey.as_deref(),
            Some("npub_hex")
        );
    }

    #[test]
    fn seen_participants_snapshot_is_carried_through() {
        let update = json!({
            "update_id": 900,
            "message": {
                "message_id": 1,
                "date": 1_700_001_300,
                "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
                "chat": { "id": -1000, "type": "supergroup", "title": "Hub" },
                "text": "hi"
            }
        });
        let mut snapshot = base_snapshot("-1000");
        snapshot.seen_participants = vec![
            TelegramSeenParticipantMetadata {
                user_id: "42".to_string(),
                display_name: Some("Alice".to_string()),
                username: None,
                last_seen_at: 42_000,
            },
            TelegramSeenParticipantMetadata {
                user_id: "43".to_string(),
                display_name: Some("Bob".to_string()),
                username: None,
                last_seen_at: 43_000,
            },
        ];
        let recipients = default_recipients();
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: Some(&snapshot),
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        let transport = envelope
            .metadata
            .transport
            .as_ref()
            .and_then(|bag| bag.telegram.as_ref())
            .expect("telegram metadata");
        let seen = transport.seen_participants.as_ref().expect("seen present");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].user_id, "42");
        assert_eq!(seen[1].user_id, "43");
    }

    #[test]
    fn missing_sender_returns_none() {
        let update = json!({
            "update_id": 1000,
            "message": {
                "message_id": 1,
                "date": 1_700_001_400,
                "chat": { "id": 42, "type": "private" },
                "text": "x"
            }
        });
        let recipients = default_recipients();
        assert!(
            normalize_telegram_update(InboundNormalizationInput {
                update: &update,
                bot_id: 999,
                bot_username: None,
                chat_context_snapshot: None,
                sender_linked_pubkey: None,
                media_info: None,
                session_reply_to_native_id: None,
                recipients: &recipients,
                project_binding: None,
            })
            .is_none()
        );
    }

    #[test]
    fn recipients_shape_matches_ts_format() {
        let update = json!({
            "update_id": 1100,
            "message": {
                "message_id": 1,
                "date": 1_700_001_500,
                "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
                "chat": { "id": 42, "type": "private" },
                "text": "x"
            }
        });
        let recipients = vec![InboundRecipient {
            agent_pubkey: "abc123",
            agent_name: "Agent Smith",
        }];
        let envelope = normalize_telegram_update(InboundNormalizationInput {
            update: &update,
            bot_id: 999,
            bot_username: None,
            chat_context_snapshot: None,
            sender_linked_pubkey: None,
            media_info: None,
            session_reply_to_native_id: None,
            recipients: &recipients,
            project_binding: None,
        })
        .expect("envelope");
        assert_eq!(envelope.recipients.len(), 1);
        let recipient = &envelope.recipients[0];
        assert_eq!(recipient.id, "nostr:abc123");
        assert_eq!(recipient.transport, RuntimeTransport::Nostr);
        assert_eq!(recipient.linked_pubkey.as_deref(), Some("abc123"));
        assert_eq!(recipient.display_name.as_deref(), Some("Agent Smith"));
        assert_eq!(recipient.kind, Some(PrincipalKind::Agent));
    }
}

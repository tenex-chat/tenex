//! Filesystem-backed Telegram inbound ingress boundary.
//!
//! This module deliberately does not poll the Bot API, download media, send
//! typing indicators, or write TypeScript-owned binding/session state. It
//! composes the Rust pieces that already exist for the daemon migration:
//! shared binding readers, optional chat-context snapshots, the pure
//! Telegram inbound normalizer, and the generic inbound route+dispatch
//! runtime.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::inbound_runtime::{
    InboundRuntimeError, InboundRuntimeInput, InboundRuntimeOutcome,
    resolve_and_enqueue_inbound_dispatch,
};
use crate::project_event_index::ProjectEventIndex;
use crate::telegram::bindings::{
    RuntimeTransport as BindingRuntimeTransport, TransportBindingReadError, find_binding,
    find_linked_pubkey_for_telegram_user, read_identity_bindings, read_transport_bindings,
};
use crate::telegram::chat_context::{ChatContextError, load_chat_context};
use crate::telegram::inbound::{
    InboundMediaInfo, InboundNormalizationInput, InboundRecipient, normalize_telegram_update,
};

#[derive(Debug, Clone, Copy)]
pub struct TelegramIngressRuntimeInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub data_dir: &'a Path,
    pub agent_pubkey: &'a str,
    pub agent_name: Option<&'a str>,
    pub update: &'a Value,
    pub bot_id: u64,
    pub bot_username: Option<&'a str>,
    pub media_info: Option<&'a InboundMediaInfo<'a>>,
    pub session_reply_to_native_id: Option<&'a str>,
    pub timestamp: u64,
    pub writer_version: &'a str,
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TelegramIngressRuntimeOutcome {
    Routed {
        channel_id: String,
        project_id: String,
        inbound: InboundRuntimeOutcome,
    },
    Ignored {
        reason: TelegramIngressIgnoredReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramIngressIgnoredReason {
    pub code: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum TelegramIngressRuntimeError {
    #[error("telegram ingress binding read failed: {0}")]
    Bindings(#[from] TransportBindingReadError),
    #[error("telegram ingress backend config read failed: {0}")]
    Config(#[from] BackendConfigError),
    #[error("telegram ingress chat context read failed: {0}")]
    ChatContext(#[from] ChatContextError),
    #[error("telegram ingress inbound runtime failed: {0}")]
    InboundRuntime(#[from] InboundRuntimeError),
}

pub fn process_telegram_update(
    input: TelegramIngressRuntimeInput<'_>,
) -> Result<TelegramIngressRuntimeOutcome, TelegramIngressRuntimeError> {
    let facts = match extract_update_facts(input.update, input.bot_id) {
        Ok(facts) => facts,
        Err(reason) => return Ok(TelegramIngressRuntimeOutcome::Ignored { reason }),
    };

    let transport_bindings = read_transport_bindings(input.data_dir)?;
    let Some(binding) = find_binding(
        &transport_bindings,
        input.agent_pubkey,
        &facts.channel_id,
        BindingRuntimeTransport::Telegram,
    ) else {
        return Ok(TelegramIngressRuntimeOutcome::Ignored {
            reason: ignored(
                "unbound_channel",
                format!(
                    "telegram channel {} is not bound for agent {}",
                    facts.channel_id, input.agent_pubkey
                ),
                Some(facts.channel_id),
                Some(facts.principal_id),
                None,
            ),
        });
    };

    let identity_bindings = read_identity_bindings(input.data_dir)?;
    let linked_pubkey =
        find_linked_pubkey_for_telegram_user(&identity_bindings, facts.sender_user_id);

    if facts.is_private {
        let config = read_backend_config(input.tenex_base_dir)?;
        if !is_authorized_principal(&config, &facts.principal_id, linked_pubkey) {
            return Ok(TelegramIngressRuntimeOutcome::Ignored {
                reason: ignored(
                    "unauthorized_sender",
                    format!(
                        "telegram principal {} is not authorized for private inbound dispatch",
                        facts.principal_id
                    ),
                    Some(facts.channel_id),
                    Some(facts.principal_id),
                    Some(binding.project_id.clone()),
                ),
            });
        }
    }

    let chat_context = load_chat_context(input.daemon_dir, &facts.chat_id)?;
    let agent_name = input.agent_name.unwrap_or(input.agent_pubkey);
    let recipients = [InboundRecipient {
        agent_pubkey: binding.agent_pubkey.as_str(),
        agent_name,
    }];
    let Some(envelope) = normalize_telegram_update(InboundNormalizationInput {
        update: input.update,
        bot_id: input.bot_id,
        bot_username: input.bot_username,
        chat_context_snapshot: chat_context.as_ref(),
        sender_linked_pubkey: linked_pubkey,
        media_info: input.media_info,
        session_reply_to_native_id: input.session_reply_to_native_id,
        recipients: &recipients,
        project_binding: Some(binding.project_id.as_str()),
    }) else {
        return Ok(TelegramIngressRuntimeOutcome::Ignored {
            reason: ignored(
                "not_routable_update",
                "telegram update could not be normalized into an inbound envelope",
                Some(facts.channel_id),
                Some(facts.principal_id),
                Some(binding.project_id.clone()),
            ),
        });
    };

    let inbound = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
        daemon_dir: input.daemon_dir,
        tenex_base_dir: input.tenex_base_dir,
        envelope: &envelope,
        timestamp: input.timestamp,
        writer_version: input.writer_version,
        project_event_index: input.project_event_index,
    })?;

    Ok(TelegramIngressRuntimeOutcome::Routed {
        channel_id: facts.channel_id,
        project_id: binding.project_id.clone(),
        inbound,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TelegramUpdateFacts {
    chat_id: String,
    channel_id: String,
    principal_id: String,
    sender_user_id: i64,
    is_private: bool,
}

fn extract_update_facts(
    update: &Value,
    bot_id: u64,
) -> Result<TelegramUpdateFacts, TelegramIngressIgnoredReason> {
    let Some(update) = update.as_object() else {
        return Err(ignored(
            "invalid_update",
            "telegram update is not a JSON object",
            None,
            None,
            None,
        ));
    };

    if update.contains_key("callback_query") {
        return Err(ignored(
            "unsupported_callback_query",
            "callback query updates are handled by Telegram config flows, not runtime ingress",
            None,
            None,
            None,
        ));
    }

    let Some(message) = update
        .get("message")
        .filter(|value| !value.is_null())
        .or_else(|| {
            update
                .get("edited_message")
                .filter(|value| !value.is_null())
        })
        .and_then(Value::as_object)
    else {
        return Err(ignored(
            "missing_message",
            "telegram update does not contain a routable message",
            None,
            None,
            None,
        ));
    };

    let Some(from) = message.get("from").and_then(Value::as_object) else {
        return Err(ignored(
            "missing_sender",
            "telegram message does not contain a sender",
            None,
            None,
            None,
        ));
    };
    let Some(sender_user_id) = from.get("id").and_then(Value::as_i64) else {
        return Err(ignored(
            "missing_sender",
            "telegram sender does not contain a numeric id",
            None,
            None,
            None,
        ));
    };
    let principal_id = format!("telegram:user:{sender_user_id}");
    let sender_is_bot = from.get("is_bot").and_then(Value::as_bool).unwrap_or(false);
    if sender_is_bot || u64::try_from(sender_user_id).ok() == Some(bot_id) {
        return Err(ignored(
            "bot_authored_update",
            "telegram update was authored by a bot account",
            None,
            Some(principal_id),
            None,
        ));
    }

    let Some(chat) = message.get("chat").and_then(Value::as_object) else {
        return Err(ignored(
            "missing_chat",
            "telegram message does not contain a chat",
            None,
            Some(principal_id),
            None,
        ));
    };
    let Some(chat_id) = chat.get("id").and_then(Value::as_i64) else {
        return Err(ignored(
            "missing_chat",
            "telegram chat does not contain a numeric id",
            None,
            Some(principal_id),
            None,
        ));
    };
    let Some(chat_type) = chat.get("type").and_then(Value::as_str) else {
        return Err(ignored(
            "missing_chat_type",
            "telegram chat does not contain a type",
            None,
            Some(principal_id),
            None,
        ));
    };
    let is_private = match chat_type {
        "private" => true,
        "group" | "supergroup" => false,
        _ => {
            return Err(ignored(
                "unsupported_chat_type",
                format!("telegram chat type {chat_type:?} is not routed"),
                None,
                Some(principal_id),
                None,
            ));
        }
    };

    let chat_id = chat_id.to_string();
    let message_thread_id = message.get("message_thread_id").and_then(Value::as_i64);
    let channel_id = create_telegram_channel_id(&chat_id, message_thread_id);

    Ok(TelegramUpdateFacts {
        chat_id,
        channel_id,
        principal_id,
        sender_user_id,
        is_private,
    })
}

fn is_authorized_principal(
    config: &BackendConfigSnapshot,
    principal_id: &str,
    linked_pubkey: Option<&str>,
) -> bool {
    if config
        .whitelisted_identities
        .iter()
        .any(|identity| identity == principal_id)
    {
        return true;
    }

    let Some(pubkey) = linked_pubkey else {
        return false;
    };
    if config
        .whitelisted_pubkeys
        .iter()
        .any(|candidate| candidate == pubkey)
    {
        return true;
    }

    let nostr_principal_id = format!("nostr:{pubkey}");
    config
        .whitelisted_identities
        .iter()
        .any(|identity| identity == &nostr_principal_id)
}

fn create_telegram_channel_id(chat_id: &str, message_thread_id: Option<i64>) -> String {
    match message_thread_id {
        Some(thread_id) => format!("telegram:group:{chat_id}:topic:{thread_id}"),
        None => format!("telegram:chat:{chat_id}"),
    }
}

fn ignored(
    code: impl Into<String>,
    detail: impl Into<String>,
    channel_id: Option<String>,
    principal_id: Option<String>,
    project_id: Option<String>,
) -> TelegramIngressIgnoredReason {
    TelegramIngressIgnoredReason {
        code: code.into(),
        detail: detail.into(),
        channel_id,
        principal_id,
        project_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::inbound_runtime::InboundRuntimeOutcome;
    use crate::worker_dispatch_input::{
        WorkerDispatchInputSourceType, read_optional as read_worker_dispatch_input,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn bound_private_chat_normalizes_and_enqueues_inbound_dispatch() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let data_dir = base_dir.join("data");
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);

        write_config(base_dir, &[&owner], &[]);
        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");
        write_transport_binding(&data_dir, &agent, "telegram:chat:1001", "project-alpha");
        write_identity_binding(&data_dir, "telegram:user:42", Some(&owner));

        let update = private_text_update(100, 5, 1001, 42, "hello from telegram");
        let outcome = process_telegram_update(TelegramIngressRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            data_dir: &data_dir,
            agent_pubkey: &agent,
            agent_name: Some("Alpha Agent"),
            update: &update,
            bot_id: 9001,
            bot_username: Some("tenex_bot"),
            media_info: None,
            session_reply_to_native_id: None,
            timestamp: 1_710_001_500_000,
            writer_version: "telegram-ingress-runtime-test@0",
        })
        .expect("telegram ingress must process");

        let TelegramIngressRuntimeOutcome::Routed {
            channel_id,
            project_id,
            inbound,
        } = outcome
        else {
            panic!("expected routed telegram ingress");
        };
        assert_eq!(channel_id, "telegram:chat:1001");
        assert_eq!(project_id, "project-alpha");

        let InboundRuntimeOutcome::Routed { route, dispatch } = inbound else {
            panic!("expected inbound runtime to route");
        };
        assert_eq!(route.project_id, "project-alpha");
        assert_eq!(route.agent_pubkey, agent);
        assert_eq!(dispatch.triggering_event_id, "tg_1001_5");
        assert!(dispatch.queued);

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].dispatch_id, dispatch.dispatch_id);

        let sidecar = read_worker_dispatch_input(&daemon_dir, &dispatch.dispatch_id)
            .expect("sidecar must read")
            .expect("sidecar must exist");
        assert_eq!(sidecar.source_type, WorkerDispatchInputSourceType::Telegram);
        let fields = sidecar
            .resolved_execute_fields()
            .expect("execute fields must resolve");
        assert_eq!(fields.triggering_event_id, "tg_1001_5");
        assert_eq!(
            fields.triggering_envelope["principal"]["linkedPubkey"].as_str(),
            Some(owner.as_str())
        );
        assert_eq!(
            fields.triggering_envelope["recipients"][0]["displayName"].as_str(),
            Some("Alpha Agent")
        );
        assert_eq!(
            fields.triggering_envelope["metadata"]["transport"]["telegram"]["botUsername"].as_str(),
            Some("tenex_bot")
        );
    }

    #[test]
    fn unbound_channel_is_ignored_without_dispatch_artifacts() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let data_dir = base_dir.join("data");
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x12);
        let agent = pubkey_hex(0x22);

        write_config(base_dir, &[&owner], &[]);
        write_project(base_dir, "project-beta", &owner, "/repo/beta");
        write_agent_index(base_dir, "project-beta", &[&agent]);
        write_agent(base_dir, &agent, "beta-agent");
        fs::create_dir_all(&data_dir).expect("data dir must create");

        let update = group_text_update(101, 6, -2001, 77, "hello unbound");
        let outcome = process_telegram_update(TelegramIngressRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            data_dir: &data_dir,
            agent_pubkey: &agent,
            agent_name: Some("Beta Agent"),
            update: &update,
            bot_id: 9001,
            bot_username: Some("tenex_bot"),
            media_info: None,
            session_reply_to_native_id: None,
            timestamp: 1_710_001_500_001,
            writer_version: "telegram-ingress-runtime-test@0",
        })
        .expect("telegram ingress must process");

        assert_eq!(
            outcome,
            TelegramIngressRuntimeOutcome::Ignored {
                reason: TelegramIngressIgnoredReason {
                    code: "unbound_channel".to_string(),
                    detail: format!(
                        "telegram channel telegram:chat:-2001 is not bound for agent {agent}"
                    ),
                    channel_id: Some("telegram:chat:-2001".to_string()),
                    principal_id: Some("telegram:user:77".to_string()),
                    project_id: None,
                },
            }
        );
        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());
        assert!(!daemon_dir.join("workers").exists());
    }

    #[test]
    fn unauthorized_private_sender_is_ignored_without_dispatch_artifacts() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let data_dir = base_dir.join("data");
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x13);
        let agent = pubkey_hex(0x23);

        write_config(base_dir, &[&owner], &[]);
        write_project(base_dir, "project-gamma", &owner, "/repo/gamma");
        write_agent_index(base_dir, "project-gamma", &[&agent]);
        write_agent(base_dir, &agent, "gamma-agent");
        write_transport_binding(&data_dir, &agent, "telegram:chat:1002", "project-gamma");

        let update = private_text_update(102, 7, 1002, 99, "hello unauthorized");
        let outcome = process_telegram_update(TelegramIngressRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            data_dir: &data_dir,
            agent_pubkey: &agent,
            agent_name: Some("Gamma Agent"),
            update: &update,
            bot_id: 9001,
            bot_username: Some("tenex_bot"),
            media_info: None,
            session_reply_to_native_id: None,
            timestamp: 1_710_001_500_002,
            writer_version: "telegram-ingress-runtime-test@0",
        })
        .expect("telegram ingress must process");

        assert_eq!(
            outcome,
            TelegramIngressRuntimeOutcome::Ignored {
                reason: TelegramIngressIgnoredReason {
                    code: "unauthorized_sender".to_string(),
                    detail:
                        "telegram principal telegram:user:99 is not authorized for private inbound dispatch"
                            .to_string(),
                    channel_id: Some("telegram:chat:1002".to_string()),
                    principal_id: Some("telegram:user:99".to_string()),
                    project_id: Some("project-gamma".to_string()),
                },
            }
        );
        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());
        assert!(!daemon_dir.join("workers").exists());
    }

    fn private_text_update(
        update_id: i64,
        message_id: i64,
        chat_id: i64,
        sender_id: i64,
        text: &str,
    ) -> Value {
        json!({
            "update_id": update_id,
            "message": {
                "message_id": message_id,
                "date": 1_710_001_500,
                "from": {
                    "id": sender_id,
                    "is_bot": false,
                    "first_name": "Ada",
                    "username": "ada"
                },
                "chat": {
                    "id": chat_id,
                    "type": "private"
                },
                "text": text
            }
        })
    }

    fn group_text_update(
        update_id: i64,
        message_id: i64,
        chat_id: i64,
        sender_id: i64,
        text: &str,
    ) -> Value {
        json!({
            "update_id": update_id,
            "message": {
                "message_id": message_id,
                "date": 1_710_001_500,
                "from": {
                    "id": sender_id,
                    "is_bot": false,
                    "first_name": "Grace",
                    "username": "grace"
                },
                "chat": {
                    "id": chat_id,
                    "type": "supergroup",
                    "title": "Operators"
                },
                "text": text
            }
        })
    }

    fn write_config(
        base_dir: &Path,
        whitelisted_pubkeys: &[&str],
        whitelisted_identities: &[&str],
    ) {
        fs::write(
            base_dir.join("config.json"),
            serde_json::to_vec_pretty(&json!({
                "whitelistedPubkeys": whitelisted_pubkeys,
                "whitelistedIdentities": whitelisted_identities,
            }))
            .expect("config json must serialize"),
        )
        .expect("config must write");
    }

    fn write_project(base_dir: &Path, project_id: &str, owner: &str, project_base_path: &str) {
        let project_dir = base_dir.join("projects").join(project_id);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::write(
            project_dir.join("project.json"),
            serde_json::to_vec_pretty(&json!({
                "projectOwnerPubkey": owner,
                "projectDTag": project_id,
                "projectBasePath": project_base_path,
                "status": "active"
            }))
            .expect("project json must serialize"),
        )
        .expect("project descriptor must write");
    }

    fn write_agent_index(base_dir: &Path, project_id: &str, pubkeys: &[&str]) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_vec_pretty(&json!({
                "byProject": {
                    project_id: pubkeys,
                }
            }))
            .expect("agent index json must serialize"),
        )
        .expect("agent index must write");
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&json!({
                "slug": slug,
                "name": slug,
                "status": "active",
                "default": {}
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn write_transport_binding(
        data_dir: &Path,
        agent_pubkey: &str,
        channel_id: &str,
        project_id: &str,
    ) {
        fs::create_dir_all(data_dir).expect("data dir must create");
        fs::write(
            data_dir.join("transport-bindings.json"),
            serde_json::to_vec_pretty(&json!([{
                "transport": "telegram",
                "agentPubkey": agent_pubkey,
                "channelId": channel_id,
                "projectId": project_id,
                "createdAt": 1,
                "updatedAt": 1
            }]))
            .expect("transport bindings json must serialize"),
        )
        .expect("transport bindings must write");
    }

    fn write_identity_binding(data_dir: &Path, principal_id: &str, linked_pubkey: Option<&str>) {
        fs::create_dir_all(data_dir).expect("data dir must create");
        fs::write(
            data_dir.join("identity-bindings.json"),
            serde_json::to_vec_pretty(&json!([{
                "principalId": principal_id,
                "transport": "telegram",
                "linkedPubkey": linked_pubkey,
                "displayName": "Ada",
                "username": "ada",
                "kind": "human",
                "updatedAt": 1
            }]))
            .expect("identity bindings json must serialize"),
        )
        .expect("identity bindings must write");
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}

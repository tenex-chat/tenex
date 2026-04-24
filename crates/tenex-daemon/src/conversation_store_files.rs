use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use thiserror::Error;

use crate::inbound_envelope::{
    ChannelKind, ChannelRef, ExternalMessageRef, InboundEnvelope, InboundMetadata, PrincipalRef,
    RuntimeTransport,
};
use crate::ral_journal::RalPendingDelegation;

const CONVERSATIONS_DIR_NAME: &str = "conversations";

#[derive(Debug, Error)]
pub enum ConversationStoreFilesError {
    #[error("conversation store io error: {0}")]
    Io(#[from] io::Error),
    #[error("conversation store json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("conversation record at {path} is not a JSON object")]
    InvalidConversationRoot { path: PathBuf },
}

#[derive(Debug, Clone, Copy)]
pub struct DelegationCompletionStoreInput<'a> {
    pub metadata_path: &'a Path,
    pub parent_conversation_id: &'a str,
    pub parent_agent_pubkey: &'a str,
    pub parent_ral_number: u64,
    pub pending_delegation: &'a RalPendingDelegation,
    pub completion_envelope: &'a InboundEnvelope,
    pub parent_triggering_event_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationCompletionStoreOutcome {
    pub child_message_appended: bool,
    pub parent_marker_appended: bool,
    pub parent_triggering_envelope: Option<InboundEnvelope>,
}

pub fn record_delegation_completion(
    input: DelegationCompletionStoreInput<'_>,
) -> Result<DelegationCompletionStoreOutcome, ConversationStoreFilesError> {
    let child_message_appended = append_envelope_message(
        input.metadata_path,
        &input.pending_delegation.delegation_conversation_id,
        input.completion_envelope,
    )?;
    let parent_triggering_envelope = input
        .parent_triggering_event_id
        .and_then(|event_id| {
            read_parent_triggering_envelope(
                input.metadata_path,
                input.parent_conversation_id,
                event_id,
            )
            .transpose()
        })
        .transpose()?;
    let parent_marker_appended = append_completed_delegation_marker(input)?;

    Ok(DelegationCompletionStoreOutcome {
        child_message_appended,
        parent_marker_appended,
        parent_triggering_envelope,
    })
}

pub fn append_envelope_message(
    metadata_path: &Path,
    conversation_id: &str,
    envelope: &InboundEnvelope,
) -> Result<bool, ConversationStoreFilesError> {
    if envelope.metadata.event_kind.is_some_and(|kind| kind != 1)
        || envelope.metadata.tool_name.is_some()
    {
        return Ok(false);
    }

    let path = conversation_path(metadata_path, conversation_id);
    let mut state = read_or_empty_conversation(&path)?;
    let messages = messages_mut(&mut state);
    if messages.iter().any(|message| {
        message.get("eventId").and_then(Value::as_str) == Some(envelope.message.native_id.as_str())
    }) {
        return Ok(false);
    }

    messages.push(envelope_message_record(envelope));
    write_conversation(&path, &state)?;
    Ok(true)
}

fn append_completed_delegation_marker(
    input: DelegationCompletionStoreInput<'_>,
) -> Result<bool, ConversationStoreFilesError> {
    let path = conversation_path(input.metadata_path, input.parent_conversation_id);
    let mut state = read_or_empty_conversation(&path)?;
    let messages = messages_mut(&mut state);
    let delegation_conversation_id = input.pending_delegation.delegation_conversation_id.as_str();

    if messages.iter().any(|message| {
        message.get("messageType").and_then(Value::as_str) == Some("delegation-marker")
            && message
                .get("delegationMarker")
                .and_then(|marker| marker.get("delegationConversationId"))
                .and_then(Value::as_str)
                == Some(delegation_conversation_id)
            && message
                .get("delegationMarker")
                .and_then(|marker| marker.get("status"))
                .and_then(Value::as_str)
                == Some("completed")
    }) {
        return Ok(false);
    }

    let pending_marker = messages.iter().find(|message| {
        message.get("messageType").and_then(Value::as_str) == Some("delegation-marker")
            && message
                .get("delegationMarker")
                .and_then(|marker| marker.get("delegationConversationId"))
                .and_then(Value::as_str)
                == Some(delegation_conversation_id)
            && message
                .get("delegationMarker")
                .and_then(|marker| marker.get("status"))
                .and_then(Value::as_str)
                == Some("pending")
    });

    let index = messages.len();
    let completed_at = input.completion_envelope.occurred_at;
    let marker = completed_marker_value(
        input.parent_conversation_id,
        input.pending_delegation,
        pending_marker,
        completed_at,
    );
    let pubkey = pending_marker
        .and_then(|message| message.get("pubkey"))
        .and_then(Value::as_str)
        .unwrap_or(input.parent_agent_pubkey)
        .to_string();
    let ral_number = pending_marker
        .and_then(|message| message.get("ral"))
        .and_then(Value::as_u64)
        .unwrap_or(input.parent_ral_number);

    messages.push(json!({
        "id": format!("record:delegation:{delegation_conversation_id}:completed:{index}"),
        "pubkey": pubkey,
        "ral": ral_number,
        "content": "",
        "messageType": "delegation-marker",
        "timestamp": completed_at,
        "targetedPubkeys": [input.parent_agent_pubkey],
        "delegationMarker": marker,
    }));
    write_conversation(&path, &state)?;
    Ok(true)
}

fn completed_marker_value(
    parent_conversation_id: &str,
    pending: &RalPendingDelegation,
    pending_marker: Option<&Value>,
    completed_at: i64,
) -> Value {
    let base = pending_marker
        .and_then(|message| message.get("delegationMarker"))
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "delegationConversationId": pending.delegation_conversation_id,
                "recipientPubkey": pending.recipient_pubkey,
                "parentConversationId": parent_conversation_id,
                "status": "pending",
            })
        });
    let mut marker = base.as_object().cloned().unwrap_or_else(Map::new);
    marker.insert("status".to_string(), Value::String("completed".to_string()));
    marker.insert(
        "completedAt".to_string(),
        Value::Number(serde_json::Number::from(completed_at)),
    );
    Value::Object(marker)
}

fn read_parent_triggering_envelope(
    metadata_path: &Path,
    conversation_id: &str,
    event_id: &str,
) -> Result<Option<InboundEnvelope>, ConversationStoreFilesError> {
    let path = conversation_path(metadata_path, conversation_id);
    let state = read_or_empty_conversation(&path)?;
    let Some(messages) = state.get("messages").and_then(Value::as_array) else {
        return Ok(None);
    };
    let record = messages
        .iter()
        .find(|message| message.get("eventId").and_then(Value::as_str) == Some(event_id))
        .or_else(|| messages.first());
    Ok(record.and_then(|record| envelope_from_record(conversation_id, record)))
}

fn envelope_message_record(envelope: &InboundEnvelope) -> Value {
    let targeted_pubkeys = envelope
        .recipients
        .iter()
        .filter_map(|recipient| recipient.linked_pubkey.clone())
        .collect::<Vec<_>>();
    let targeted_principals = if targeted_pubkeys.is_empty() {
        None
    } else {
        Some(
            envelope
                .recipients
                .iter()
                .map(principal_snapshot_value)
                .collect::<Vec<_>>(),
        )
    };
    let sender_principal = principal_snapshot_value(&envelope.principal);
    let sender_pubkey = envelope.principal.linked_pubkey.clone();

    let mut record = Map::new();
    record.insert(
        "id".to_string(),
        Value::String(format!("record:{}", envelope.message.native_id)),
    );
    record.insert(
        "pubkey".to_string(),
        Value::String(sender_pubkey.clone().unwrap_or_default()),
    );
    record.insert(
        "content".to_string(),
        Value::String(envelope.content.clone()),
    );
    record.insert("messageType".to_string(), Value::String("text".to_string()));
    record.insert(
        "eventId".to_string(),
        Value::String(envelope.message.native_id.clone()),
    );
    record.insert(
        "timestamp".to_string(),
        Value::Number(serde_json::Number::from(envelope.occurred_at)),
    );
    if !targeted_pubkeys.is_empty() {
        record.insert("targetedPubkeys".to_string(), json!(targeted_pubkeys));
    }
    if let Some(targeted_principals) = targeted_principals {
        record.insert("targetedPrincipals".to_string(), json!(targeted_principals));
    }
    if let Some(sender_pubkey) = sender_pubkey {
        record.insert("senderPubkey".to_string(), Value::String(sender_pubkey));
    }
    record.insert("senderPrincipal".to_string(), sender_principal);
    record.insert("channel".to_string(), json!(envelope.channel));
    record.insert("capabilities".to_string(), json!(envelope.capabilities));
    record.insert("inboundMetadata".to_string(), json!(envelope.metadata));
    Value::Object(record)
}

fn envelope_from_record(conversation_id: &str, record: &Value) -> Option<InboundEnvelope> {
    let event_id = record.get("eventId").and_then(Value::as_str)?.to_string();
    let content = record
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let occurred_at = record
        .get("timestamp")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let principal = record
        .get("senderPrincipal")
        .cloned()
        .and_then(|value| serde_json::from_value::<PrincipalRef>(value).ok())
        .or_else(|| {
            record
                .get("senderPubkey")
                .and_then(Value::as_str)
                .or_else(|| record.get("pubkey").and_then(Value::as_str))
                .filter(|pubkey| !pubkey.is_empty())
                .map(|pubkey| PrincipalRef {
                    id: format!("nostr:{pubkey}"),
                    transport: RuntimeTransport::Nostr,
                    linked_pubkey: Some(pubkey.to_string()),
                    display_name: None,
                    username: None,
                    kind: None,
                })
        })
        .unwrap_or_else(|| PrincipalRef {
            id: "nostr:unknown".to_string(),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: None,
            display_name: None,
            username: None,
            kind: None,
        });
    let recipients = record
        .get("targetedPrincipals")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<PrincipalRef>>(value).ok())
        .filter(|recipients| !recipients.is_empty())
        .or_else(|| {
            record
                .get("targetedPubkeys")
                .and_then(Value::as_array)
                .map(|pubkeys| {
                    pubkeys
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|pubkey| PrincipalRef {
                            id: format!("nostr:{pubkey}"),
                            transport: RuntimeTransport::Nostr,
                            linked_pubkey: Some(pubkey.to_string()),
                            display_name: None,
                            username: None,
                            kind: None,
                        })
                        .collect::<Vec<_>>()
                })
        })
        .unwrap_or_default();
    let channel = record
        .get("channel")
        .cloned()
        .and_then(|value| serde_json::from_value::<ChannelRef>(value).ok())
        .unwrap_or_else(|| ChannelRef {
            id: format!("nostr:conversation:{conversation_id}"),
            transport: RuntimeTransport::Nostr,
            kind: ChannelKind::Conversation,
            project_binding: None,
        });
    let capabilities = record
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let metadata = record
        .get("inboundMetadata")
        .cloned()
        .and_then(|value| serde_json::from_value::<InboundMetadata>(value).ok())
        .unwrap_or_default();

    Some(InboundEnvelope {
        transport: principal.transport,
        principal,
        channel,
        message: ExternalMessageRef {
            id: format!("nostr:{event_id}"),
            transport: RuntimeTransport::Nostr,
            native_id: event_id,
            reply_to_id: None,
        },
        recipients,
        content,
        occurred_at,
        capabilities,
        metadata,
    })
}

fn principal_snapshot_value(principal: &PrincipalRef) -> Value {
    json!({
        "id": principal.id,
        "transport": principal.transport,
        "linkedPubkey": principal.linked_pubkey,
    })
}

fn conversation_path(metadata_path: &Path, conversation_id: &str) -> PathBuf {
    metadata_path
        .join(CONVERSATIONS_DIR_NAME)
        .join(format!("{conversation_id}.json"))
}

fn read_or_empty_conversation(path: &Path) -> Result<Value, ConversationStoreFilesError> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(empty_conversation_state());
        }
        Err(error) => return Err(error.into()),
    };
    let value = serde_json::from_str::<Value>(&content)?;
    if !value.is_object() {
        return Err(ConversationStoreFilesError::InvalidConversationRoot {
            path: path.to_path_buf(),
        });
    }
    Ok(value)
}

fn messages_mut(state: &mut Value) -> &mut Vec<Value> {
    let object = state
        .as_object_mut()
        .expect("conversation state root must be object");
    object
        .entry("messages".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .expect("messages field must be an array")
}

fn empty_conversation_state() -> Value {
    json!({
        "activeRal": {},
        "nextRalNumber": {},
        "injections": [],
        "messages": [],
        "metadata": {},
        "agentTodos": {},
        "todoNudgedAgents": [],
        "blockedAgents": [],
        "executionTime": {
            "totalSeconds": 0,
            "isActive": false,
            "lastUpdated": 0
        },
        "contextManagementCompactions": {},
        "selfAppliedSkills": {},
        "agentPromptHistories": {},
        "contextManagementReminderStates": {}
    })
}

fn write_conversation(path: &Path, state: &Value) -> Result<(), ConversationStoreFilesError> {
    let parent = path
        .parent()
        .expect("conversation path must have parent directory");
    fs::create_dir_all(parent)?;
    let tmp_path = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), now_nanos()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        serde_json::to_writer_pretty(&mut file, state)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp_path, path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

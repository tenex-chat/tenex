use std::{collections::HashMap, path::Path};

use serde::Deserialize;
use tenex_conversations::{
    model::ConversationRow, ConversationListFilter, ConversationStore, MessageQuery,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredDelegationRoute {
    pub child_agent_pubkey: String,
    pub child_conversation_id: String,
}

pub(super) struct ResolvedDelegation {
    pub canonical_id: String,
    pub route: Option<StoredDelegationRoute>,
}

pub(super) fn resolve_delegation(
    db_path: &Path,
    raw_id: &str,
) -> Result<ResolvedDelegation, String> {
    let trimmed = raw_id.trim().to_lowercase();
    if is_hex_prefix(&trimmed) {
        return resolve_delegation_prefix(db_path, &trimmed);
    }
    if !is_full_hex_id(&trimmed) {
        return Err(format!(
            "invalid delegation conversation event ID: {raw_id}"
        ));
    }

    if let Some(route) = route_for_conversation(db_path, &trimmed)? {
        return Ok(ResolvedDelegation {
            canonical_id: trimmed,
            route: Some(route),
        });
    }
    if let Some((canonical_id, route)) = find_route_by_message_id(db_path, &trimmed, false)? {
        return Ok(ResolvedDelegation {
            canonical_id,
            route: Some(route),
        });
    }
    Ok(ResolvedDelegation {
        canonical_id: trimmed,
        route: None,
    })
}

fn resolve_delegation_prefix(db_path: &Path, prefix: &str) -> Result<ResolvedDelegation, String> {
    let mut matches = HashMap::<String, StoredDelegationRoute>::new();
    let store = open_store(db_path)?;
    for conversation in list_conversations(&store)? {
        let Some(route) = route_from_runtime_state(&conversation.runtime_state) else {
            continue;
        };
        if conversation.id.to_lowercase().starts_with(prefix) {
            matches.insert(conversation.id.clone(), route.clone());
        }
        let messages = store
            .list_messages(&conversation.id, MessageQuery::default())
            .map_err(|e| format!("failed to list messages: {e}"))?;
        if messages.iter().any(|message| {
            message
                .nostr_event_id
                .as_deref()
                .is_some_and(|id| id.to_lowercase().starts_with(prefix))
        }) {
            matches.insert(conversation.id.clone(), route);
        }
    }

    match matches.len() {
        1 => {
            let (canonical_id, route) = matches.into_iter().next().unwrap();
            Ok(ResolvedDelegation {
                canonical_id,
                route: Some(route),
            })
        }
        0 => Err(format!(
            "could not resolve {prefix} to a delegation conversation event ID"
        )),
        _ => Err(format!("delegation prefix {prefix} is ambiguous")),
    }
}

fn route_for_conversation(
    db_path: &Path,
    conversation_id: &str,
) -> Result<Option<StoredDelegationRoute>, String> {
    let store = open_store(db_path)?;
    Ok(store
        .get_conversation(conversation_id)
        .map_err(|e| format!("failed to read conversation: {e}"))?
        .and_then(|conversation| route_from_runtime_state(&conversation.runtime_state)))
}

fn find_route_by_message_id(
    db_path: &Path,
    event_id: &str,
    prefix: bool,
) -> Result<Option<(String, StoredDelegationRoute)>, String> {
    let store = open_store(db_path)?;
    for conversation in list_conversations(&store)? {
        let Some(route) = route_from_runtime_state(&conversation.runtime_state) else {
            continue;
        };
        let messages = store
            .list_messages(&conversation.id, MessageQuery::default())
            .map_err(|e| format!("failed to list messages: {e}"))?;
        let matched = messages.iter().any(|message| {
            message.nostr_event_id.as_deref().is_some_and(|id| {
                let id = id.to_lowercase();
                if prefix {
                    id.starts_with(event_id)
                } else {
                    id == event_id
                }
            })
        });
        if matched {
            return Ok(Some((conversation.id, route)));
        }
    }
    Ok(None)
}

fn open_store(db_path: &Path) -> Result<ConversationStore, String> {
    ConversationStore::open(db_path).map_err(|e| format!("failed to open conversation store: {e}"))
}

fn list_conversations(store: &ConversationStore) -> Result<Vec<ConversationRow>, String> {
    store
        .list_recent(ConversationListFilter {
            limit: None,
            ..Default::default()
        })
        .map_err(|e| format!("failed to list conversations: {e}"))
}

fn route_from_runtime_state(state: &serde_json::Value) -> Option<StoredDelegationRoute> {
    serde_json::from_value(state.get("rustRuntime")?.get("delegation")?.clone()).ok()
}

fn is_full_hex_id(input: &str) -> bool {
    input.len() == 64 && input.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_hex_prefix(input: &str) -> bool {
    input.len() == 10 && input.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tenex_conversations::NewMessage;

    const CHILD_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const FOLLOWUP_ID: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const CHILD_AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn resolves_followup_event_id_to_canonical_delegation() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("conversation.db");
        let mut store = ConversationStore::open(&db_path).unwrap();
        store
            .update_runtime_state(CHILD_ID, |state| {
                *state = serde_json::json!({
                    "rustRuntime": {
                        "delegation": {
                            "childAgentPubkey": CHILD_AGENT,
                            "childConversationId": CHILD_ID
                        }
                    }
                });
            })
            .unwrap();
        store
            .append_message(
                CHILD_ID,
                &NewMessage {
                    record_id: format!("event:{FOLLOWUP_ID}"),
                    nostr_event_id: Some(FOLLOWUP_ID.to_string()),
                    author_pubkey: CHILD_AGENT.to_string(),
                    sender_pubkey: None,
                    ral: None,
                    message_type: "text".to_string(),
                    role: Some("user".to_string()),
                    content: "followup".to_string(),
                    timestamp: None,
                    targeted_pubkeys: None,
                    sender_principal: None,
                    targeted_principals: None,
                    tool_data: None,
                    delegation_marker: None,
                    human_readable: None,
                    transcript_tool_attributes: None,
                },
            )
            .unwrap();

        let from_full = resolve_delegation(&db_path, FOLLOWUP_ID).unwrap();
        assert_eq!(from_full.canonical_id, CHILD_ID);
        assert_eq!(from_full.route.unwrap().child_agent_pubkey, CHILD_AGENT);

        let from_prefix = resolve_delegation(&db_path, &FOLLOWUP_ID[..10]).unwrap();
        assert_eq!(from_prefix.canonical_id, CHILD_ID);
        assert_eq!(from_prefix.route.unwrap().child_conversation_id, CHILD_ID);
    }
}

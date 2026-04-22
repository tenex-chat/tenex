use crate::inbound_envelope::{
    ChannelKind, ChannelRef, ExternalMessageRef, InboundEnvelope, InboundMetadata, PrincipalRef,
    RuntimeTransport,
};
use crate::nostr_event::SignedNostrEvent;

const PROJECT_ADDRESS_KIND: &str = "31933";
const PROJECT_ADDRESS_PUBKEY_HEX_LEN: usize = 64;

pub fn signed_event_to_inbound_envelope(event: &SignedNostrEvent) -> InboundEnvelope {
    let reply_target = tag_value_with_marker(event, "e", "root").or_else(|| tag_value(event, "e"));
    let mentioned_pubkeys = tag_values(event, "p");
    let recipients = if mentioned_pubkeys.is_empty() {
        tag_values(event, "p")
    } else {
        mentioned_pubkeys
    };
    let project_binding = tag_values(event, "a")
        .into_iter()
        .find(|value| is_project_address(value));
    let conversation_anchor = reply_target.unwrap_or(event.id.as_str());
    let channel = match project_binding {
        Some(project_binding) => ChannelRef {
            id: format!("nostr:project:{project_binding}"),
            transport: RuntimeTransport::Nostr,
            kind: ChannelKind::Project,
            project_binding: Some(project_binding.to_string()),
        },
        None => ChannelRef {
            id: format!("nostr:conversation:{conversation_anchor}"),
            transport: RuntimeTransport::Nostr,
            kind: ChannelKind::Conversation,
            project_binding: None,
        },
    };

    let article_references = non_empty_vec(
        tag_values(event, "a")
            .into_iter()
            .filter(|value| value.starts_with("30023:"))
            .map(str::to_string)
            .collect(),
    );
    let reply_targets = non_empty_vec(
        tag_values(event, "e")
            .into_iter()
            .map(str::to_string)
            .collect(),
    );
    let skill_event_ids = non_empty_vec(
        tag_values(event, "skill")
            .into_iter()
            .map(str::to_string)
            .collect(),
    );

    InboundEnvelope {
        transport: RuntimeTransport::Nostr,
        principal: PrincipalRef {
            id: principal_id(&event.pubkey),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: Some(event.pubkey.clone()),
            display_name: None,
            username: None,
            kind: None,
        },
        channel,
        message: ExternalMessageRef {
            id: message_id(&event.id),
            transport: RuntimeTransport::Nostr,
            native_id: event.id.clone(),
            reply_to_id: reply_target.map(message_id),
        },
        recipients: recipients
            .into_iter()
            .map(|pubkey| PrincipalRef {
                id: principal_id(pubkey),
                transport: RuntimeTransport::Nostr,
                linked_pubkey: Some(pubkey.to_string()),
                display_name: None,
                username: None,
                kind: None,
            })
            .collect(),
        content: event.content.clone(),
        occurred_at: event.created_at.min(i64::MAX as u64) as i64,
        capabilities: vec![
            "fanout-recipient-tags".to_string(),
            "project-routing-a-tag".to_string(),
            "threaded-replies".to_string(),
        ],
        metadata: InboundMetadata {
            event_kind: Some(event.kind.min(i64::MAX as u64) as i64),
            event_tag_count: Some(event.tags.len() as u64),
            tool_name: tag_value(event, "tool").map(str::to_string),
            status_value: tag_value(event, "status").map(str::to_string),
            branch_name: tag_value(event, "branch").map(str::to_string),
            variant_override: tag_value(event, "variant").map(str::to_string),
            team_name: tag_value(event, "team").map(str::to_string),
            article_references,
            reply_targets,
            delegation_parent_conversation_id: tag_value(event, "delegation").map(str::to_string),
            skill_event_ids,
            ..InboundMetadata::default()
        },
    }
}

fn principal_id(pubkey: &str) -> String {
    format!("nostr:{pubkey}")
}

fn message_id(event_id: &str) -> String {
    format!("nostr:{event_id}")
}

fn tag_value<'a>(event: &'a SignedNostrEvent, tag_name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some(tag_name))
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

fn tag_value_with_marker<'a>(
    event: &'a SignedNostrEvent,
    tag_name: &str,
    marker: &str,
) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| {
            tag.first().map(String::as_str) == Some(tag_name)
                && tag.get(3).map(String::as_str) == Some(marker)
        })
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

fn tag_values<'a>(event: &'a SignedNostrEvent, tag_name: &str) -> Vec<&'a str> {
    event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(tag_name))
        .filter_map(|tag| tag.get(1))
        .map(String::as_str)
        .collect()
}

fn is_project_address(value: &str) -> bool {
    let mut parts = value.splitn(3, ':');
    let Some(kind) = parts.next() else {
        return false;
    };
    let Some(pubkey) = parts.next() else {
        return false;
    };
    let Some(identifier) = parts.next() else {
        return false;
    };

    kind == PROJECT_ADDRESS_KIND
        && pubkey.len() == PROJECT_ADDRESS_PUBKEY_HEX_LEN
        && pubkey.chars().all(|ch| ch.is_ascii_hexdigit())
        && !identifier.is_empty()
}

fn non_empty_vec(values: Vec<String>) -> Option<Vec<String>> {
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbound_envelope::{ChannelKind, RuntimeTransport};

    #[test]
    fn nostr_event_with_project_binding_matches_ts_adapter_shape() {
        let event = signed_event(vec![
            vec!["e", "reply-event", "", "reply"],
            vec!["e", "root-event", "", "root"],
            vec!["p", "agent-pubkey"],
            vec![
                "a",
                "31933:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:TENEX-demo",
            ],
            vec!["a", "30023:author:article"],
            vec!["skill", "skill-event-id"],
            vec!["branch", "main"],
            vec!["team", "ops"],
            vec!["delegation", "delegation-conversation"],
        ]);

        let envelope = signed_event_to_inbound_envelope(&event);

        assert_eq!(envelope.transport, RuntimeTransport::Nostr);
        assert_eq!(envelope.principal.id, "nostr:sender-pubkey");
        assert_eq!(envelope.channel.kind, ChannelKind::Project);
        assert_eq!(
            envelope.channel.id,
            "nostr:project:31933:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:TENEX-demo"
        );
        assert_eq!(envelope.message.id, "nostr:event-alpha");
        assert_eq!(
            envelope.message.reply_to_id.as_deref(),
            Some("nostr:root-event")
        );
        assert_eq!(envelope.recipients[0].id, "nostr:agent-pubkey");
        assert_eq!(envelope.metadata.event_kind, Some(1));
        assert_eq!(envelope.metadata.event_tag_count, Some(9));
        assert_eq!(envelope.metadata.branch_name.as_deref(), Some("main"));
        assert_eq!(envelope.metadata.team_name.as_deref(), Some("ops"));
        assert_eq!(
            envelope.metadata.article_references,
            Some(vec!["30023:author:article".to_string()])
        );
        assert_eq!(
            envelope.metadata.reply_targets,
            Some(vec!["reply-event".to_string(), "root-event".to_string()])
        );
        assert_eq!(
            envelope.metadata.skill_event_ids,
            Some(vec!["skill-event-id".to_string()])
        );
        assert_eq!(
            envelope
                .metadata
                .delegation_parent_conversation_id
                .as_deref(),
            Some("delegation-conversation")
        );
    }

    #[test]
    fn nostr_event_without_project_uses_reply_or_event_as_conversation_anchor() {
        let reply = signed_event(vec![vec!["e", "reply-event"]]);
        let reply_envelope = signed_event_to_inbound_envelope(&reply);
        assert_eq!(reply_envelope.channel.id, "nostr:conversation:reply-event");
        assert_eq!(
            reply_envelope.message.reply_to_id.as_deref(),
            Some("nostr:reply-event")
        );

        let root = signed_event(Vec::new());
        let root_envelope = signed_event_to_inbound_envelope(&root);
        assert_eq!(root_envelope.channel.id, "nostr:conversation:event-alpha");
        assert!(root_envelope.message.reply_to_id.is_none());
    }

    fn signed_event(tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: "event-alpha".to_string(),
            pubkey: "sender-pubkey".to_string(),
            created_at: 1_710_000_700,
            kind: 1,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: "hello from nostr".to_string(),
            sig: "sig".to_string(),
        }
    }
}

use super::*;
use crate::intent::{LlmUsage, ToolUseIntent};
use crate::refs::{MessageRef, PrincipalKind, PrincipalRef, ProjectRef};
use nostr::{EventId, Keys};

fn test_ctx() -> EncodingContext {
    let keys = Keys::generate();
    EncodingContext {
        project: ProjectRef {
            author: keys.public_key(),
            d_tag: "demo".into(),
        },
        conversation_root: Some(ConversationRef::Nostr {
            root_event_id: EventId::all_zeros(),
        }),
        triggering_message: Some(MessageRef::Nostr {
            event_id: EventId::all_zeros(),
        }),
        completion_recipient: None,
        triggering_principal: PrincipalRef::Nostr {
            pubkey: keys.public_key(),
            kind: PrincipalKind::Human,
            display_name: None,
        },
        ral: 1,
        model: Some("openai:gpt-4".into()),
        cost_usd: Some(0.001234),
        execution_time_ms: Some(1500),
        llm_runtime_ms: Some(1200),
        llm_runtime_total_ms: None,
        completion_project_a_tags: Vec::new(),
        branch: None,
        team: None,
    }
}

fn signed_tags(builder: EventBuilder) -> Vec<Vec<String>> {
    let keys = Keys::generate();
    let event = builder.sign_with_keys(&keys).expect("sign");
    event.tags.iter().map(|t| t.clone().to_vec()).collect()
}

#[test]
fn completion_has_status_and_p_tag() {
    let ctx = test_ctx();
    let intent = CompletionIntent {
        content: "done".into(),
        usage: Some(LlmUsage {
            input_tokens: Some(100),
            output_tokens: Some(50),
            ..Default::default()
        }),
        metadata: None,
    };
    let builders = NostrEncoder::encode(&Intent::Completion(intent), &ctx).expect("encode");
    assert_eq!(builders.len(), 1);
    let tags = signed_tags(builders.into_iter().next().unwrap());
    assert!(tags.iter().any(|t| t[0] == "status" && t[1] == "completed"));
    assert!(tags.iter().any(|t| t[0] == "p"));
    assert!(tags
        .iter()
        .any(|t| t[0] == "e" && t.len() >= 4 && t[3] == "root"));
    assert!(tags
        .iter()
        .any(|t| t[0] == "llm-prompt-tokens" && t[1] == "100"));
    assert!(tags
        .iter()
        .any(|t| t[0] == "llm-total-tokens" && t[1] == "150"));
}

#[test]
fn completion_includes_additional_project_a_tags() {
    let mut ctx = test_ctx();
    let source_project = format!("31933:{}:source", Keys::generate().public_key().to_hex());
    ctx.completion_project_a_tags = vec![source_project.clone()];
    let intent = CompletionIntent {
        content: "done".into(),
        usage: None,
        metadata: None,
    };
    let builders = NostrEncoder::encode(&Intent::Completion(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    let expected = vec!["a".to_string(), source_project];

    assert!(tags.iter().any(|tag| tag == &expected));
}

#[test]
fn conversation_omits_p_and_status() {
    let ctx = test_ctx();
    let intent = ConversationIntent {
        content: "thinking".into(),
        is_reasoning: true,
        usage: None,
        metadata: None,
    };
    let builders = NostrEncoder::encode(&Intent::Conversation(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    assert!(!tags.iter().any(|t| t[0] == "p"));
    assert!(!tags.iter().any(|t| t[0] == "status"));
    assert!(tags.iter().any(|t| t[0] == "reasoning"));
}

#[test]
fn tool_use_emits_q_tags_and_tool_args() {
    let ctx = test_ctx();
    let id = EventId::all_zeros();
    let intent = ToolUseIntent {
        tool_name: "delegate".into(),
        content: "delegating".into(),
        args_json: Some("{\"x\":1}".into()),
        referenced_messages: vec![MessageRef::Nostr { event_id: id }],
        usage: None,
        extra_tags: Vec::new(),
    };
    let builders = NostrEncoder::encode(&Intent::ToolUse(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    assert!(tags.iter().any(|t| t[0] == "tool" && t[1] == "delegate"));
    assert!(tags
        .iter()
        .any(|t| t[0] == "tool-args" && t[1] == "{\"x\":1}"));
    assert!(tags.iter().any(|t| t[0] == "q"));
}

#[test]
fn threaded_events_emit_root_and_reply_tags() {
    let ctx = test_ctx();
    let intent = ConversationIntent {
        content: "hi".into(),
        is_reasoning: false,
        usage: None,
        metadata: None,
    };
    let builders = NostrEncoder::encode(&Intent::Conversation(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    let e_tags: Vec<&Vec<String>> = tags.iter().filter(|t| t[0] == "e").collect();
    assert_eq!(e_tags.len(), 2, "expected one root and one reply e-tag");
    assert!(e_tags.iter().any(|t| t.len() >= 4 && t[3] == "root"));
    assert!(e_tags.iter().any(|t| t.len() >= 4 && t[3] == "reply"));
}

#[test]
fn publish_article_emits_kind_30023_with_required_tags() {
    let ctx = test_ctx();
    let intent = crate::intent::PublishArticleIntent {
        d_tag: "notes/2024-01-01".into(),
        document_tag: "notes".into(),
        title: "My Notes".into(),
        content: "# Hello\nWorld".into(),
    };
    let builders = NostrEncoder::encode(&Intent::PublishArticle(intent), &ctx).expect("encode");
    assert_eq!(builders.len(), 1);
    let tags = signed_tags(builders.into_iter().next().unwrap());
    assert!(tags
        .iter()
        .any(|t| t[0] == "d" && t[1] == "notes/2024-01-01"));
    assert!(tags.iter().any(|t| t[0] == "title" && t[1] == "My Notes"));
    assert!(tags.iter().any(|t| t[0] == "document" && t[1] == "notes"));
    assert!(tags
        .iter()
        .any(|t| t[0] == "a" && t[1].starts_with("31933:")));
    assert!(!tags.iter().any(|t| t[0] == "e"));
    assert!(!tags.iter().any(|t| t[0] == "p"));
}

#[test]
fn delegation_omits_e_root_and_prepends_label() {
    let mut ctx = test_ctx();
    ctx.triggering_message = None;
    let recipient_keys = Keys::generate();
    let intent = DelegationIntent {
        items: vec![crate::intent::DelegationRequest {
            recipient: PrincipalRef::Nostr {
                pubkey: recipient_keys.public_key(),
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            recipient_label: "@architect".into(),
            request: "Please review".into(),
            branch: None,
            commit: None,
            followup_of: None,
            extra_tags: Vec::new(),
        }],
    };
    let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
    assert_eq!(builders.len(), 1);
    let keys = Keys::generate();
    let event = builders
        .into_iter()
        .next()
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.clone().to_vec()).collect();
    assert!(!tags.iter().any(|t| t[0] == "e"));
    assert!(tags.iter().any(|t| t[0] == "p"));
    assert!(tags.iter().any(|t| t[0] == "delegation"));
    assert_eq!(event.content, "@architect: Please review");
}

#[test]
fn delegation_includes_extra_routing_tags() {
    let ctx = test_ctx();
    let recipient_keys = Keys::generate();
    let source_project = format!("31933:{}:source", Keys::generate().public_key().to_hex());
    let intent = DelegationIntent {
        items: vec![crate::intent::DelegationRequest {
            recipient: PrincipalRef::Nostr {
                pubkey: recipient_keys.public_key(),
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            recipient_label: "@worker".into(),
            request: "Please review".into(),
            branch: None,
            commit: None,
            followup_of: None,
            extra_tags: vec![vec!["a".to_string(), source_project.clone()]],
        }],
    };
    let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    let expected = vec!["a".to_string(), source_project];

    assert!(tags.iter().any(|tag| tag == &expected));
}

#[test]
fn delegation_emits_branch_and_commit_tags() {
    let ctx = test_ctx();
    let recipient_keys = Keys::generate();
    let intent = DelegationIntent {
        items: vec![crate::intent::DelegationRequest {
            recipient: PrincipalRef::Nostr {
                pubkey: recipient_keys.public_key(),
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            recipient_label: "@worker".into(),
            request: "Implement X".into(),
            branch: Some("feature/x".into()),
            commit: Some("deadbeefcafebabe1234567890abcdef12345678".into()),
            followup_of: None,
            extra_tags: Vec::new(),
        }],
    };
    let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
    let tags = signed_tags(builders.into_iter().next().unwrap());
    assert!(tags
        .iter()
        .any(|t| t[0] == "branch" && t[1] == "feature/x"));
    assert!(tags.iter().any(|t| {
        t[0] == "commit" && t[1] == "deadbeefcafebabe1234567890abcdef12345678"
    }));
}

#[test]
fn delegation_followup_uses_delegation_as_root() {
    let ctx = test_ctx();
    let recipient_keys = Keys::generate();
    let delegation_id =
        EventId::from_hex("1111111111111111111111111111111111111111111111111111111111111111")
            .unwrap();
    let intent = DelegationIntent {
        items: vec![crate::intent::DelegationRequest {
            recipient: PrincipalRef::Nostr {
                pubkey: recipient_keys.public_key(),
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            recipient_label: "@worker".into(),
            request: "Clarification".into(),
            branch: None,
            commit: None,
            followup_of: Some(MessageRef::Nostr {
                event_id: delegation_id,
            }),
            extra_tags: Vec::new(),
        }],
    };
    let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
    assert_eq!(builders.len(), 1);
    let tags = signed_tags(builders.into_iter().next().unwrap());

    assert!(tags.iter().any(|t| {
        t[0] == "e"
            && t.get(1).map(String::as_str) == Some(delegation_id.to_hex().as_str())
            && t.get(3).map(String::as_str) == Some("root")
    }));
    assert!(!tags.iter().any(|t| {
        t[0] == "e"
            && t.get(1).map(String::as_str) == Some(delegation_id.to_hex().as_str())
            && t.get(3).map(String::as_str) == Some("reply")
    }));
    assert!(!tags.iter().any(|t| t[0] == "delegation"));
    assert!(tags.iter().any(|t| t[0] == "p"));
}

/// Helper for self-routing assertions: encode a builder, sign with the same
/// keypair the encoder placed in the recipient slot, and return the tags. The
/// nostr crate strips author-matching `#p` tags by default, so any encoder
/// site that intends `#p` as routing must opt in to self-tagging.
fn signed_with(keys: &Keys, builder: EventBuilder) -> Vec<Vec<String>> {
    builder
        .sign_with_keys(keys)
        .expect("sign")
        .tags
        .iter()
        .map(|t| t.clone().to_vec())
        .collect()
}

#[test]
fn self_completion_keeps_p_tag_when_triggering_principal_equals_signer() {
    let signer_keys = Keys::generate();
    let mut ctx = test_ctx();
    ctx.triggering_principal = PrincipalRef::Nostr {
        pubkey: signer_keys.public_key(),
        kind: PrincipalKind::Agent,
        display_name: None,
    };
    ctx.completion_recipient = None;
    let intent = crate::intent::CompletionIntent {
        content: "done".into(),
        usage: None,
        metadata: None,
    };
    let builders = NostrEncoder::encode(&Intent::Completion(intent), &ctx).expect("encode");
    let tags = signed_with(&signer_keys, builders.into_iter().next().unwrap());
    let p_tags: Vec<&Vec<String>> = tags.iter().filter(|t| t[0] == "p").collect();
    assert_eq!(
        p_tags.len(),
        1,
        "self-completion must keep the recipient p-tag for routing back through the delegation route; got tags={tags:?}"
    );
    assert_eq!(p_tags[0][1], signer_keys.public_key().to_hex());
}

#[test]
fn self_tool_use_keeps_p_tag_when_triggering_principal_equals_signer() {
    let signer_keys = Keys::generate();
    let mut ctx = test_ctx();
    ctx.triggering_principal = PrincipalRef::Nostr {
        pubkey: signer_keys.public_key(),
        kind: PrincipalKind::Agent,
        display_name: None,
    };
    let intent = ToolUseIntent {
        tool_name: "self_delegate".into(),
        content: String::new(),
        args_json: Some("{}".into()),
        referenced_messages: vec![MessageRef::Nostr {
            event_id: EventId::all_zeros(),
        }],
        usage: None,
        extra_tags: Vec::new(),
    };
    let builders = NostrEncoder::encode(&Intent::ToolUse(intent), &ctx).expect("encode");
    // tool_use does not add a `p` tag for the principal directly, but the
    // builder must still allow self-tagging because conversation tags can
    // include the signer's pubkey through `triggering_principal`. This test
    // locks in the no-strip behavior so any future refactor that adds a `p`
    // routing tag here keeps the tag.
    let tags = signed_with(&signer_keys, builders.into_iter().next().unwrap());
    assert!(
        tags.iter()
            .any(|t| t[0] == "tool" && t[1] == "self_delegate"),
        "expected tool=self_delegate tag; got tags={tags:?}"
    );
}

#[test]
fn self_ask_keeps_p_tag_when_recipient_equals_signer() {
    let signer_keys = Keys::generate();
    let ctx = test_ctx();
    let intent = crate::intent::AskIntent {
        recipient: PrincipalRef::Nostr {
            pubkey: signer_keys.public_key(),
            kind: PrincipalKind::Agent,
            display_name: None,
        },
        title: "self-question".into(),
        context: "context".into(),
        questions: vec![],
    };
    let builders = NostrEncoder::encode(&Intent::Ask(intent), &ctx).expect("encode");
    let tags = signed_with(&signer_keys, builders.into_iter().next().unwrap());
    let p_tags: Vec<&Vec<String>> = tags.iter().filter(|t| t[0] == "p").collect();
    assert_eq!(
        p_tags.len(),
        1,
        "self-ask must keep the recipient p-tag; got tags={tags:?}"
    );
    assert_eq!(p_tags[0][1], signer_keys.public_key().to_hex());
}

#[test]
fn self_delegation_keeps_p_tag_when_recipient_equals_signer() {
    // Self-delegation: the agent emits a delegation whose recipient pubkey is
    // its own pubkey. The encoded event still has to carry the recipient `p`
    // tag — the runtime's `directed` filter (authors AND #p) is what wakes
    // the agent up for the follow-on invocation. Without the p-tag, a
    // self-delegation never re-invokes the agent.
    let ctx = test_ctx();
    let signer_keys = Keys::generate();
    let intent = DelegationIntent {
        items: vec![crate::intent::DelegationRequest {
            recipient: PrincipalRef::Nostr {
                pubkey: signer_keys.public_key(),
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            recipient_label: "@self".into(),
            request: "Reply with done.".into(),
            branch: None,
            commit: None,
            followup_of: None,
            extra_tags: Vec::new(),
        }],
    };
    let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
    let event = builders
        .into_iter()
        .next()
        .unwrap()
        .sign_with_keys(&signer_keys)
        .expect("sign");
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.clone().to_vec()).collect();
    let p_tags: Vec<&Vec<String>> = tags.iter().filter(|t| t[0] == "p").collect();
    assert_eq!(
        p_tags.len(),
        1,
        "self-delegation must include exactly one p-tag for the recipient (== signer); got tags={tags:?}"
    );
    assert_eq!(p_tags[0][1], signer_keys.public_key().to_hex());
}

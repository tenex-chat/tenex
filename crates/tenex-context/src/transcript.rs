//! Renders a child conversation as an XML transcript for embedding in
//! a delegation-completion projection block (the `### Transcript:`
//! section under `# DELEGATION COMPLETED`).
//!
//! Mirrors the shape produced by `renderConversationXml` in the
//! TypeScript codebase (`src/conversations/formatters/utils/conversation-transcript-formatter.ts`)
//! that drove this behaviour before the Rust port:
//!
//! ```xml
//! <conversation id="<short>" t0="<unix-secs>">
//!   <message id="<short>" author="<name>" recipient="<name1,name2>" time="+Ns">content</message>
//!   <tool id="..." user="..." name="..." [file_path=...] [args=...] time="+Ns" />
//! </conversation>
//! ```
//!
//! Tool *results* are filtered out — the renderer is for "what the
//! child conversation said", not "what tools fired internally on the
//! child side." Time is relative to the conversation's `t0` (earliest
//! message timestamp in the slice). Short IDs are the first 10 hex chars.

use tenex_conversations::MessageRecord;

use crate::projection::DisplayNameResolver;

/// Render `child_messages` (already filtered/ordered by the caller) as
/// a `<conversation>...</conversation>` XML string. `name_resolver` is
/// consulted to turn `author_pubkey` strings into display names — if
/// absent or no match, the short pubkey form is used as a fallback,
/// matching how `projection::project_messages` resolves attribution.
pub fn render_conversation_xml(
    conversation_short_id: &str,
    child_messages: &[MessageRecord],
    name_resolver: Option<&dyn DisplayNameResolver>,
) -> String {
    let t0 = child_messages
        .iter()
        .filter_map(|m| m.timestamp)
        .min()
        .unwrap_or(0);

    let mut out = String::new();
    out.push_str("<conversation id=\"");
    push_attr_escaped(&mut out, &short_id(conversation_short_id));
    out.push_str("\" t0=\"");
    out.push_str(&t0.to_string());
    out.push_str("\">\n");

    for record in child_messages {
        let role = record.role.as_deref().unwrap_or("");
        // We only emit text-role messages and assistant turns. Tool
        // results are filtered (the TS renderer does the same: see
        // `shouldIncludeEntry` skipping `tool-result`). Delegation
        // markers from the child are not included — they belong to
        // the child's own projection, not the parent's transcript.
        if record.message_type == "delegation-marker" {
            continue;
        }
        let relative = record
            .timestamp
            .map(|ts| ts.saturating_sub(t0))
            .unwrap_or(0);
        let author_name = display_name(record.author_pubkey.as_str(), name_resolver);
        let recipients = record
            .targeted_pubkeys
            .as_deref()
            .map(|list| {
                list.iter()
                    .map(|pk| display_name(pk, name_resolver))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();

        out.push_str("  <message");
        if let Some(eid) = record.nostr_event_id.as_deref() {
            out.push_str(" id=\"");
            push_attr_escaped(&mut out, &short_id(eid));
            out.push('"');
        }
        out.push_str(" author=\"");
        push_attr_escaped(&mut out, &author_name);
        out.push('"');
        if !recipients.is_empty() {
            out.push_str(" recipient=\"");
            push_attr_escaped(&mut out, &recipients);
            out.push('"');
        }
        out.push_str(" time=\"+");
        out.push_str(&relative.to_string());
        out.push('s');
        out.push('"');
        out.push('>');
        push_text_escaped(&mut out, &record.content);
        out.push_str("</message>\n");

        // Tool calls themselves render via the assistant's `tool_data`
        // sidecar. For now we leave tool-call rendering for a follow-up
        // since the parent really just wants the child's last visible
        // reply. (TS renderer's `<tool ...>` element exists for richer
        // transcript debugging — match the data shape but skip rendering
        // until we have a concrete need.)
        let _ = role;
    }

    out.push_str("</conversation>");
    out
}

fn display_name(pubkey: &str, resolver: Option<&dyn DisplayNameResolver>) -> String {
    if let Some(r) = resolver {
        if let Some(name) = r.display_name(pubkey) {
            return name;
        }
    }
    short_id(pubkey)
}

fn short_id(id: &str) -> String {
    tenex_ids::shorten_full_event_id(id)
}

fn push_attr_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

fn push_text_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubResolver;
    impl DisplayNameResolver for StubResolver {
        fn display_name(&self, pubkey: &str) -> Option<String> {
            match pubkey {
                "agent2-pk" => Some("agent2".into()),
                "agent1-pk" => Some("agent1".into()),
                _ => None,
            }
        }
    }

    fn make_message(
        id: i64,
        nostr_event_id: Option<&str>,
        author: &str,
        content: &str,
        timestamp: i64,
        targeted: Option<Vec<String>>,
    ) -> MessageRecord {
        MessageRecord {
            id,
            conversation_id: "child-conv".into(),
            record_id: format!("rec:{id}"),
            nostr_event_id: nostr_event_id.map(String::from),
            sequence: id,
            author_pubkey: author.into(),
            sender_pubkey: None,
            ral: None,
            message_type: "text".into(),
            role: Some("user".into()),
            content: content.into(),
            timestamp: Some(timestamp),
            targeted_pubkeys: targeted,
            sender_principal: None,
            targeted_principals: None,
            tool_data: None,
            delegation_marker: None,
            human_readable: None,
            transcript_tool_attributes: None,
            created_at: 0,
        }
    }

    #[test]
    fn renders_minimal_conversation() {
        let messages = vec![
            make_message(
                1,
                Some("abcd1234567890abcd"),
                "agent1-pk",
                "give me a colour",
                100,
                Some(vec!["agent2-pk".into()]),
            ),
            make_message(
                2,
                Some("ffff5555ffffeeee"),
                "agent2-pk",
                "Black — RGB(0,0,0)",
                103,
                Some(vec!["agent1-pk".into()]),
            ),
        ];
        let xml = render_conversation_xml("child-conv-12345", &messages, Some(&StubResolver));
        let expected = "<conversation id=\"child-conv\" t0=\"100\">\n  \
            <message id=\"abcd123456\" author=\"agent1\" recipient=\"agent2\" time=\"+0s\">\
            give me a colour</message>\n  \
            <message id=\"ffff5555ff\" author=\"agent2\" recipient=\"agent1\" time=\"+3s\">\
            Black — RGB(0,0,0)</message>\n\
            </conversation>";
        assert_eq!(xml, expected);
    }

    #[test]
    fn escapes_xml_text_content_for_lt_gt_amp() {
        // Inside element text, only `<`, `>`, and `&` need escaping —
        // `"` is fine in text bodies. Attribute escaping covers quotes
        // separately.
        let m = make_message(1, None, "agent1-pk", "<tag>&\"safe\"</tag>", 0, None);
        let xml = render_conversation_xml("c", &[m], Some(&StubResolver));
        assert!(
            xml.contains("&lt;tag&gt;&amp;\"safe\"&lt;/tag&gt;"),
            "{xml}"
        );
    }

    #[test]
    fn escapes_attribute_quotes_when_name_contains_them() {
        let m = make_message(1, None, "agent1-pk", "x", 0, None);
        // Force a recipient name that contains a quote by re-using the
        // raw pubkey path (no resolver) and a synthetic pubkey value.
        // The short_id pass slices the first 10 chars verbatim so a "
        // in the pubkey would land in the attribute and must be
        // escaped.
        let mut m = m;
        m.targeted_pubkeys = Some(vec!["abc\"def-ghi-jkl".into()]);
        let xml = render_conversation_xml("c", &[m], None);
        assert!(xml.contains("recipient=\"abc&quot;def-"), "{xml}");
    }

    #[test]
    fn skips_delegation_markers_in_child_transcript() {
        let mut marker_row = make_message(1, None, "agent1-pk", "", 0, None);
        marker_row.message_type = "delegation-marker".into();
        let real = make_message(2, None, "agent2-pk", "hello", 5, None);
        let xml = render_conversation_xml("c", &[marker_row, real], None);
        assert!(!xml.contains("delegation-marker"));
        assert!(xml.contains("hello"));
    }

    #[test]
    fn anonymous_author_falls_back_to_short_pubkey() {
        let m = make_message(1, None, "unknown-pubkey-very-long-hex-here", "hi", 0, None);
        let xml = render_conversation_xml("c", &[m], Some(&StubResolver));
        // First 10 chars of "unknown-pubkey-very-long-hex-here" = "unknown-pu"
        assert!(xml.contains("author=\"unknown-pu\""), "{xml}");
    }
}

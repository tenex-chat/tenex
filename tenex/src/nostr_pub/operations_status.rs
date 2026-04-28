//! kind:24133 `TenexOperationsStatus` — per-conversation agent activity.
//!
//! Mirrors `OperationsStatusService.publishConversationStatus`
//! (src/services/status/OperationsStatusService.ts).
//!
//! Event shape:
//!
//! ```text
//! kind    = 24133
//! content = ""
//! tags    = ["e", <conversation_id>]
//!         + ["P", <whitelisted_pk>]...   (uppercase P — whitelisted human users)
//!         + ["p", <active_agent_pk>]...  (lowercase p — actively running agents)
//!         + ["a", "31933:<owner_pk>:<d_tag>"]
//! ```
//!
//! An empty `active_agent_pubkeys` slice signals a cleanup event (no agents
//! currently working on this conversation).
//!
//! Signed with the backend signer.

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Keys, Kind, Tag};

const KIND: u16 = 24133;

/// Build (but do not send) a kind:24133 operations status event.
///
/// Pass an empty `active_agent_pubkeys` slice to emit a cleanup event.
pub fn build_operations_status_event(
    keys: &Keys,
    conv_id: &str,
    project_ref: &str,
    whitelisted_pubkeys: &[String],
    active_agent_pubkeys: &[&str],
) -> Result<Event> {
    let mut tags: Vec<Tag> = Vec::new();

    tags.push(Tag::parse(["e", conv_id]).map_err(|e| anyhow!("e tag: {e}"))?);

    for pk in whitelisted_pubkeys {
        tags.push(Tag::parse(["P", pk.as_str()]).map_err(|e| anyhow!("P tag: {e}"))?);
    }

    for pk in active_agent_pubkeys {
        tags.push(Tag::parse(["p", pk]).map_err(|e| anyhow!("p tag: {e}"))?);
    }

    tags.push(Tag::parse(["a", project_ref]).map_err(|e| anyhow!("a tag: {e}"))?);

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign operations status event: {e}"))?;

    Ok(event)
}

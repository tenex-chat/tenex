//! Transport-tagged reference types.
//!
//! Every reference (principal, conversation, message, project) is an enum keyed
//! by transport. Today only the `Nostr` variant exists; new transports land as
//! additional variants. The exhaustive-match check is the seam — when a Telegram
//! variant is added, the compiler lists every encoder arm that needs updating.

use nostr::{EventId, PublicKey};
use serde::{Deserialize, Serialize};

/// An identity addressable on some transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum PrincipalRef {
    Nostr {
        pubkey: PublicKey,
        kind: PrincipalKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
    },
}

impl PrincipalRef {
    /// Convenience constructor for a Nostr agent principal.
    pub fn nostr_agent(pubkey: PublicKey) -> Self {
        Self::Nostr { pubkey, kind: PrincipalKind::Agent, display_name: None }
    }

    /// Convenience constructor for a Nostr human principal.
    pub fn nostr_human(pubkey: PublicKey) -> Self {
        Self::Nostr { pubkey, kind: PrincipalKind::Human, display_name: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    Agent,
    Human,
    System,
}

/// A conversation thread root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum ConversationRef {
    Nostr { root_event_id: EventId },
}

/// A previously published message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum MessageRef {
    Nostr { event_id: EventId },
}

/// A project handle. The `coordinate()` method renders the canonical
/// `kind:pubkey:dtag` string used in NIP-33 a-tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRef {
    pub author: PublicKey,
    pub d_tag: String,
}

impl ProjectRef {
    /// NIP-33 a-tag value for kind:31933.
    pub fn coordinate(&self) -> String {
        format!("31933:{}:{}", self.author.to_hex(), self.d_tag)
    }
}

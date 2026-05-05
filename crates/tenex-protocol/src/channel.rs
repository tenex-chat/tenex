//! [`Channel`] trait, [`InboundSource`] trait, [`InboundEnvelope`] type.
//!
//! `Channel` is the outbound abstraction: take an [`Intent`](crate::Intent) +
//! [`EncodingContext`](crate::EncodingContext), produce one or more wire
//! messages. `InboundSource` is the inverse: yield decoded
//! [`InboundEnvelope`]s as they arrive on whatever transport.

use async_trait::async_trait;

use crate::context::EncodingContext;
use crate::intent::Intent;
use crate::refs::{ConversationRef, MessageRef, PrincipalRef};

/// Outbound transport.
///
/// One implementation per channel: [`crate::nostr::NostrChannel`] today; future
/// `NostrDmChannel`, `TelegramChannel`, `SlackChannel` are additive. The single
/// `send(Intent)` method (rather than per-intent methods) keeps the trait stable
/// as new intents land and lets middleware wrappers (logging, retry, multiplex)
/// be written generically.
#[async_trait]
pub trait Channel: Send + Sync {
    /// Stable channel identifier, suitable for logging/tracing.
    fn name(&self) -> &'static str;

    /// Public identity of the agent on this channel.
    fn identity(&self) -> &PrincipalRef;

    /// Encode + sign + dispatch the intent. Returns one [`MessageRef`] per
    /// emitted wire message (delegation produces N).
    async fn send(
        &self,
        intent: Intent,
        ctx: &EncodingContext,
    ) -> Result<Vec<MessageRef>, ChannelError>;
}

#[derive(Debug, thiserror::Error)]
pub enum ChannelError {
    #[error("intent {0} not supported on this channel")]
    Unsupported(&'static str),
    #[error("encode: {0}")]
    Encode(String),
    #[error("sign: {0}")]
    Sign(String),
    #[error("transport: {0}")]
    Transport(#[source] anyhow::Error),
}

/// Inbound transport — async source of decoded envelopes.
#[async_trait]
pub trait InboundSource: Send {
    /// Yield the next inbound envelope. `Ok(None)` indicates a clean end-of-stream.
    async fn next(&mut self) -> anyhow::Result<Option<InboundEnvelope>>;
}

/// Decoded inbound message, transport-tagged.
///
/// Mirrors the TypeScript `InboundEnvelope` at
/// `src/events/runtime/InboundEnvelope.ts`. Values are filled by per-transport
/// decoders; consumers above the protocol layer treat envelopes uniformly.
#[derive(Debug, Clone)]
pub struct InboundEnvelope {
    pub channel: &'static str,
    pub principal: PrincipalRef,
    pub conversation: ConversationRef,
    pub message: MessageRef,
    pub recipients: Vec<PrincipalRef>,
    pub content: String,
    pub occurred_at: u64,
    pub root: MessageRef,
    pub reply_to: Option<MessageRef>,
    pub metadata: InboundMetadata,
}

/// Telegram context carried on inbound events routed via the Telegram daemon.
#[derive(Debug, Clone)]
pub struct TelegramTransportMetadata {
    pub chat_id: String,
    pub message_id: String,
    /// Set only for group/supergroup threads.
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct InboundMetadata {
    pub event_kind: Option<u32>,
    pub tool_name: Option<String>,
    pub status: Option<String>,
    pub branch: Option<String>,
    /// Expected git commit hash on `branch`. Set when a cross-host delegation
    /// pinned the worktree to a specific commit; the receiver syncs to it.
    pub commit: Option<String>,
    pub variant_override: Option<String>,
    pub team: Option<String>,
    pub article_references: Vec<String>,
    pub reply_targets: Vec<MessageRef>,
    pub delegation_parent_conversation: Option<ConversationRef>,
    pub is_kill_signal: bool,
    pub project_a_tags: Vec<String>,
    pub skills: Vec<String>,
    /// Populated when the event was injected by the Telegram daemon.
    pub telegram: Option<TelegramTransportMetadata>,
}

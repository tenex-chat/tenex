//! TENEX agent communication protocol.
//!
//! Defines transport-agnostic [`Intent`]s and a [`Channel`] trait that maps
//! intents onto wire messages. The canonical Nostr binding lives in [`nostr`].
//!
//! # Example
//!
//! ```no_run
//! use std::sync::Arc;
//! use tenex_protocol::{
//!     Channel, EncodingContext, Intent, InterventionReviewIntent,
//!     MessageRef, PrincipalKind, PrincipalRef, ProjectRef,
//!     nostr::NostrChannel,
//!     sink::StdoutNdjsonSink,
//! };
//!
//! # async fn run() -> anyhow::Result<()> {
//! let project = ProjectRef { author: nostr::Keys::generate().public_key(), d_tag: "demo".into() };
//! let channel: Arc<dyn Channel> = Arc::new(NostrChannel::from_nsec(
//!     "nsec1...",
//!     StdoutNdjsonSink::new(),
//! )?);
//! # let _ = channel;
//! # Ok(()) }
//! ```

pub mod channel;
pub mod context;
pub mod intent;
pub mod nostr;
pub mod refs;
pub mod sink;

pub use channel::{Channel, ChannelError, InboundEnvelope, InboundMetadata, InboundSource};
pub use context::EncodingContext;
pub use intent::{
    AskIntent, AskQuestion, CompletionIntent, ConversationIntent, DelegationIntent,
    DelegationRequest, ErrorIntent, Intent, InterventionReviewIntent, LessonIntent, LlmMetadata,
    LlmUsage, StreamTextDeltaIntent, ToolUseIntent,
};
pub use refs::{ConversationRef, MessageRef, PrincipalKind, PrincipalRef, ProjectRef};

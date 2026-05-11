//! Nostr binding for the agent protocol.
//!
//! Single concrete [`Channel`](crate::channel::Channel) implementation. Splits
//! into three pieces: a pure [`encoder`] (`Intent` → `EventBuilder`), the
//! [`channel::NostrChannel`] (encoder + signer + sink), and a
//! [`decoder`] (`Event` → `InboundEnvelope`).

pub mod acp_stdin_frame;
pub mod channel;
pub mod decoder;
pub mod encoder;
pub mod kinds;
pub mod stdin_source;
pub mod tags;

pub use acp_stdin_frame::{AcpStdinFrame, ACP_PROMPT_DONE_SENTINEL_KEY};
pub use channel::NostrChannel;
pub use decoder::{decode, DecodeError};
pub use encoder::{EncodeError, NostrEncoder};
pub use stdin_source::{read_one_from_stdin, StdinNdjsonSource};

#[cfg(feature = "relay")]
pub mod relay_source;
#[cfg(feature = "relay")]
pub use relay_source::RelaySource;

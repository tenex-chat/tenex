//! [`NostrChannel`]: encoder + signer + sink.
//!
//! Generic over `S: EventSink` so the same channel type serves both the
//! NDJSON-stdout consumer (`tenex-agent`) and the relay-publish consumer
//! (`tenex-intervention`). Encoding is a pure call into [`NostrEncoder`];
//! signing happens here once; delivery is delegated to the sink.

use std::sync::Arc;

use async_trait::async_trait;
use nostr::Keys;

use crate::channel::{Channel, ChannelError};
use crate::context::EncodingContext;
use crate::intent::Intent;
use crate::refs::{MessageRef, PrincipalKind, PrincipalRef};
use crate::sink::EventSink;

use super::encoder::NostrEncoder;

/// A Nostr [`Channel`]. Construct with [`NostrChannel::from_nsec`] or
/// [`NostrChannel::from_keys`]; pick a sink (stdout or relay) at construction.
pub struct NostrChannel<S: EventSink> {
    keys: Keys,
    sink: Arc<S>,
    identity: PrincipalRef,
}

impl<S: EventSink> NostrChannel<S> {
    pub fn from_nsec(nsec: &str, sink: S) -> anyhow::Result<Self> {
        let keys = Keys::parse(nsec)?;
        Ok(Self::from_keys(keys, sink))
    }

    pub fn from_keys(keys: Keys, sink: S) -> Self {
        let identity = PrincipalRef::Nostr {
            pubkey: keys.public_key(),
            kind: PrincipalKind::Agent,
            display_name: None,
        };
        Self { keys, sink: Arc::new(sink), identity }
    }

    pub fn pubkey(&self) -> nostr::PublicKey {
        self.keys.public_key()
    }
}

#[async_trait]
impl<S: EventSink + 'static> Channel for NostrChannel<S> {
    fn name(&self) -> &'static str {
        "nostr"
    }

    fn identity(&self) -> &PrincipalRef {
        &self.identity
    }

    async fn send(
        &self,
        intent: Intent,
        ctx: &EncodingContext,
    ) -> Result<Vec<MessageRef>, ChannelError> {
        let builders = NostrEncoder::encode(&intent, ctx)
            .map_err(|e| ChannelError::Encode(e.to_string()))?;

        let mut refs = Vec::with_capacity(builders.len());
        for builder in builders {
            let event = builder
                .sign_with_keys(&self.keys)
                .map_err(|e| ChannelError::Sign(e.to_string()))?;
            let id = event.id;
            self.sink
                .deliver(event)
                .await
                .map_err(ChannelError::Transport)?;
            refs.push(MessageRef::Nostr { event_id: id });
        }
        Ok(refs)
    }
}

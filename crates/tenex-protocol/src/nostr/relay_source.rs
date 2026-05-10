//! Subscribe to relays via `nostr-sdk`, decode each notification into an
//! [`InboundEnvelope`]. Available behind the `relay` feature.

use async_trait::async_trait;
use nostr_sdk::prelude::*;
use tokio::sync::{broadcast, mpsc};
use tracing::warn;

use crate::channel::{InboundEnvelope, InboundSource};

use super::decoder::decode;

/// Receives decoded envelopes from a `nostr-sdk` notification stream.
pub struct RelaySource {
    rx: mpsc::Receiver<InboundEnvelope>,
}

impl RelaySource {
    /// Spawn a task that consumes `client.notifications()` and pushes decoded
    /// envelopes through a channel. The caller controls relay setup and
    /// subscription filters; this source just decodes events as they arrive.
    pub fn from_client(client: Client, buffer: usize) -> Self {
        let (tx, rx) = mpsc::channel(buffer);
        let mut notifications = client.notifications();
        tokio::spawn(async move {
            loop {
                match notifications.recv().await {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if let Ok(envelope) = decode(&event) {
                            if tx.send(envelope).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!(dropped = n, "relay source consumer lagged");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Self { rx }
    }
}

#[async_trait]
impl InboundSource for RelaySource {
    async fn next(&mut self) -> anyhow::Result<Option<InboundEnvelope>> {
        Ok(self.rx.recv().await)
    }
}

//! Read NDJSON lines from stdin, decode each as a Nostr event, hand it back as
//! an [`InboundEnvelope`].
//!
//! Replaces `tenex-agent`'s ad-hoc `InputEvent` JSON parser. The frame format
//! is unchanged: one JSON object per line, where each object is a complete
//! Nostr event.

use async_trait::async_trait;
use nostr::{Event, JsonUtil};
use tokio::io::{AsyncBufReadExt, BufReader, Stdin};

use crate::channel::{InboundEnvelope, InboundSource};

use super::decoder::decode;

pub struct StdinNdjsonSource {
    reader: BufReader<Stdin>,
}

impl StdinNdjsonSource {
    pub fn new() -> Self {
        Self {
            reader: BufReader::new(tokio::io::stdin()),
        }
    }
}

impl Default for StdinNdjsonSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl InboundSource for StdinNdjsonSource {
    async fn next(&mut self) -> anyhow::Result<Option<InboundEnvelope>> {
        loop {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line).await?;
            if n == 0 {
                return Ok(None);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let event = Event::from_json(trimmed)
                .map_err(|e| anyhow::anyhow!("parse stdin nostr event: {e}"))?;
            let envelope = decode(&event)?;
            return Ok(Some(envelope));
        }
    }
}

/// Read exactly one event from stdin and return it. Convenience for
/// `tenex-agent`, which is invoked with one triggering event on stdin.
pub async fn read_one_from_stdin() -> anyhow::Result<InboundEnvelope> {
    let mut src = StdinNdjsonSource::new();
    src.next()
        .await?
        .ok_or_else(|| anyhow::anyhow!("no event on stdin"))
}

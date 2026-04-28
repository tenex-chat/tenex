//! Outbound delivery sinks. The encoded-and-signed event is handed to a sink
//! which writes it somewhere — stdout for one-shot agents, a relay client for
//! daemons, or a test buffer for unit tests.

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

/// Receives signed Nostr events and delivers them to whatever destination the
/// channel was configured for.
#[async_trait]
pub trait EventSink: Send + Sync {
    async fn deliver(&self, event: nostr::Event) -> anyhow::Result<()>;
}

/// NDJSON-on-stdout sink. One `event.as_json() + "\n"` per call. Mutex-guards
/// the underlying handle so concurrent emits never produce torn lines.
///
/// Used by `tenex-agent`, where the daemon reads NDJSON frames from the agent's
/// stdout. Compiles without `nostr-sdk` so the agent dependency graph stays
/// relay-free at the type-system level.
pub struct StdoutNdjsonSink {
    out: Mutex<tokio::io::Stdout>,
}

impl StdoutNdjsonSink {
    pub fn new() -> Self {
        Self { out: Mutex::new(tokio::io::stdout()) }
    }
}

impl Default for StdoutNdjsonSink {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl EventSink for StdoutNdjsonSink {
    async fn deliver(&self, event: nostr::Event) -> anyhow::Result<()> {
        use nostr::JsonUtil;
        let line = format!("{}\n", event.as_json());
        let mut out = self.out.lock().await;
        out.write_all(line.as_bytes()).await?;
        out.flush().await?;
        Ok(())
    }
}

/// In-memory sink that captures every delivered event. Useful for tests.
#[cfg(test)]
pub struct CapturingSink {
    pub events: Mutex<Vec<nostr::Event>>,
}

#[cfg(test)]
impl CapturingSink {
    pub fn new() -> Self {
        Self { events: Mutex::new(Vec::new()) }
    }
    pub async fn into_events(self) -> Vec<nostr::Event> {
        self.events.into_inner()
    }
}

#[cfg(test)]
#[async_trait]
impl EventSink for CapturingSink {
    async fn deliver(&self, event: nostr::Event) -> anyhow::Result<()> {
        self.events.lock().await.push(event);
        Ok(())
    }
}

/// Relay-publishing sink. Wraps `nostr_sdk::Client::send_event`. Available
/// behind the `relay` feature so consumers that must not open relay
/// connections (e.g. `tenex-agent`) cannot accidentally compile it in.
#[cfg(feature = "relay")]
pub struct RelaySink {
    client: nostr_sdk::Client,
}

#[cfg(feature = "relay")]
impl RelaySink {
    pub fn new(client: nostr_sdk::Client) -> Self {
        Self { client }
    }
}

#[cfg(feature = "relay")]
#[async_trait]
impl EventSink for RelaySink {
    async fn deliver(&self, event: nostr::Event) -> anyhow::Result<()> {
        self.client
            .send_event(&event)
            .await
            .map_err(|e| anyhow::anyhow!("relay send_event failed: {e}"))?;
        Ok(())
    }
}

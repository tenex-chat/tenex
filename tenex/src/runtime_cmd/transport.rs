//! Transport-bridge dispatch tee.
//!
//! When a transport bridge (e.g. `tenex-telegram`) opens a streaming
//! `DispatchTransport` connection on the runtime control socket, the runtime
//! attaches a [`TransportTee`] to the resulting [`DispatchJob`]. As the agent
//! emits events, the runtime additionally forwards each event to the bridge
//! so it can render the reply to the originating chat.
//!
//! The tee is `Clone` so it can travel through `DispatchJob::clone()` without
//! losing connection identity. Cloning bumps the inner refcount; the
//! [`Superseded`](tenex_protocol::DispatchTransportFrame::Superseded) frame is
//! only emitted when the *last* clone is dropped without having sent a
//! terminal frame — this is the signal that a queued dispatch was discarded
//! by [`DispatchCoordinator::finish_run`]'s newer-wins policy before
//! `run_agent` had a chance to run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tenex_protocol::{
    DispatchAcceptedFrame, DispatchEventFrame, DispatchTransportFrame, ErrorResponse,
};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone)]
pub struct TransportTee {
    inner: Arc<TransportTeeInner>,
}

struct TransportTeeInner {
    frames: UnboundedSender<DispatchTransportFrame>,
    terminal_sent: AtomicBool,
}

impl Drop for TransportTeeInner {
    fn drop(&mut self) {
        if !self.terminal_sent.swap(true, Ordering::SeqCst) {
            // Last clone dropped without a terminal frame: the dispatch was
            // queued and then discarded by the coordinator before running.
            let _ = self.frames.send(DispatchTransportFrame::Superseded);
        }
    }
}

impl TransportTee {
    pub fn new(frames: UnboundedSender<DispatchTransportFrame>) -> Self {
        Self {
            inner: Arc::new(TransportTeeInner {
                frames,
                terminal_sent: AtomicBool::new(false),
            }),
        }
    }

    pub fn send_accepted(&self, conversation_id: String, agent_pubkey: String) {
        let _ = self
            .inner
            .frames
            .send(DispatchTransportFrame::Accepted(DispatchAcceptedFrame {
                conversation_id,
                agent_pubkey,
            }));
    }

    pub fn send_event(&self, event_json: String) {
        let _ = self
            .inner
            .frames
            .send(DispatchTransportFrame::Event(DispatchEventFrame {
                event_json,
            }));
    }

    pub fn send_done(&self) {
        if !self.inner.terminal_sent.swap(true, Ordering::SeqCst) {
            let _ = self.inner.frames.send(DispatchTransportFrame::Done);
        }
    }

    pub fn send_error(&self, message: impl Into<String>) {
        if !self.inner.terminal_sent.swap(true, Ordering::SeqCst) {
            let _ = self
                .inner
                .frames
                .send(DispatchTransportFrame::Error(ErrorResponse {
                    message: message.into(),
                }));
        }
    }
}

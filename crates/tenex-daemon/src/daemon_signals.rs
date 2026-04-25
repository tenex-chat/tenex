//! Process-wide signal channels replacing `foreground_wake`.
//!
//! Each subsystem driver subscribes to exactly the signals it needs from this
//! module. The struct itself is never passed whole to any consumer — callers
//! extract the sender/receiver they need at construction time in `run_cli`.
//!
//! All mpsc channels are unbounded: every producer is already gated by an
//! on-disk write that bounds throughput, and a bounded `try_send` would have
//! no sane fallback (the event has already been persisted, so dropping the
//! wake produces silent data loss).

use std::sync::Arc;

use tokio::sync::{Notify, mpsc};

/// Sent when a new project is booted (i.e. a 24000 boot event is recorded).
#[derive(Debug, Clone)]
pub struct BootedProject {
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
}

/// Sent when a new dispatch record is appended to the dispatch queue.
#[derive(Debug, Clone)]
pub struct DispatchEnqueued;

/// Sent when a worker session task completes (successfully or otherwise).
#[derive(Debug, Clone)]
pub struct SessionCompletion;

/// Sent when a record is appended to the publish outbox.
#[derive(Debug, Clone)]
pub struct PublishEnqueued;

/// Sent when a RAL journal entry with status `Completed` is appended.
#[derive(Debug, Clone)]
pub struct RalCompletion {
    /// Journal sequence number of the completed entry.
    pub sequence: u64,
}

/// All signal producers. Construct once in `run_cli`, clone senders to producers.
///
/// `project_index_changed` is an `Arc<Notify>` shared between the producer
/// (nostr_ingress) and the consumer (project_status_supervisor, added in
/// commit 3). The Notify is wrapped in Arc so it can be cheaply cloned into
/// the ingress thread without requiring a separate channel.
pub struct DaemonSignals {
    /// Notified when the project event index gains a new entry.
    pub project_index_changed: Arc<Notify>,
    pub project_booted_tx: mpsc::UnboundedSender<BootedProject>,
    pub dispatch_enqueued_tx: mpsc::UnboundedSender<DispatchEnqueued>,
    pub session_completed_tx: mpsc::UnboundedSender<SessionCompletion>,
    pub publish_enqueued_tx: mpsc::UnboundedSender<PublishEnqueued>,
    pub ral_completed_tx: mpsc::UnboundedSender<RalCompletion>,
}

/// All channel receivers. Consumed one-per-driver in `run_cli`.
pub struct DaemonSignalReceivers {
    pub project_booted_rx: mpsc::UnboundedReceiver<BootedProject>,
    pub dispatch_enqueued_rx: mpsc::UnboundedReceiver<DispatchEnqueued>,
    pub session_completed_rx: mpsc::UnboundedReceiver<SessionCompletion>,
    pub publish_enqueued_rx: mpsc::UnboundedReceiver<PublishEnqueued>,
    pub ral_completed_rx: mpsc::UnboundedReceiver<RalCompletion>,
}

/// Create all signal channels. Returns (senders, receivers) to be distributed
/// in `run_cli`.
pub fn create_daemon_signals() -> (DaemonSignals, DaemonSignalReceivers) {
    let (project_booted_tx, project_booted_rx) = mpsc::unbounded_channel();
    let (dispatch_enqueued_tx, dispatch_enqueued_rx) = mpsc::unbounded_channel();
    let (session_completed_tx, session_completed_rx) = mpsc::unbounded_channel();
    let (publish_enqueued_tx, publish_enqueued_rx) = mpsc::unbounded_channel();
    let (ral_completed_tx, ral_completed_rx) = mpsc::unbounded_channel();

    (
        DaemonSignals {
            project_index_changed: Arc::new(Notify::new()),
            project_booted_tx,
            dispatch_enqueued_tx,
            session_completed_tx,
            publish_enqueued_tx,
            ral_completed_tx,
        },
        DaemonSignalReceivers {
            project_booted_rx,
            dispatch_enqueued_rx,
            session_completed_rx,
            publish_enqueued_rx,
            ral_completed_rx,
        },
    )
}

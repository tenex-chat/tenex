//! Process-wide signal channels for event-driven daemon coordination.
//!
//! Each subsystem driver subscribes to exactly the signals it needs from this
//! module. The struct itself is never passed whole to any consumer — callers
//! extract the sender/receiver they need at construction time in `run_cli`.
//!
//! All mpsc channels are unbounded: every producer is already gated by an
//! on-disk write that bounds throughput, and a bounded `try_send` would have
//! no sane fallback (the event has already been persisted, so dropping the
//! wake produces silent data loss).

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
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

/// Sent when a record is appended to the Telegram outbox.
#[derive(Debug, Clone)]
pub struct TelegramEnqueued;

/// All signal producers. Construct once in `run_cli`, clone senders to producers.
///
/// `project_index_changed` is an `Arc<Notify>` shared between the producer
/// (nostr_ingress) and the consumer (project_status_supervisor, added in
/// commit 3). The Notify is wrapped in Arc so it can be cheaply cloned into
/// the ingress thread without requiring a separate channel.
pub struct DaemonSignals {
    /// Notified when the project event index gains a new entry.
    pub project_index_changed: Arc<Notify>,
    /// Notified when any project's `schedules.json` changes on disk. Shared
    /// by all per-project scheduled-task driver tasks; an over-wake costs only
    /// a cheap re-read of the unchanged project's schedule file.
    pub project_schedules_changed: Arc<Notify>,
    pub project_booted_tx: mpsc::UnboundedSender<BootedProject>,
    pub dispatch_enqueued_tx: mpsc::UnboundedSender<DispatchEnqueued>,
    pub session_completed_tx: mpsc::UnboundedSender<SessionCompletion>,
    pub publish_enqueued_tx: mpsc::UnboundedSender<PublishEnqueued>,
    pub ral_completed_tx: mpsc::UnboundedSender<RalCompletion>,
    pub telegram_enqueued_tx: mpsc::UnboundedSender<TelegramEnqueued>,
}

/// All channel receivers. Consumed one-per-driver in `run_cli`.
pub struct DaemonSignalReceivers {
    pub project_booted_rx: mpsc::UnboundedReceiver<BootedProject>,
    pub dispatch_enqueued_rx: mpsc::UnboundedReceiver<DispatchEnqueued>,
    pub session_completed_rx: mpsc::UnboundedReceiver<SessionCompletion>,
    pub publish_enqueued_rx: mpsc::UnboundedReceiver<PublishEnqueued>,
    pub ral_completed_rx: mpsc::UnboundedReceiver<RalCompletion>,
    pub telegram_enqueued_rx: mpsc::UnboundedReceiver<TelegramEnqueued>,
}

/// Handle for the schedules-file watcher OS thread. Held by `run_cli`; on
/// shutdown the receiver is dropped and the watcher thread exits.
pub struct ScheduleWatcherHandle {
    pub stop_tx: crossbeam_channel::Sender<()>,
    pub join_handle: thread::JoinHandle<()>,
}

/// Spawn a background OS thread that watches `<tenex_base_dir>/projects/`
/// recursively. When any path matching `*/schedules.json` is created,
/// modified, or renamed, `project_schedules_changed` is fired so all
/// per-project scheduled-task driver tasks re-read their schedule files.
///
/// Uses an OS-level file watcher via the `notify` crate (kqueue on macOS,
/// inotify on Linux) so there's no polling.
pub fn spawn_schedule_watcher(
    tenex_base_dir: PathBuf,
    project_schedules_changed: Arc<Notify>,
) -> ScheduleWatcherHandle {
    let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(0);
    let join_handle = thread::spawn(move || {
        let projects_dir = tenex_base_dir.join("projects");
        // Create the directory if missing so the watcher has something to bind
        // to. The first booted project would otherwise create a parent dir
        // mkdir race.
        let _ = std::fs::create_dir_all(&projects_dir);

        let notify_clone = Arc::clone(&project_schedules_changed);
        let mut watcher = match notify::recommended_watcher(
            move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else {
                    return;
                };
                let relevant = matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                );
                if !relevant {
                    return;
                }
                let any_schedule = event
                    .paths
                    .iter()
                    .any(|path| path.file_name().and_then(|n| n.to_str()) == Some("schedules.json"));
                if any_schedule {
                    notify_clone.notify_waiters();
                }
            },
        ) {
            Ok(w) => w,
            Err(error) => {
                tracing::warn!(error = %error, "schedule watcher failed to start; scheduled tasks will only fire on restart");
                return;
            }
        };

        if let Err(error) = watcher.watch(&projects_dir, RecursiveMode::Recursive) {
            tracing::warn!(error = %error, path = %projects_dir.display(), "schedule watcher failed to bind to projects dir; scheduled tasks will only fire on restart");
            return;
        }

        // Block until shutdown. The notify watcher runs in its own internal
        // thread; this thread just keeps the watcher alive.
        loop {
            match stop_rx.recv_timeout(Duration::from_secs(60)) {
                Ok(()) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            }
        }
        drop(watcher);
    });
    ScheduleWatcherHandle {
        stop_tx,
        join_handle,
    }
}

/// Create all signal channels. Returns (senders, receivers) to be distributed
/// in `run_cli`.
pub fn create_daemon_signals() -> (DaemonSignals, DaemonSignalReceivers) {
    let (project_booted_tx, project_booted_rx) = mpsc::unbounded_channel();
    let (dispatch_enqueued_tx, dispatch_enqueued_rx) = mpsc::unbounded_channel();
    let (session_completed_tx, session_completed_rx) = mpsc::unbounded_channel();
    let (publish_enqueued_tx, publish_enqueued_rx) = mpsc::unbounded_channel();
    let (ral_completed_tx, ral_completed_rx) = mpsc::unbounded_channel();
    let (telegram_enqueued_tx, telegram_enqueued_rx) = mpsc::unbounded_channel();

    (
        DaemonSignals {
            project_index_changed: Arc::new(Notify::new()),
            project_schedules_changed: Arc::new(Notify::new()),
            project_booted_tx,
            dispatch_enqueued_tx,
            session_completed_tx,
            publish_enqueued_tx,
            ral_completed_tx,
            telegram_enqueued_tx,
        },
        DaemonSignalReceivers {
            project_booted_rx,
            dispatch_enqueued_rx,
            session_completed_rx,
            publish_enqueued_rx,
            ral_completed_rx,
            telegram_enqueued_rx,
        },
    )
}

//! Shared registry of spawned session threads.
//!
//! The daemon tick detaches each admitted dispatch onto its own OS thread and
//! pushes the `JoinHandle` here. A later tick polls this registry for finished
//! handles, drains their terminal outcomes, and reports them. At shutdown, the
//! loop driver joins any still-running handles so nothing is lost.

use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;

/// A single spawned session thread plus enough identity to describe it in
/// logs and error outcomes if the thread panics.
#[derive(Debug)]
pub struct SessionJoinHandle {
    pub dispatch_id: String,
    pub worker_id: String,
    pub handle: JoinHandle<DaemonWorkerRuntimeOutcome>,
}

/// Clone-friendly wrapper around the shared registry of in-flight session
/// threads. The tick loop clones this into each tick; the loop driver holds
/// it for shutdown-time joining.
#[derive(Debug, Clone, Default)]
pub struct WorkerSessionRegistry {
    inner: Arc<Mutex<Vec<SessionJoinHandle>>>,
}

impl WorkerSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a newly spawned session thread.
    pub fn push(&self, session: SessionJoinHandle) {
        self.inner
            .lock()
            .expect("session registry mutex poisoned")
            .push(session);
    }

    /// Remove and join every session thread whose `JoinHandle::is_finished()`
    /// returns true, converting each into its `DaemonWorkerRuntimeOutcome`.
    /// Threads still running stay in the registry.
    pub fn drain_finished(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let mut guard = self.inner.lock().expect("session registry mutex poisoned");
        let (finished, still_running): (Vec<_>, Vec<_>) = std::mem::take(&mut *guard)
            .into_iter()
            .partition(|session| session.handle.is_finished());
        *guard = still_running;
        drop(guard);
        finished
            .into_iter()
            .map(|session| match session.handle.join() {
                Ok(outcome) => outcome,
                Err(_) => DaemonWorkerRuntimeOutcome::SessionFailed {
                    dispatch_id: session.dispatch_id,
                    worker_id: session.worker_id,
                    error: "session thread panicked".to_string(),
                },
            })
            .collect()
    }

    /// Take every session thread out of the registry and join it, blocking
    /// until each returns. Used at loop shutdown to make sure no session is
    /// left running after the daemon stops.
    pub fn join_all(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let sessions: Vec<SessionJoinHandle> = {
            let mut guard = self.inner.lock().expect("session registry mutex poisoned");
            std::mem::take(&mut *guard)
        };
        sessions
            .into_iter()
            .map(|session| match session.handle.join() {
                Ok(outcome) => outcome,
                Err(_) => DaemonWorkerRuntimeOutcome::SessionFailed {
                    dispatch_id: session.dispatch_id,
                    worker_id: session.worker_id,
                    error: "session thread panicked".to_string(),
                },
            })
            .collect()
    }

    /// Current number of registered (possibly finished) session threads.
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("session registry mutex poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

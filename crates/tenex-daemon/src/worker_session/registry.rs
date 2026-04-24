//! Shared registry of spawned session tasks.
//!
//! The daemon tick detaches each admitted dispatch onto its own blocking task
//! and pushes the `JoinHandle` here. A later tick polls this registry for
//! finished handles, drains their terminal outcomes, and reports them. At
//! shutdown, the loop driver joins any still-running handles so nothing is
//! lost.
//!
//! `drain_finished` and `join_all` join tokio `JoinHandle`s from a sync
//! context via `Handle::current().block_on(...)`. Both methods **must** be
//! called from a blocking context (e.g., inside `tokio::task::spawn_blocking`)
//! where `Handle::current()` is available but blocking the thread is permitted.

use std::sync::{Arc, Mutex};

use tokio::task::JoinHandle as TokioJoinHandle;

use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;

/// A single spawned session task plus enough identity to describe it in
/// logs and error outcomes if the task panics.
#[derive(Debug)]
pub struct SessionJoinHandle {
    pub dispatch_id: String,
    pub worker_id: String,
    pub handle: TokioJoinHandle<DaemonWorkerRuntimeOutcome>,
}

/// Clone-friendly wrapper around the shared registry of in-flight session
/// tasks. The tick loop clones this into each tick; the loop driver holds
/// it for shutdown-time joining.
#[derive(Debug, Clone, Default)]
pub struct WorkerSessionRegistry {
    inner: Arc<Mutex<Vec<SessionJoinHandle>>>,
}

impl WorkerSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a newly spawned session task.
    pub fn push(&self, session: SessionJoinHandle) {
        self.inner
            .lock()
            .expect("session registry mutex poisoned")
            .push(session);
    }

    /// Remove and join every session task whose `JoinHandle::is_finished()`
    /// returns true, converting each into its `DaemonWorkerRuntimeOutcome`.
    /// Tasks still running stay in the registry.
    ///
    /// When finished tasks are present, this must be called from a blocking
    /// context (inside `tokio::task::spawn_blocking`) where
    /// `tokio::runtime::Handle::current()` is available. If the registry is
    /// empty, this is always safe to call from any context.
    pub fn drain_finished(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let mut guard = self.inner.lock().expect("session registry mutex poisoned");
        let (finished, still_running): (Vec<_>, Vec<_>) = std::mem::take(&mut *guard)
            .into_iter()
            .partition(|session| session.handle.is_finished());
        *guard = still_running;
        drop(guard);
        if finished.is_empty() {
            return Vec::new();
        }
        let rt_handle = tokio::runtime::Handle::current();
        finished
            .into_iter()
            .map(|session| match rt_handle.block_on(session.handle) {
                Ok(outcome) => outcome,
                Err(_) => DaemonWorkerRuntimeOutcome::SessionFailed {
                    dispatch_id: session.dispatch_id,
                    worker_id: session.worker_id,
                    error: "session task panicked".to_string(),
                },
            })
            .collect()
    }

    /// Take every session task out of the registry and join it, blocking
    /// until each returns. Used at loop shutdown to make sure no session is
    /// left running after the daemon stops.
    ///
    /// When tasks are present, this must be called from a blocking context
    /// (inside `tokio::task::spawn_blocking`) where
    /// `tokio::runtime::Handle::current()` is available. If the registry is
    /// empty, this is always safe to call from any context.
    pub fn join_all(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let sessions: Vec<SessionJoinHandle> = {
            let mut guard = self.inner.lock().expect("session registry mutex poisoned");
            std::mem::take(&mut *guard)
        };
        if sessions.is_empty() {
            return Vec::new();
        }
        let rt_handle = tokio::runtime::Handle::current();
        sessions
            .into_iter()
            .map(|session| match rt_handle.block_on(session.handle) {
                Ok(outcome) => outcome,
                Err(_) => DaemonWorkerRuntimeOutcome::SessionFailed {
                    dispatch_id: session.dispatch_id,
                    worker_id: session.worker_id,
                    error: "session task panicked".to_string(),
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

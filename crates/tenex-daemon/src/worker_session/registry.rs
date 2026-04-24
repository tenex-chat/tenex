//! Shared registry of spawned session work.
//!
//! Production uses Tokio tasks so worker sessions no longer require one OS
//! thread apiece. Sync tests and non-runtime callers can still fall back to
//! detached threads.

use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::runtime::Handle as TokioRuntimeHandle;
use tokio::task::JoinHandle as TokioJoinHandle;

use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;

#[derive(Debug)]
pub enum SessionJoinHandle {
    Thread {
        dispatch_id: String,
        worker_id: String,
        handle: JoinHandle<DaemonWorkerRuntimeOutcome>,
    },
    Tokio {
        dispatch_id: String,
        worker_id: String,
        handle: TokioJoinHandle<DaemonWorkerRuntimeOutcome>,
    },
}

impl SessionJoinHandle {
    fn is_finished(&self) -> bool {
        match self {
            Self::Thread { handle, .. } => handle.is_finished(),
            Self::Tokio { handle, .. } => handle.is_finished(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct WorkerSessionRegistry {
    inner: Arc<Mutex<Vec<SessionJoinHandle>>>,
    runtime_handle: Option<TokioRuntimeHandle>,
}

impl WorkerSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn new_on_runtime(runtime_handle: TokioRuntimeHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Vec::new())),
            runtime_handle: Some(runtime_handle),
        }
    }

    pub fn runtime_handle(&self) -> Option<TokioRuntimeHandle> {
        self.runtime_handle.clone()
    }

    pub fn push(&self, session: SessionJoinHandle) {
        self.inner
            .lock()
            .expect("session registry mutex poisoned")
            .push(session);
    }

    pub fn drain_finished(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let mut guard = self.inner.lock().expect("session registry mutex poisoned");
        let (finished, still_running): (Vec<_>, Vec<_>) = std::mem::take(&mut *guard)
            .into_iter()
            .partition(SessionJoinHandle::is_finished);
        *guard = still_running;
        drop(guard);
        finished
            .into_iter()
            .map(|session| self.join_session(session))
            .collect()
    }

    pub fn join_all(&self) -> Vec<DaemonWorkerRuntimeOutcome> {
        let sessions: Vec<SessionJoinHandle> = {
            let mut guard = self.inner.lock().expect("session registry mutex poisoned");
            std::mem::take(&mut *guard)
        };
        sessions
            .into_iter()
            .map(|session| self.join_session(session))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("session registry mutex poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn join_session(&self, session: SessionJoinHandle) -> DaemonWorkerRuntimeOutcome {
        match session {
            SessionJoinHandle::Thread {
                dispatch_id,
                worker_id,
                handle,
            } => match handle.join() {
                Ok(outcome) => outcome,
                Err(_) => session_failed(dispatch_id, worker_id, "session thread panicked"),
            },
            SessionJoinHandle::Tokio {
                dispatch_id,
                worker_id,
                handle,
            } => {
                let Some(runtime_handle) = self.runtime_handle.as_ref() else {
                    return session_failed(
                        dispatch_id,
                        worker_id,
                        "session task finished without a runtime handle",
                    );
                };
                match runtime_handle.block_on(async { handle.await }) {
                    Ok(outcome) => outcome,
                    Err(error) => session_failed(
                        dispatch_id,
                        worker_id,
                        &format!("session task failed: {error}"),
                    ),
                }
            }
        }
    }
}

fn session_failed(
    dispatch_id: String,
    worker_id: String,
    error: &str,
) -> DaemonWorkerRuntimeOutcome {
    DaemonWorkerRuntimeOutcome::SessionFailed {
        dispatch_id,
        worker_id,
        error: error.to_string(),
    }
}

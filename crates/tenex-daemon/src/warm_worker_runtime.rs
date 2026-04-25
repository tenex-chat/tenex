//! Warm-worker runtime: long-lived per-process worker session tracking.
//!
//! After a worker handles a terminal frame, instead of dropping the process
//! and starting fresh on the next dispatch, the daemon can leave the worker
//! alive for an idle TTL window. New dispatches for the same project route
//! to the existing worker via a `crossbeam_channel` command channel.
//!
//! This module owns:
//! - `WarmWorkerCommand` — the cross-thread message the daemon sends to a
//!   warm worker session task (NewExecute, Shutdown).
//! - `WarmWorkerHandle` — the daemon-side handle holding the command sender.
//! - `WarmWorkerRegistry` — `worker_id → WarmWorkerHandle` map shared across
//!   admission ticks and session tasks.
//!
//! The actual session-loop refactor that consumes commands lives in
//! `worker_session::session_loop`. Admission consults
//! `select_warm_worker_for_dispatch` (in `worker_reuse`) before spawning;
//! when a warm worker is chosen the admission tick uses the registry to
//! enqueue the new execute on its channel instead of spawning a new
//! process.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::worker_message_flow::WorkerMessageTerminalContext;

/// Commands the daemon admission tick sends to a warm worker session task.
#[derive(Debug)]
pub enum WarmWorkerCommand<'a> {
    /// Send a new `execute` frame to the worker and register a terminal
    /// context to handle the resulting terminal frame. The daemon's
    /// session-loop multiplexes terminal contexts by correlation_id.
    NewExecute {
        execute_message: Value,
        correlation_id: String,
        terminal: WorkerMessageTerminalContext<'a>,
    },
    /// Ask the session task to exit gracefully after current executes
    /// complete. Used when the registry's idle TTL expires or operator
    /// shuts the daemon down.
    Shutdown { reason: String },
}

/// Owned variant for cross-thread shipping. The terminal context's
/// borrowed scheduler/dispatch_state references can't survive the
/// admission tick boundary, so the warm path stores the bits it needs to
/// re-create them per terminal.
#[derive(Debug, Clone)]
pub struct OwnedTerminalContext {
    pub correlation_id: String,
    pub dispatch_id: String,
    pub claim_token: String,
    pub journal_sequence_hint: u64,
    pub journal_timestamp: u64,
    pub writer_version: String,
    pub dispatch_correlation_id: String,
}

/// Owned variant of WarmWorkerCommand suitable for crossing the admission
/// tick → session task boundary via crossbeam_channel.
#[derive(Debug)]
pub enum OwnedWarmWorkerCommand {
    NewExecute {
        execute_message: Value,
        correlation_id: String,
        terminal: OwnedTerminalContext,
    },
    Shutdown {
        reason: String,
    },
}

/// Daemon-side handle for a single warm worker. The session task on the
/// other end of the channel reads commands and feeds them to the worker
/// process.
#[derive(Clone)]
pub struct WarmWorkerHandle {
    pub worker_id: String,
    pub project_id: String,
    pub command_tx: crossbeam_channel::Sender<OwnedWarmWorkerCommand>,
}

impl std::fmt::Debug for WarmWorkerHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WarmWorkerHandle")
            .field("worker_id", &self.worker_id)
            .field("project_id", &self.project_id)
            .field("channel_capacity", &self.command_tx.capacity())
            .finish()
    }
}

/// Process-shared registry of warm worker handles, keyed by worker_id.
///
/// Owned by the daemon top-level so it survives across admission ticks
/// and across session tasks.
#[derive(Default, Clone)]
pub struct WarmWorkerRegistry {
    inner: Arc<Mutex<HashMap<String, WarmWorkerHandle>>>,
}

impl WarmWorkerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, handle: WarmWorkerHandle) {
        self.inner
            .lock()
            .expect("warm worker registry mutex poisoned")
            .insert(handle.worker_id.clone(), handle);
    }

    pub fn remove(&self, worker_id: &str) -> Option<WarmWorkerHandle> {
        self.inner
            .lock()
            .expect("warm worker registry mutex poisoned")
            .remove(worker_id)
    }

    pub fn get(&self, worker_id: &str) -> Option<WarmWorkerHandle> {
        self.inner
            .lock()
            .expect("warm worker registry mutex poisoned")
            .get(worker_id)
            .cloned()
    }

    /// Count of currently-warm workers. Used by diagnostics and for the
    /// `project_warm_workers` counter.
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("warm worker registry mutex poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_inserts_gets_and_removes_handles() {
        let registry = WarmWorkerRegistry::new();
        let (tx, _rx) = crossbeam_channel::unbounded();
        let handle = WarmWorkerHandle {
            worker_id: "worker-a".to_string(),
            project_id: "project-a".to_string(),
            command_tx: tx,
        };
        registry.insert(handle.clone());
        assert_eq!(registry.len(), 1);

        let fetched = registry.get("worker-a").expect("must find worker");
        assert_eq!(fetched.worker_id, "worker-a");
        assert_eq!(fetched.project_id, "project-a");

        let removed = registry.remove("worker-a").expect("must remove");
        assert_eq!(removed.worker_id, "worker-a");
        assert!(registry.is_empty());
        assert!(registry.get("worker-a").is_none());
    }

    #[test]
    fn handle_clone_shares_command_channel() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let original = WarmWorkerHandle {
            worker_id: "worker-clone".to_string(),
            project_id: "project-x".to_string(),
            command_tx: tx,
        };
        let cloned = original.clone();
        cloned
            .command_tx
            .send(OwnedWarmWorkerCommand::Shutdown {
                reason: "test".to_string(),
            })
            .expect("send must succeed");
        let received = rx.recv().expect("recv must succeed");
        match received {
            OwnedWarmWorkerCommand::Shutdown { reason } => assert_eq!(reason, "test"),
            other => panic!("expected Shutdown, got {other:?}"),
        }
    }
}

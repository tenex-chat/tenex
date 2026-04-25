pub const DEFAULT_WORKER_GRACEFUL_ABORT_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_WORKER_FORCE_KILL_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerAbortSignal {
    Abort,
    Shutdown,
}

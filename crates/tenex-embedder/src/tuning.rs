//! All policy constants in one place. Override via `~/.tenex/embedder.json`
//! (see `config.rs`).

/// How often the daemon polls every project for changes.
pub const SCAN_INTERVAL_SECS: u64 = 30;

/// A conversation must be quiet for at least this long before its tail
/// chunk is sealed.
pub const DEBOUNCE_SECS: i64 = 30;

/// Minimum gap between embedding passes for the same conversation.
pub const MIN_INTERVAL_MS: i64 = 60_000;

/// Hard ceiling for tail-chunk sealing: even a never-quiet conversation
/// has its tail sealed once it is this old (24 h).
pub const TAIL_SEAL_MAX_AGE_SECS: i64 = 24 * 60 * 60;

/// Target chunk size in characters (~1500 tokens for `text-embedding-3-small`).
pub const CHUNK_TARGET_CHARS: usize = 6_000;

/// Hard ceiling on a single chunk's char count. A single message larger
/// than this is truncated to fit.
pub const CHUNK_CEILING_CHARS: usize = 7_000;

/// Number of trailing messages carried into the next chunk for context overlap.
pub const OVERLAP_MESSAGES: usize = 3;

/// Default daemon embedding rate (calls per second).
pub const DAEMON_RATE_PER_SEC: f64 = 2.0;

/// Default backfill embedding rate (calls per second).
pub const BACKFILL_RATE_PER_SEC: f64 = 10.0;

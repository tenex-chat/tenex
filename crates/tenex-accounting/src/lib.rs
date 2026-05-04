//! `tenex-accounting` — SQLite-backed LLM accounting & observability for TENEX.
//!
//! Records every LLM, embedding, and tool call as a span hanging off a trace.
//! Exposes a query API for read-side and an embedded HTTP server (axum) for
//! the local web UI.
//!
//! ## Public surface
//!
//! - [`Recorder`] — write-side. `open_trace` → `open_llm_call`/`open_tool_call`/
//!   `open_embedding` → `finish_ok` / `finish_err`. Cheap to clone (Arc inside).
//! - [`QueryService`] — read-side. Opens a SQLite connection in read-only mode
//!   per query. Used by the HTTP server and the CLI.
//! - [`server::serve`] — boots an axum app on a chosen address with REST endpoints
//!   plus a single static HTML page (vanilla JS, no build step).
//!
//! ## Default DB locations
//!
//! `~/.tenex/data/accounting/hot.db` (configurable). WAL mode. Migrations run
//! automatically on `Recorder::open`.
//!
//! ## What's deferred
//!
//! See `docs/plans/2026-04-30-llm-accounting.md`. v1 ships the core hot DB,
//! recorder, query, server, agent + embedder integration. Hot/cold split, OTel
//! bridge, materialized views, replay, A/B, anomaly detection, and PII
//! encryption land in later phases.

pub mod ids;
pub mod pricing;
pub mod query;
pub mod recorder;
pub mod schema;
pub mod server;
pub mod simple;

mod agent_labels;

pub use query::{
    AgentCostRow, EmbeddingSummary, LlmCallSummary, ModelCostRow, Overview, ProviderCostRow,
    QueryService, RecentLlmCall, SpanDetail, SpanMessage, ToolCallSummary, TraceDetail,
    TraceFilter, TraceSummary,
};
pub use recorder::{
    EmbeddingFinish, EmbeddingSpan, EmbeddingStart, LlmCallFinish, LlmCallSpan, LlmCallStart,
    RecordedMessage, Recorder, RecorderError, RootKind, RootKindOrStr, SpanKind, ToolCallFinish,
    ToolCallSpan, ToolCallStart, TraceHandle, TraceRoot,
};
pub use simple::{flush, record_llm_call, recorder, LlmUsage, RecordLlmCall};

/// Default home for the hot DB: `<HOME>/.tenex/data/accounting/hot.db`.
pub fn default_db_path() -> std::path::PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".tenex/data/accounting/hot.db")
}

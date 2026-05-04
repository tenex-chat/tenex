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
//! - [`simple`] — convenience layer for callers who want one helper call per
//!   LLM operation: [`record_llm_call`] / [`open_trace`] / [`with_trace`] /
//!   [`finish_trace`] / [`flush`]. The agent turn loop and all in-process
//!   ancillary call sites use this.
//! - [`QueryService`] — read-side. Opens a SQLite connection in read-only mode
//!   per query. Used by the HTTP server and the CLI.
//! - [`server::serve`] — boots an axum app on a chosen address with REST endpoints
//!   plus a single static HTML page (vanilla JS, no build step).
//!
//! ## Trace scoping
//!
//! A trace is one **agent turn iteration** in the calling agent process — the
//! main streaming call plus any in-turn ancillary LLM calls (rag_search,
//! learn, conversation_get analysis) nest as child spans. The agent turn loop
//! installs the trace as a `tokio::task_local` via [`with_trace`]; nested
//! [`record_llm_call`] sites pick it up automatically and open child spans.
//! When no trace is active, [`record_llm_call`] opens a fresh single-span
//! trace for the call alone — used by bootstrap-time activities (categorize,
//! compaction, context_discovery) and by stand-alone daemons (summarizer,
//! firewall).
//!
//! Re-engagement iterations on the same user message produce sibling traces.
//! Delegations — including cross-project — produce independent traces per
//! delegated agent's iterations: trace context is deliberately NOT propagated
//! across delegation envelopes, since each delegation is its own conversation
//! with its own cost-attribution lifecycle.
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
pub use simple::{
    finish_trace, flush, open_trace, record_llm_call, recorder, with_trace, LlmUsage,
    RecordLlmCall,
};

/// Default home for the hot DB: `<HOME>/.tenex/data/accounting/hot.db`.
pub fn default_db_path() -> std::path::PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".tenex/data/accounting/hot.db")
}

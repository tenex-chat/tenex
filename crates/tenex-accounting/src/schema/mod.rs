//! SQLite schema for the accounting hot DB.
//!
//! The shape:
//!
//! - `traces` — root unit of work (a user message, a scheduler tick, an embedding backfill run).
//! - `spans` — every operation inside a trace; superclass of llm_call / tool_call / embedding / etc.
//! - `llm_calls` — extension columns for kind=llm_call.
//! - `llm_call_messages` — message snapshots for an llm_call.
//! - `tool_calls` — extension columns for kind=tool_call.
//! - `embeddings` — extension columns for kind=embedding.
//! - `models` — pricing catalog snapshot.
//!
//! Atomic cost components (prompt/output/cache_read/cache_write/reasoning) are
//! stored separately on `llm_calls`; never a single pre-summed `cost_usd`.
//!
//! Append-only. A span gets one row at start (status=running, ended_at_ms=NULL)
//! and is updated once at finish — the only mutating SQL in the recorder.

use anyhow::{Context, Result};
use rusqlite::Connection;

pub const SCHEMA_VERSION: i32 = 1;

const PRAGMAS: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
"#;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    trace_id              TEXT PRIMARY KEY,
    root_kind             TEXT NOT NULL,
    triggering_event_id   TEXT,
    triggering_kind       INTEGER,
    triggering_pubkey     TEXT,
    project_id            TEXT,
    conversation_id       TEXT,
    user_pubkey           TEXT,
    label                 TEXT,
    started_at_ms         INTEGER NOT NULL,
    ended_at_ms           INTEGER,
    wall_duration_ms      INTEGER,
    outcome               TEXT NOT NULL DEFAULT 'pending',
    outcome_summary       TEXT,
    user_accepted         INTEGER,
    total_cost_usd        REAL NOT NULL DEFAULT 0,
    total_input_tokens    INTEGER NOT NULL DEFAULT 0,
    total_output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_llm_calls       INTEGER NOT NULL DEFAULT 0,
    total_tool_calls      INTEGER NOT NULL DEFAULT 0,
    total_embeddings      INTEGER NOT NULL DEFAULT 0,
    max_depth             INTEGER NOT NULL DEFAULT 0,
    fanout_max            INTEGER NOT NULL DEFAULT 0,
    tenex_version_sha     TEXT,
    host_id               TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_outcome ON traces(outcome, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_conversation ON traces(conversation_id, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_project ON traces(project_id, started_at_ms DESC);

CREATE TABLE IF NOT EXISTS spans (
    span_id              TEXT PRIMARY KEY,
    trace_id             TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    parent_span_id       TEXT,
    kind                 TEXT NOT NULL,
    agent_pubkey         TEXT,
    agent_slug           TEXT,
    agent_role           TEXT,
    started_at_ms        INTEGER NOT NULL,
    ended_at_ms          INTEGER,
    duration_ms          INTEGER,
    depth                INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'running',
    error_class          TEXT,
    error_message        TEXT,
    attributes_json      TEXT
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, started_at_ms);
CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_agent ON spans(agent_pubkey, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_spans_status ON spans(status, ended_at_ms);

CREATE TABLE IF NOT EXISTS llm_calls (
    span_id                       TEXT PRIMARY KEY REFERENCES spans(span_id) ON DELETE CASCADE,
    provider                      TEXT NOT NULL,
    provider_model_id             TEXT NOT NULL,
    model_family                  TEXT,
    operation                     TEXT NOT NULL,
    api_key_label                 TEXT,
    api_key_identity              TEXT,
    openrouter_provider           TEXT,
    openrouter_generation_id      TEXT,
    openrouter_native_finish_reason TEXT,
    input_tokens                  INTEGER NOT NULL DEFAULT 0,
    output_tokens                 INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens              INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens             INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens            INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens           INTEGER NOT NULL DEFAULT 0,
    audio_input_tokens            INTEGER NOT NULL DEFAULT 0,
    audio_output_tokens           INTEGER NOT NULL DEFAULT 0,
    image_input_tokens            INTEGER NOT NULL DEFAULT 0,
    prompt_tokens_cost_usd        REAL NOT NULL DEFAULT 0,
    output_tokens_cost_usd        REAL NOT NULL DEFAULT 0,
    cache_read_cost_usd           REAL NOT NULL DEFAULT 0,
    cache_write_cost_usd          REAL NOT NULL DEFAULT 0,
    reasoning_tokens_cost_usd     REAL NOT NULL DEFAULT 0,
    total_cost_usd_provider       REAL,
    total_cost_usd_estimated      REAL NOT NULL DEFAULT 0,
    cost_drift_usd                REAL,
    queued_at_ms                  INTEGER,
    request_sent_at_ms            INTEGER,
    ttft_ms                       INTEGER,
    total_latency_ms              INTEGER,
    output_tokens_per_second      REAL,
    finish_reason                 TEXT,
    was_truncated                 INTEGER NOT NULL DEFAULT 0,
    refusal_detected              INTEGER NOT NULL DEFAULT 0,
    attempt_number                INTEGER NOT NULL DEFAULT 1,
    retry_of_span_id              TEXT,
    retry_reason                  TEXT,
    n_messages_sent               INTEGER,
    n_tools_offered               INTEGER,
    n_tools_called                INTEGER,
    temperature                   REAL,
    top_p                         REAL,
    max_tokens_requested          INTEGER,
    seed                          INTEGER,
    response_format               TEXT,
    system_prompt_hash            TEXT,
    messages_prefix_hash          TEXT,
    cache_strategy_used           TEXT,
    cache_breakpoints_count       INTEGER,
    -- Ollama-specific (NULL for other providers).
    load_duration_ns              INTEGER,
    eval_duration_ns              INTEGER,
    prompt_eval_duration_ns       INTEGER,
    tokens_per_sec_eval           REAL,
    model_loaded_from_cold        INTEGER,
    shadow_cost_usd               REAL,
    shadow_cost_reference_model   TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_provider ON llm_calls(provider, model_family);
CREATE INDEX IF NOT EXISTS idx_llm_calls_or_gen ON llm_calls(openrouter_generation_id);

CREATE TABLE IF NOT EXISTS llm_call_messages (
    span_id              TEXT NOT NULL REFERENCES llm_calls(span_id) ON DELETE CASCADE,
    position             INTEGER NOT NULL,
    role                 TEXT NOT NULL,
    classification       TEXT,
    content_hash         TEXT NOT NULL,
    content_preview      TEXT,
    content_full         TEXT,
    tokens_estimated     INTEGER,
    cache_breakpoint_after INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (span_id, position)
);

CREATE INDEX IF NOT EXISTS idx_messages_hash ON llm_call_messages(content_hash);

CREATE TABLE IF NOT EXISTS tool_calls (
    span_id                 TEXT PRIMARY KEY REFERENCES spans(span_id) ON DELETE CASCADE,
    parent_llm_call_span_id TEXT,
    tool_name               TEXT NOT NULL,
    tool_namespace          TEXT,
    args_hash               TEXT,
    args_size_bytes         INTEGER,
    args_preview            TEXT,
    result_size_bytes       INTEGER,
    result_status           TEXT,
    result_preview          TEXT,
    duration_ms             INTEGER,
    was_invalid             INTEGER NOT NULL DEFAULT 0,
    validation_errors       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_parent ON tool_calls(parent_llm_call_span_id);

CREATE TABLE IF NOT EXISTS embeddings (
    span_id                 TEXT PRIMARY KEY REFERENCES spans(span_id) ON DELETE CASCADE,
    provider                TEXT NOT NULL,
    model                   TEXT NOT NULL,
    dimension               INTEGER,
    batch_size              INTEGER NOT NULL DEFAULT 1,
    total_input_chars       INTEGER NOT NULL DEFAULT 0,
    total_input_tokens      INTEGER NOT NULL DEFAULT 0,
    source_kind             TEXT,
    source_event_kind       INTEGER,
    source_event_id         TEXT,
    cost_usd                REAL NOT NULL DEFAULT 0,
    cost_per_million_tokens REAL,
    throughput_tokens_per_sec REAL,
    vector_storage_target   TEXT,
    dedup_skipped_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model ON embeddings(provider, model);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_kind);

CREATE TABLE IF NOT EXISTS models (
    provider                          TEXT NOT NULL,
    model_family                      TEXT NOT NULL,
    snapshot_id                       TEXT NOT NULL,
    input_price_per_mtok              REAL NOT NULL,
    output_price_per_mtok             REAL NOT NULL,
    cache_read_price_per_mtok         REAL NOT NULL DEFAULT 0,
    cache_write_price_per_mtok        REAL NOT NULL DEFAULT 0,
    reasoning_price_per_mtok          REAL NOT NULL DEFAULT 0,
    embedding_price_per_mtok          REAL NOT NULL DEFAULT 0,
    context_window                    INTEGER,
    supports_caching                  INTEGER NOT NULL DEFAULT 0,
    supports_reasoning                INTEGER NOT NULL DEFAULT 0,
    effective_from_ms                 INTEGER NOT NULL,
    PRIMARY KEY (provider, model_family, snapshot_id, effective_from_ms)
);
"#;

pub fn open_with_migrations(path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create accounting db directory")?;
    }
    let conn = Connection::open(path).context("open sqlite db")?;
    conn.execute_batch(PRAGMAS).context("apply pragmas")?;
    apply_migrations(&conn)?;
    Ok(conn)
}

fn apply_migrations(conn: &Connection) -> Result<()> {
    let current: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .or_else(|_| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);",
            )
            .map(|_| 0)
        })?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }
    if current < 1 {
        conn.execute_batch(SCHEMA_V1).context("apply schema v1")?;
        let now = now_ms();
        conn.execute(
            "INSERT INTO schema_version(version, applied_at_ms) VALUES (1, ?1)",
            [now],
        )?;
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

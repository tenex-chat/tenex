//! Append-only recorder for accounting spans.
//!
//! API:
//!
//! ```ignore
//! let recorder = Recorder::open(PathBuf::from("~/.tenex/data/accounting/hot.db")).await?;
//! let trace = recorder.open_trace(TraceRoot { kind: RootKind::UserMessage, ... }).await?;
//! let span = trace.open_llm_call(LlmCallStart { provider, model, ... }).await?;
//! span.finish_ok(LlmCallFinish { input_tokens, output_tokens, ... }).await;
//! trace.finish_ok(...).await;
//! ```
//!
//! Writes go through a single mpsc-backed writer task that serializes inserts
//! and updates in batched transactions. The hot path (caller side) only does
//! channel sends — no sqlite contention from concurrent agents.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::ids::{new_id, sha256_hex};
use crate::pricing::{self, estimate_cost, estimate_embedding_cost, lookup, TokenCounts};
use crate::schema::{now_ms, open_with_migrations};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RootKind {
    UserMessage,
    ScheduledTask,
    Intervention,
    EmbeddingBackfill,
    McpSubscriptionCallback,
    RagQuery,
    Summarization,
    Firewall,
    Smoke,
}

impl RootKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UserMessage => "user_message",
            Self::ScheduledTask => "scheduled_task",
            Self::Intervention => "intervention",
            Self::EmbeddingBackfill => "embedding_backfill",
            Self::McpSubscriptionCallback => "mcp_subscription_callback",
            Self::RagQuery => "rag_query",
            Self::Summarization => "summarization",
            Self::Firewall => "firewall",
            Self::Smoke => "smoke",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TraceRoot {
    pub root_kind: RootKindOrStr,
    pub triggering_event_id: Option<String>,
    pub triggering_kind: Option<i64>,
    pub triggering_pubkey: Option<String>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub user_pubkey: Option<String>,
    pub label: Option<String>,
    pub tenex_version_sha: Option<String>,
    pub host_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum RootKindOrStr {
    Known(RootKind),
    Other(String),
}

impl Default for RootKindOrStr {
    fn default() -> Self {
        Self::Known(RootKind::UserMessage)
    }
}

impl RootKindOrStr {
    fn as_str(&self) -> &str {
        match self {
            Self::Known(k) => k.as_str(),
            Self::Other(s) => s.as_str(),
        }
    }
}

impl From<RootKind> for RootKindOrStr {
    fn from(k: RootKind) -> Self {
        Self::Known(k)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    LlmCall,
    ToolCall,
    Delegation,
    Embedding,
    McpCall,
    FileEdit,
    Compaction,
    CacheLookup,
    AgentThinking,
}

impl SpanKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::LlmCall => "llm_call",
            Self::ToolCall => "tool_call",
            Self::Delegation => "delegation",
            Self::Embedding => "embedding",
            Self::McpCall => "mcp_call",
            Self::FileEdit => "file_edit",
            Self::Compaction => "compaction",
            Self::CacheLookup => "cache_lookup",
            Self::AgentThinking => "agent_thinking",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LlmCallStart {
    pub provider: String,
    pub provider_model_id: String,
    pub operation: String, // stream | generate_text | generate_object | embed
    pub api_key_label: Option<String>,
    pub api_key_identity: Option<String>, // hashed; caller is responsible
    pub agent_pubkey: Option<String>,
    pub agent_slug: Option<String>,
    pub agent_role: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens_requested: Option<i64>,
    pub seed: Option<i64>,
    pub n_messages_sent: Option<i64>,
    pub n_tools_offered: Option<i64>,
    pub system_prompt_hash: Option<String>,
    pub messages_prefix_hash: Option<String>,
    pub messages: Vec<RecordedMessage>,
    pub queued_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RecordedMessage {
    pub role: String,
    pub classification: Option<String>,
    pub content: String,
    pub tokens_estimated: Option<i64>,
    pub cache_breakpoint_after: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LlmCallFinish {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cached_input_tokens: u64,
    pub total_cost_usd_provider: Option<f64>,
    pub finish_reason: Option<String>,
    pub openrouter_provider: Option<String>,
    pub openrouter_generation_id: Option<String>,
    pub openrouter_native_finish_reason: Option<String>,
    pub ttft_ms: Option<i64>,
    pub n_tools_called: Option<i64>,
    pub was_truncated: bool,
    pub refusal_detected: bool,
    pub load_duration_ns: Option<i64>,
    pub eval_duration_ns: Option<i64>,
    pub prompt_eval_duration_ns: Option<i64>,
    pub model_loaded_from_cold: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolCallStart {
    pub tool_name: String,
    pub tool_namespace: Option<String>,
    pub agent_pubkey: Option<String>,
    pub parent_llm_call_span_id: Option<String>,
    pub args: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolCallFinish {
    pub result_status: Option<String>,
    pub result_size_bytes: Option<i64>,
    pub result_preview: Option<String>,
    pub was_invalid: bool,
    pub validation_errors: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddingStart {
    pub provider: String,
    pub model: String,
    pub agent_pubkey: Option<String>,
    pub batch_size: i64,
    pub total_input_chars: i64,
    pub source_kind: Option<String>,
    pub source_event_kind: Option<i64>,
    pub source_event_id: Option<String>,
    pub vector_storage_target: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddingFinish {
    pub total_input_tokens: u64,
    pub dimension: Option<i64>,
    pub dedup_skipped_count: i64,
}

/// Sole error type for the recorder.
#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
    #[error("recorder writer task has stopped")]
    WriterGone,
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Public handle to the recorder. Cheap to clone (Arc inside).
#[derive(Clone)]
pub struct Recorder {
    inner: Arc<RecorderInner>,
}

struct RecorderInner {
    tx: mpsc::Sender<WriterMsg>,
    db_path: PathBuf,
}

enum WriterMsg {
    OpenTrace {
        trace_id: String,
        root: TraceRoot,
        started_at_ms: i64,
        ack: oneshot::Sender<Result<()>>,
    },
    FinishTrace {
        trace_id: String,
        ended_at_ms: i64,
        outcome: String,
        outcome_summary: Option<String>,
    },
    OpenSpan {
        span_id: String,
        trace_id: String,
        parent_span_id: Option<String>,
        kind: &'static str,
        agent_pubkey: Option<String>,
        agent_slug: Option<String>,
        agent_role: Option<String>,
        depth: i64,
        started_at_ms: i64,
        attributes_json: Option<String>,
    },
    InsertLlmCallStart {
        span_id: String,
        start: LlmCallStart,
    },
    UpdateLlmCallFinish {
        span_id: String,
        finish: LlmCallFinish,
        ended_at_ms: i64,
    },
    InsertToolCallStart {
        span_id: String,
        start: ToolCallStart,
    },
    UpdateToolCallFinish {
        span_id: String,
        finish: ToolCallFinish,
        ended_at_ms: i64,
    },
    InsertEmbeddingStart {
        span_id: String,
        start: EmbeddingStart,
    },
    UpdateEmbeddingFinish {
        span_id: String,
        finish: EmbeddingFinish,
        ended_at_ms: i64,
    },
    FinishSpanError {
        span_id: String,
        error_class: Option<String>,
        error_message: Option<String>,
        ended_at_ms: i64,
    },
    Flush {
        ack: oneshot::Sender<()>,
    },
}

impl Recorder {
    /// Open (and migrate) a hot DB at `path`. Spawns the writer task.
    pub async fn open(path: impl Into<PathBuf>) -> Result<Self, RecorderError> {
        let path = path.into();
        let p = path.clone();
        let (open_tx, open_rx) = oneshot::channel::<Result<()>>();
        let (tx, rx) = mpsc::channel::<WriterMsg>(2048);
        std::thread::Builder::new()
            .name("tenex-accounting-writer".into())
            .spawn(move || writer_loop(p, rx, open_tx))
            .map_err(|e| RecorderError::Other(anyhow!(e)))?;
        open_rx.await.map_err(|_| RecorderError::WriterGone)??;
        Ok(Self {
            inner: Arc::new(RecorderInner { tx, db_path: path }),
        })
    }

    /// Path to the underlying database (useful for read-only queries elsewhere).
    pub fn db_path(&self) -> &Path {
        &self.inner.db_path
    }

    pub async fn open_trace(&self, root: TraceRoot) -> Result<TraceHandle, RecorderError> {
        let trace_id = new_id();
        let (ack_tx, ack_rx) = oneshot::channel();
        self.inner
            .tx
            .send(WriterMsg::OpenTrace {
                trace_id: trace_id.clone(),
                root,
                started_at_ms: now_ms(),
                ack: ack_tx,
            })
            .await
            .map_err(|_| RecorderError::WriterGone)?;
        ack_rx
            .await
            .map_err(|_| RecorderError::WriterGone)?
            .map_err(RecorderError::Other)?;
        Ok(TraceHandle {
            trace_id,
            recorder: self.clone(),
            depth: 0,
            parent_span: None,
        })
    }

    /// Block until the writer queue has drained — useful for short-lived bins.
    pub async fn flush(&self) -> Result<(), RecorderError> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .tx
            .send(WriterMsg::Flush { ack: tx })
            .await
            .map_err(|_| RecorderError::WriterGone)?;
        rx.await.map_err(|_| RecorderError::WriterGone)
    }

    async fn send(&self, msg: WriterMsg) -> Result<(), RecorderError> {
        self.inner
            .tx
            .send(msg)
            .await
            .map_err(|_| RecorderError::WriterGone)
    }
}

#[derive(Clone)]
pub struct TraceHandle {
    pub trace_id: String,
    recorder: Recorder,
    depth: i64,
    parent_span: Option<String>,
}

impl TraceHandle {
    /// Open a child span at the same depth as the trace root.
    pub async fn open_llm_call(&self, start: LlmCallStart) -> Result<LlmCallSpan, RecorderError> {
        let span_id = new_id();
        let started_at = now_ms();
        let agent = (
            start.agent_pubkey.clone(),
            start.agent_slug.clone(),
            start.agent_role.clone(),
        );
        self.recorder
            .send(WriterMsg::OpenSpan {
                span_id: span_id.clone(),
                trace_id: self.trace_id.clone(),
                parent_span_id: self.parent_span.clone(),
                kind: SpanKind::LlmCall.as_str(),
                agent_pubkey: agent.0,
                agent_slug: agent.1,
                agent_role: agent.2,
                depth: self.depth + 1,
                started_at_ms: started_at,
                attributes_json: None,
            })
            .await?;
        self.recorder
            .send(WriterMsg::InsertLlmCallStart {
                span_id: span_id.clone(),
                start,
            })
            .await?;
        Ok(LlmCallSpan {
            span_id,
            recorder: self.recorder.clone(),
        })
    }

    pub async fn open_tool_call(
        &self,
        start: ToolCallStart,
    ) -> Result<ToolCallSpan, RecorderError> {
        let span_id = new_id();
        let started_at = now_ms();
        self.recorder
            .send(WriterMsg::OpenSpan {
                span_id: span_id.clone(),
                trace_id: self.trace_id.clone(),
                parent_span_id: self.parent_span.clone(),
                kind: SpanKind::ToolCall.as_str(),
                agent_pubkey: start.agent_pubkey.clone(),
                agent_slug: None,
                agent_role: None,
                depth: self.depth + 1,
                started_at_ms: started_at,
                attributes_json: None,
            })
            .await?;
        self.recorder
            .send(WriterMsg::InsertToolCallStart {
                span_id: span_id.clone(),
                start,
            })
            .await?;
        Ok(ToolCallSpan {
            span_id,
            recorder: self.recorder.clone(),
        })
    }

    pub async fn open_embedding(
        &self,
        start: EmbeddingStart,
    ) -> Result<EmbeddingSpan, RecorderError> {
        let span_id = new_id();
        let started_at = now_ms();
        self.recorder
            .send(WriterMsg::OpenSpan {
                span_id: span_id.clone(),
                trace_id: self.trace_id.clone(),
                parent_span_id: self.parent_span.clone(),
                kind: SpanKind::Embedding.as_str(),
                agent_pubkey: start.agent_pubkey.clone(),
                agent_slug: None,
                agent_role: None,
                depth: self.depth + 1,
                started_at_ms: started_at,
                attributes_json: None,
            })
            .await?;
        self.recorder
            .send(WriterMsg::InsertEmbeddingStart {
                span_id: span_id.clone(),
                start,
            })
            .await?;
        Ok(EmbeddingSpan {
            span_id,
            recorder: self.recorder.clone(),
        })
    }

    pub async fn finish_ok(self, summary: Option<String>) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::FinishTrace {
                trace_id: self.trace_id,
                ended_at_ms: now_ms(),
                outcome: "completed".to_string(),
                outcome_summary: summary,
            })
            .await
    }

    pub async fn finish_err(self, summary: Option<String>) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::FinishTrace {
                trace_id: self.trace_id,
                ended_at_ms: now_ms(),
                outcome: "errored".to_string(),
                outcome_summary: summary,
            })
            .await
    }
}

pub struct LlmCallSpan {
    pub span_id: String,
    recorder: Recorder,
}

impl LlmCallSpan {
    pub async fn finish_ok(self, finish: LlmCallFinish) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::UpdateLlmCallFinish {
                span_id: self.span_id,
                finish,
                ended_at_ms: now_ms(),
            })
            .await
    }

    pub async fn finish_err(
        self,
        error_class: Option<String>,
        error_message: Option<String>,
    ) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::FinishSpanError {
                span_id: self.span_id,
                error_class,
                error_message,
                ended_at_ms: now_ms(),
            })
            .await
    }
}

pub struct ToolCallSpan {
    pub span_id: String,
    recorder: Recorder,
}

impl ToolCallSpan {
    pub async fn finish_ok(self, finish: ToolCallFinish) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::UpdateToolCallFinish {
                span_id: self.span_id,
                finish,
                ended_at_ms: now_ms(),
            })
            .await
    }
}

pub struct EmbeddingSpan {
    pub span_id: String,
    recorder: Recorder,
}

impl EmbeddingSpan {
    pub async fn finish_ok(self, finish: EmbeddingFinish) -> Result<(), RecorderError> {
        self.recorder
            .send(WriterMsg::UpdateEmbeddingFinish {
                span_id: self.span_id,
                finish,
                ended_at_ms: now_ms(),
            })
            .await
    }
}

// ---------- writer side ----------

fn writer_loop(
    db_path: PathBuf,
    mut rx: mpsc::Receiver<WriterMsg>,
    open_ack: oneshot::Sender<Result<()>>,
) {
    let conn = match open_with_migrations(&db_path) {
        Ok(c) => c,
        Err(e) => {
            let _ = open_ack.send(Err(e));
            return;
        }
    };
    let _ = open_ack.send(Ok(()));

    while let Some(msg) = rx.blocking_recv() {
        if let Err(e) = handle_msg(&conn, msg) {
            tracing::warn!(target: "tenex-accounting", "writer error: {e:#}");
        }
    }
}

fn handle_msg(conn: &Connection, msg: WriterMsg) -> Result<()> {
    match msg {
        WriterMsg::OpenTrace {
            trace_id,
            root,
            started_at_ms,
            ack,
        } => {
            let res = conn
                .execute(
                    r#"INSERT INTO traces(
                        trace_id, root_kind, triggering_event_id, triggering_kind, triggering_pubkey,
                        project_id, conversation_id, user_pubkey, label, started_at_ms,
                        outcome, tenex_version_sha, host_id
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)"#,
                    params![
                        trace_id,
                        root.root_kind.as_str(),
                        root.triggering_event_id,
                        root.triggering_kind,
                        root.triggering_pubkey,
                        root.project_id,
                        root.conversation_id,
                        root.user_pubkey,
                        root.label,
                        started_at_ms,
                        root.tenex_version_sha,
                        root.host_id
                    ],
                )
                .context("insert trace")
                .map(|_| ());
            let _ = ack.send(res);
        }
        WriterMsg::FinishTrace {
            trace_id,
            ended_at_ms,
            outcome,
            outcome_summary,
        } => {
            // Roll up costs from constituent spans.
            let rollup: Result<(f64, i64, i64, i64, i64, i64, i64, i64, i64, i64)> = conn.query_row(
                r#"SELECT
                       COALESCE(SUM(COALESCE(l.total_cost_usd_provider, l.total_cost_usd_estimated)),0),
                       COALESCE(SUM(l.input_tokens),0),
                       COALESCE(SUM(l.output_tokens),0),
                       COALESCE(SUM(l.reasoning_tokens),0),
                       COALESCE(SUM(l.cache_read_tokens),0),
                       COALESCE(SUM(l.cache_write_tokens),0),
                       (SELECT COUNT(*) FROM spans WHERE trace_id=?1 AND kind='llm_call'),
                       (SELECT COUNT(*) FROM spans WHERE trace_id=?1 AND kind='tool_call'),
                       (SELECT COUNT(*) FROM spans WHERE trace_id=?1 AND kind='embedding'),
                       COALESCE((SELECT MAX(depth) FROM spans WHERE trace_id=?1),0)
                   FROM spans s LEFT JOIN llm_calls l USING(span_id)
                   WHERE s.trace_id=?1"#,
                params![trace_id],
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                    ))
                },
            ).map_err(Into::into);
            let (cost, in_tok, out_tok, rea_tok, cr_tok, cw_tok, n_llm, n_tool, n_emb, max_depth) =
                rollup?;
            let started: i64 = conn.query_row(
                "SELECT started_at_ms FROM traces WHERE trace_id=?1",
                params![trace_id],
                |row| row.get(0),
            )?;
            conn.execute(
                r#"UPDATE traces SET
                    ended_at_ms=?1, wall_duration_ms=?2, outcome=?3, outcome_summary=?4,
                    total_cost_usd=?5, total_input_tokens=?6, total_output_tokens=?7,
                    total_reasoning_tokens=?8, total_cache_read_tokens=?9, total_cache_write_tokens=?10,
                    total_llm_calls=?11, total_tool_calls=?12, total_embeddings=?13, max_depth=?14
                   WHERE trace_id=?15"#,
                params![
                    ended_at_ms,
                    ended_at_ms - started,
                    outcome,
                    outcome_summary,
                    cost,
                    in_tok,
                    out_tok,
                    rea_tok,
                    cr_tok,
                    cw_tok,
                    n_llm,
                    n_tool,
                    n_emb,
                    max_depth,
                    trace_id
                ],
            )?;
        }
        WriterMsg::OpenSpan {
            span_id,
            trace_id,
            parent_span_id,
            kind,
            agent_pubkey,
            agent_slug,
            agent_role,
            depth,
            started_at_ms,
            attributes_json,
        } => {
            conn.execute(
                r#"INSERT INTO spans(
                    span_id, trace_id, parent_span_id, kind, agent_pubkey, agent_slug, agent_role,
                    started_at_ms, depth, status, attributes_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10)"#,
                params![
                    span_id,
                    trace_id,
                    parent_span_id,
                    kind,
                    agent_pubkey,
                    agent_slug,
                    agent_role,
                    started_at_ms,
                    depth,
                    attributes_json
                ],
            )?;
        }
        WriterMsg::InsertLlmCallStart { span_id, start } => {
            conn.execute(
                r#"INSERT INTO llm_calls(
                    span_id, provider, provider_model_id, model_family, operation,
                    api_key_label, api_key_identity,
                    queued_at_ms, n_messages_sent, n_tools_offered,
                    temperature, top_p, max_tokens_requested, seed,
                    system_prompt_hash, messages_prefix_hash
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"#,
                params![
                    span_id,
                    start.provider,
                    start.provider_model_id,
                    lookup(&start.provider, &start.provider_model_id)
                        .map(|m| m.model_family.to_string()),
                    start.operation,
                    start.api_key_label,
                    start.api_key_identity,
                    start.queued_at_ms,
                    start.n_messages_sent,
                    start.n_tools_offered,
                    start.temperature,
                    start.top_p,
                    start.max_tokens_requested,
                    start.seed,
                    start.system_prompt_hash,
                    start.messages_prefix_hash,
                ],
            )?;
            // Insert message snapshots.
            for (i, m) in start.messages.iter().enumerate() {
                let preview: String = m.content.chars().take(200).collect();
                let hash = sha256_hex(m.content.as_bytes());
                conn.execute(
                    r#"INSERT INTO llm_call_messages(
                        span_id, position, role, classification, content_hash,
                        content_preview, content_full, tokens_estimated, cache_breakpoint_after
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"#,
                    params![
                        span_id,
                        i as i64,
                        m.role,
                        m.classification,
                        hash,
                        preview,
                        m.content,
                        m.tokens_estimated,
                        m.cache_breakpoint_after as i64
                    ],
                )?;
            }
        }
        WriterMsg::UpdateLlmCallFinish {
            span_id,
            finish,
            ended_at_ms,
        } => {
            // Compute estimated cost from catalog using provider+model on the row.
            let (provider, model_id, started_at_ms): (String, String, i64) = conn.query_row(
                r#"SELECT l.provider, l.provider_model_id, s.started_at_ms
                   FROM llm_calls l JOIN spans s USING(span_id)
                   WHERE l.span_id=?1"#,
                params![span_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let entry = lookup(&provider, &model_id);
            let pricing = entry.map(|e| e.pricing).unwrap_or_default();
            let tokens = TokenCounts {
                input: finish.input_tokens,
                output: finish.output_tokens,
                cache_read: finish.cache_read_tokens,
                cache_write: finish.cache_write_tokens,
                reasoning: finish.reasoning_tokens,
            };
            let breakdown = estimate_cost(&pricing, &tokens);
            let estimated = breakdown.total();
            let drift_value = finish.total_cost_usd_provider.map(|p| p - estimated);
            // Shadow cost for local providers.
            let (shadow_cost, shadow_ref) = if matches!(provider.as_str(), "ollama") {
                let r = pricing::shadow_reference_for(&provider, &model_id);
                let v = r
                    .map(|m| {
                        estimate_cost(&m.pricing, &tokens).total()
                            + if m.pricing.embedding_per_mtok > 0.0 {
                                estimate_embedding_cost(&m.pricing, finish.input_tokens)
                            } else {
                                0.0
                            }
                    })
                    .unwrap_or(0.0);
                (
                    Some(v),
                    r.map(|m| format!("{}/{}", m.provider, m.provider_model_id)),
                )
            } else {
                (None, None)
            };
            let total_latency_ms = ended_at_ms - started_at_ms;
            let tps = if total_latency_ms > 0 && finish.output_tokens > 0 {
                Some(finish.output_tokens as f64 * 1000.0 / total_latency_ms as f64)
            } else {
                None
            };
            conn.execute(
                r#"UPDATE llm_calls SET
                    input_tokens=?1, output_tokens=?2, reasoning_tokens=?3,
                    cache_read_tokens=?4, cache_write_tokens=?5, cached_input_tokens=?6,
                    prompt_tokens_cost_usd=?7, output_tokens_cost_usd=?8,
                    cache_read_cost_usd=?9, cache_write_cost_usd=?10,
                    reasoning_tokens_cost_usd=?11,
                    total_cost_usd_provider=?12, total_cost_usd_estimated=?13,
                    cost_drift_usd=?14,
                    ttft_ms=?15, total_latency_ms=?16, output_tokens_per_second=?17,
                    finish_reason=?18, openrouter_provider=?19, openrouter_generation_id=?20,
                    openrouter_native_finish_reason=?21,
                    n_tools_called=?22, was_truncated=?23, refusal_detected=?24,
                    load_duration_ns=?25, eval_duration_ns=?26, prompt_eval_duration_ns=?27,
                    tokens_per_sec_eval=?28, model_loaded_from_cold=?29,
                    shadow_cost_usd=?30, shadow_cost_reference_model=?31
                   WHERE span_id=?32"#,
                params![
                    finish.input_tokens as i64,
                    finish.output_tokens as i64,
                    finish.reasoning_tokens as i64,
                    finish.cache_read_tokens as i64,
                    finish.cache_write_tokens as i64,
                    finish.cached_input_tokens as i64,
                    breakdown.prompt,
                    breakdown.output,
                    breakdown.cache_read,
                    breakdown.cache_write,
                    breakdown.reasoning,
                    finish.total_cost_usd_provider,
                    estimated,
                    drift_value,
                    finish.ttft_ms,
                    total_latency_ms,
                    tps,
                    finish.finish_reason,
                    finish.openrouter_provider,
                    finish.openrouter_generation_id,
                    finish.openrouter_native_finish_reason,
                    finish.n_tools_called,
                    finish.was_truncated as i64,
                    finish.refusal_detected as i64,
                    finish.load_duration_ns,
                    finish.eval_duration_ns,
                    finish.prompt_eval_duration_ns,
                    None::<f64>, // tokens_per_sec_eval below
                    finish.model_loaded_from_cold.map(|b| b as i64),
                    shadow_cost,
                    shadow_ref,
                    span_id
                ],
            )?;
            // Compute Ollama tokens/sec separately so we don't overload the
            // big UPDATE; conditional and small.
            if let (Some(eval_dur), out) = (finish.eval_duration_ns, finish.output_tokens) {
                if eval_dur > 0 && out > 0 {
                    let tps = out as f64 / (eval_dur as f64 / 1_000_000_000.0);
                    conn.execute(
                        "UPDATE llm_calls SET tokens_per_sec_eval=?1 WHERE span_id=?2",
                        params![tps, span_id],
                    )?;
                }
            }
            conn.execute(
                "UPDATE spans SET ended_at_ms=?1, duration_ms=?2, status='ok' WHERE span_id=?3",
                params![ended_at_ms, total_latency_ms, span_id],
            )?;
        }
        WriterMsg::InsertToolCallStart { span_id, start } => {
            let preview: Option<String> = start
                .args
                .as_ref()
                .map(|s| s.chars().take(400).collect::<String>());
            let args_hash = start.args.as_ref().map(|s| sha256_hex(s.as_bytes()));
            let args_size = start.args.as_ref().map(|s| s.len() as i64);
            conn.execute(
                r#"INSERT INTO tool_calls(
                    span_id, parent_llm_call_span_id, tool_name, tool_namespace,
                    args_hash, args_size_bytes, args_preview
                ) VALUES (?1,?2,?3,?4,?5,?6,?7)"#,
                params![
                    span_id,
                    start.parent_llm_call_span_id,
                    start.tool_name,
                    start.tool_namespace,
                    args_hash,
                    args_size,
                    preview,
                ],
            )?;
        }
        WriterMsg::UpdateToolCallFinish {
            span_id,
            finish,
            ended_at_ms,
        } => {
            let started_at: i64 = conn.query_row(
                "SELECT started_at_ms FROM spans WHERE span_id=?1",
                params![span_id],
                |row| row.get(0),
            )?;
            let dur = ended_at_ms - started_at;
            conn.execute(
                r#"UPDATE tool_calls SET
                    result_status=?1, result_size_bytes=?2, result_preview=?3,
                    duration_ms=?4, was_invalid=?5, validation_errors=?6
                   WHERE span_id=?7"#,
                params![
                    finish.result_status,
                    finish.result_size_bytes,
                    finish.result_preview,
                    dur,
                    finish.was_invalid as i64,
                    finish.validation_errors,
                    span_id
                ],
            )?;
            let status = if finish.was_invalid { "error" } else { "ok" };
            conn.execute(
                "UPDATE spans SET ended_at_ms=?1, duration_ms=?2, status=?3 WHERE span_id=?4",
                params![ended_at_ms, dur, status, span_id],
            )?;
        }
        WriterMsg::InsertEmbeddingStart { span_id, start } => {
            conn.execute(
                r#"INSERT INTO embeddings(
                    span_id, provider, model, batch_size, total_input_chars,
                    source_kind, source_event_kind, source_event_id, vector_storage_target
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"#,
                params![
                    span_id,
                    start.provider,
                    start.model,
                    start.batch_size,
                    start.total_input_chars,
                    start.source_kind,
                    start.source_event_kind,
                    start.source_event_id,
                    start.vector_storage_target
                ],
            )?;
        }
        WriterMsg::UpdateEmbeddingFinish {
            span_id,
            finish,
            ended_at_ms,
        } => {
            let (provider, model, started_at): (String, String, i64) = conn.query_row(
                r#"SELECT e.provider, e.model, s.started_at_ms
                   FROM embeddings e JOIN spans s USING(span_id)
                   WHERE e.span_id=?1"#,
                params![span_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let pricing = lookup(&provider, &model)
                .map(|e| e.pricing)
                .unwrap_or_default();
            let cost = estimate_embedding_cost(&pricing, finish.total_input_tokens);
            let cost_per_mtok = pricing.embedding_per_mtok;
            let dur = ended_at_ms - started_at;
            let tps = if dur > 0 && finish.total_input_tokens > 0 {
                Some(finish.total_input_tokens as f64 * 1000.0 / dur as f64)
            } else {
                None
            };
            conn.execute(
                r#"UPDATE embeddings SET
                    total_input_tokens=?1, dimension=?2, cost_usd=?3,
                    cost_per_million_tokens=?4, throughput_tokens_per_sec=?5,
                    dedup_skipped_count=?6
                   WHERE span_id=?7"#,
                params![
                    finish.total_input_tokens as i64,
                    finish.dimension,
                    cost,
                    cost_per_mtok,
                    tps,
                    finish.dedup_skipped_count,
                    span_id
                ],
            )?;
            conn.execute(
                "UPDATE spans SET ended_at_ms=?1, duration_ms=?2, status='ok' WHERE span_id=?3",
                params![ended_at_ms, dur, span_id],
            )?;
        }
        WriterMsg::FinishSpanError {
            span_id,
            error_class,
            error_message,
            ended_at_ms,
        } => {
            let started_at: i64 = conn.query_row(
                "SELECT started_at_ms FROM spans WHERE span_id=?1",
                params![span_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "UPDATE spans SET ended_at_ms=?1, duration_ms=?2, status='error', error_class=?3, error_message=?4 WHERE span_id=?5",
                params![ended_at_ms, ended_at_ms - started_at, error_class, error_message, span_id],
            )?;
        }
        WriterMsg::Flush { ack } => {
            let _ = ack.send(());
        }
    }
    Ok(())
}

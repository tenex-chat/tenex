//! Read-only query API. Opens the SQLite db read-only and returns typed rows.
//!
//! Used by both the CLI (`tenex accounting cost ...`) and the embedded HTTP
//! server. All queries hit base tables — there are no materialized views in v1.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::agent_labels::AgentLabels;

mod agent_cost;
mod service_cost;

#[derive(Clone)]
pub struct QueryService {
    db_path: PathBuf,
    agent_labels: AgentLabels,
}

impl QueryService {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
            agent_labels: AgentLabels::default(),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn with_agent_slugs(mut self, slugs: impl IntoIterator<Item = (String, String)>) -> Self {
        self.agent_labels = AgentLabels::from_slugs(slugs);
        self
    }

    /// Open a read-only connection. Caller is one-shot per query.
    fn open(&self) -> Result<Connection> {
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("open accounting db read-only: {}", self.db_path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
    }

    pub fn list_traces(&self, filter: TraceFilter) -> Result<Vec<TraceSummary>> {
        let conn = self.open()?;
        let mut sql = String::from(
            r#"SELECT trace_id, root_kind, label, project_id, conversation_id, user_pubkey,
                      started_at_ms, ended_at_ms, wall_duration_ms, outcome, total_cost_usd,
                      total_input_tokens, total_output_tokens, total_reasoning_tokens,
                      total_cache_read_tokens, total_cache_write_tokens,
                      total_llm_calls, total_tool_calls, total_embeddings, max_depth
               FROM traces WHERE 1=1"#,
        );
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(s) = filter.since_ms {
            sql.push_str(" AND started_at_ms >= ?");
            args.push(s.into());
        }
        if let Some(p) = filter.project_id {
            sql.push_str(" AND project_id = ?");
            args.push(p.into());
        }
        if let Some(c) = filter.conversation_id {
            sql.push_str(" AND conversation_id = ?");
            args.push(c.into());
        }
        if let Some(o) = filter.outcome {
            sql.push_str(" AND outcome = ?");
            args.push(o.into());
        }
        if let Some(rk) = filter.root_kind {
            sql.push_str(" AND root_kind = ?");
            args.push(rk.into());
        }
        sql.push_str(" ORDER BY started_at_ms DESC LIMIT ?");
        args.push((filter.limit.unwrap_or(100) as i64).into());

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |row| {
                Ok(TraceSummary {
                    trace_id: row.get(0)?,
                    root_kind: row.get(1)?,
                    label: row.get(2)?,
                    project_id: row.get(3)?,
                    conversation_id: row.get(4)?,
                    user_pubkey: row.get(5)?,
                    started_at_ms: row.get(6)?,
                    ended_at_ms: row.get(7)?,
                    wall_duration_ms: row.get(8)?,
                    outcome: row.get(9)?,
                    total_cost_usd: row.get(10)?,
                    total_input_tokens: row.get(11)?,
                    total_output_tokens: row.get(12)?,
                    total_reasoning_tokens: row.get(13)?,
                    total_cache_read_tokens: row.get(14)?,
                    total_cache_write_tokens: row.get(15)?,
                    total_llm_calls: row.get(16)?,
                    total_tool_calls: row.get(17)?,
                    total_embeddings: row.get(18)?,
                    max_depth: row.get(19)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_trace(&self, trace_id: &str) -> Result<Option<TraceDetail>> {
        let conn = self.open()?;
        let trace = conn
            .query_row(
                r#"SELECT trace_id, root_kind, label, project_id, conversation_id, user_pubkey,
                          started_at_ms, ended_at_ms, wall_duration_ms, outcome, total_cost_usd,
                          total_input_tokens, total_output_tokens, total_reasoning_tokens,
                          total_cache_read_tokens, total_cache_write_tokens,
                          total_llm_calls, total_tool_calls, total_embeddings, max_depth
                   FROM traces WHERE trace_id=?1"#,
                params![trace_id],
                |row| {
                    Ok(TraceSummary {
                        trace_id: row.get(0)?,
                        root_kind: row.get(1)?,
                        label: row.get(2)?,
                        project_id: row.get(3)?,
                        conversation_id: row.get(4)?,
                        user_pubkey: row.get(5)?,
                        started_at_ms: row.get(6)?,
                        ended_at_ms: row.get(7)?,
                        wall_duration_ms: row.get(8)?,
                        outcome: row.get(9)?,
                        total_cost_usd: row.get(10)?,
                        total_input_tokens: row.get(11)?,
                        total_output_tokens: row.get(12)?,
                        total_reasoning_tokens: row.get(13)?,
                        total_cache_read_tokens: row.get(14)?,
                        total_cache_write_tokens: row.get(15)?,
                        total_llm_calls: row.get(16)?,
                        total_tool_calls: row.get(17)?,
                        total_embeddings: row.get(18)?,
                        max_depth: row.get(19)?,
                    })
                },
            )
            .ok();
        let Some(trace) = trace else { return Ok(None) };

        let spans = self.list_spans_for_trace_with_conn(&conn, trace_id)?;
        Ok(Some(TraceDetail { trace, spans }))
    }

    fn list_spans_for_trace_with_conn(
        &self,
        conn: &Connection,
        trace_id: &str,
    ) -> Result<Vec<SpanDetail>> {
        let mut stmt = conn.prepare(
            r#"SELECT s.span_id, s.parent_span_id, s.kind, s.agent_pubkey, s.agent_slug,
                      s.agent_role, s.started_at_ms, s.ended_at_ms, s.duration_ms, s.depth,
                      s.status, s.error_class, s.error_message,
                      l.provider, l.provider_model_id, l.operation,
                      l.input_tokens, l.output_tokens, l.reasoning_tokens,
                      l.cache_read_tokens, l.cache_write_tokens,
                      l.total_cost_usd_provider, l.total_cost_usd_estimated, l.cost_drift_usd,
                      l.shadow_cost_usd, l.shadow_cost_reference_model,
                      l.ttft_ms, l.output_tokens_per_second, l.finish_reason,
                      l.openrouter_provider, l.openrouter_generation_id,
                      tc.tool_name, tc.duration_ms, tc.was_invalid, tc.result_status,
                      tc.args_preview, tc.result_preview,
                      e.provider, e.model, e.dimension, e.batch_size,
                      e.total_input_tokens, e.cost_usd, e.throughput_tokens_per_sec
               FROM spans s
               LEFT JOIN llm_calls l USING(span_id)
               LEFT JOIN tool_calls tc USING(span_id)
               LEFT JOIN embeddings e USING(span_id)
               WHERE s.trace_id=?1
               ORDER BY s.started_at_ms ASC"#,
        )?;
        let rows = stmt
            .query_map(params![trace_id], |row| {
                Ok(SpanDetail {
                    span_id: row.get(0)?,
                    parent_span_id: row.get(1)?,
                    kind: row.get(2)?,
                    agent_pubkey: row.get(3)?,
                    agent_slug: row.get(4)?,
                    agent_role: row.get(5)?,
                    started_at_ms: row.get(6)?,
                    ended_at_ms: row.get(7)?,
                    duration_ms: row.get(8)?,
                    depth: row.get(9)?,
                    status: row.get(10)?,
                    error_class: row.get(11)?,
                    error_message: row.get(12)?,
                    llm: LlmCallSummary::from_optional(
                        row.get::<_, Option<String>>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, Option<String>>(15)?,
                        row.get::<_, Option<i64>>(16)?,
                        row.get::<_, Option<i64>>(17)?,
                        row.get::<_, Option<i64>>(18)?,
                        row.get::<_, Option<i64>>(19)?,
                        row.get::<_, Option<i64>>(20)?,
                        row.get::<_, Option<f64>>(21)?,
                        row.get::<_, Option<f64>>(22)?,
                        row.get::<_, Option<f64>>(23)?,
                        row.get::<_, Option<f64>>(24)?,
                        row.get::<_, Option<String>>(25)?,
                        row.get::<_, Option<i64>>(26)?,
                        row.get::<_, Option<f64>>(27)?,
                        row.get::<_, Option<String>>(28)?,
                        row.get::<_, Option<String>>(29)?,
                        row.get::<_, Option<String>>(30)?,
                    ),
                    tool: ToolCallSummary::from_optional(
                        row.get::<_, Option<String>>(31)?,
                        row.get::<_, Option<i64>>(32)?,
                        row.get::<_, Option<i64>>(33)?,
                        row.get::<_, Option<String>>(34)?,
                        row.get::<_, Option<String>>(35)?,
                        row.get::<_, Option<String>>(36)?,
                    ),
                    embedding: EmbeddingSummary::from_optional(
                        row.get::<_, Option<String>>(37)?,
                        row.get::<_, Option<String>>(38)?,
                        row.get::<_, Option<i64>>(39)?,
                        row.get::<_, Option<i64>>(40)?,
                        row.get::<_, Option<i64>>(41)?,
                        row.get::<_, Option<f64>>(42)?,
                        row.get::<_, Option<f64>>(43)?,
                    ),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn cost_by_provider(&self, since_ms: Option<i64>) -> Result<Vec<ProviderCostRow>> {
        let conn = self.open()?;
        let sql = r#"
            SELECT
                l.provider,
                COUNT(*) AS calls,
                COALESCE(SUM(l.input_tokens),0) AS input_tokens,
                COALESCE(SUM(l.output_tokens),0) AS output_tokens,
                COALESCE(SUM(l.reasoning_tokens),0) AS reasoning_tokens,
                COALESCE(SUM(l.cache_read_tokens),0) AS cache_read_tokens,
                COALESCE(SUM(l.cache_write_tokens),0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(l.total_cost_usd_provider, l.total_cost_usd_estimated)),0) AS cost,
                COALESCE(SUM(l.total_cost_usd_estimated),0) AS cost_estimated,
                COALESCE(SUM(l.shadow_cost_usd),0) AS shadow_cost
            FROM llm_calls l
            JOIN spans s USING(span_id)
            WHERE s.started_at_ms >= ?1
            GROUP BY l.provider
            ORDER BY cost DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![since_ms.unwrap_or(0)], |row| {
                Ok(ProviderCostRow {
                    provider: row.get(0)?,
                    calls: row.get(1)?,
                    input_tokens: row.get(2)?,
                    output_tokens: row.get(3)?,
                    reasoning_tokens: row.get(4)?,
                    cache_read_tokens: row.get(5)?,
                    cache_write_tokens: row.get(6)?,
                    cost_usd: row.get(7)?,
                    cost_estimated_usd: row.get(8)?,
                    shadow_cost_usd: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn cost_by_model(&self, since_ms: Option<i64>) -> Result<Vec<ModelCostRow>> {
        let conn = self.open()?;
        let sql = r#"
            SELECT
                l.provider, l.provider_model_id, l.model_family,
                COUNT(*) AS calls,
                COALESCE(SUM(l.input_tokens),0),
                COALESCE(SUM(l.output_tokens),0),
                COALESCE(SUM(l.cache_read_tokens),0),
                COALESCE(SUM(COALESCE(l.total_cost_usd_provider, l.total_cost_usd_estimated)),0),
                AVG(l.total_latency_ms),
                AVG(l.output_tokens_per_second),
                AVG(l.ttft_ms)
            FROM llm_calls l
            JOIN spans s USING(span_id)
            WHERE s.started_at_ms >= ?1
            GROUP BY l.provider, l.provider_model_id
            ORDER BY 8 DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![since_ms.unwrap_or(0)], |row| {
                Ok(ModelCostRow {
                    provider: row.get(0)?,
                    provider_model_id: row.get(1)?,
                    model_family: row.get(2)?,
                    calls: row.get(3)?,
                    input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                    cache_read_tokens: row.get(6)?,
                    cost_usd: row.get(7)?,
                    avg_latency_ms: row.get(8)?,
                    avg_output_tps: row.get(9)?,
                    avg_ttft_ms: row.get(10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn embedding_summary(&self, since_ms: Option<i64>) -> Result<Vec<EmbeddingSummaryRow>> {
        let conn = self.open()?;
        let sql = r#"
            SELECT e.provider, e.model,
                   COUNT(*),
                   COALESCE(SUM(e.batch_size),0),
                   COALESCE(SUM(e.total_input_tokens),0),
                   COALESCE(SUM(e.cost_usd),0),
                   AVG(e.throughput_tokens_per_sec)
            FROM embeddings e
            JOIN spans s USING(span_id)
            WHERE s.started_at_ms >= ?1
            GROUP BY e.provider, e.model
            ORDER BY 6 DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![since_ms.unwrap_or(0)], |row| {
                Ok(EmbeddingSummaryRow {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    spans: row.get(2)?,
                    items: row.get(3)?,
                    tokens: row.get(4)?,
                    cost_usd: row.get(5)?,
                    avg_throughput: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn overview(&self, since_ms: Option<i64>) -> Result<Overview> {
        let conn = self.open()?;
        let cutoff = since_ms.unwrap_or(0);
        let (traces_total, traces_completed, traces_errored): (i64, i64, i64) = conn.query_row(
            r#"SELECT
                 COUNT(*),
                 SUM(CASE WHEN outcome='completed' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN outcome='errored' THEN 1 ELSE 0 END)
               FROM traces WHERE started_at_ms >= ?1"#,
            params![cutoff],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ))
            },
        )?;
        let total_cost: f64 = conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd),0) FROM traces WHERE started_at_ms >= ?1",
            params![cutoff],
            |row| row.get(0),
        )?;
        let llm_calls: i64 = conn.query_row(
            r#"SELECT COUNT(*) FROM spans WHERE kind='llm_call' AND started_at_ms >= ?1"#,
            params![cutoff],
            |row| row.get(0),
        )?;
        let embeddings: i64 = conn.query_row(
            r#"SELECT COUNT(*) FROM spans WHERE kind='embedding' AND started_at_ms >= ?1"#,
            params![cutoff],
            |row| row.get(0),
        )?;
        let tool_calls: i64 = conn.query_row(
            r#"SELECT COUNT(*) FROM spans WHERE kind='tool_call' AND started_at_ms >= ?1"#,
            params![cutoff],
            |row| row.get(0),
        )?;
        let cost_by_provider = self.cost_by_provider(since_ms)?;
        Ok(Overview {
            since_ms: cutoff,
            traces_total,
            traces_completed,
            traces_errored,
            total_cost_usd: total_cost,
            llm_calls,
            embeddings,
            tool_calls,
            cost_by_provider,
        })
    }

    pub fn recent_llm_calls(&self, limit: i64) -> Result<Vec<RecentLlmCall>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            r#"SELECT s.span_id, s.trace_id, s.started_at_ms, s.duration_ms, s.status,
                      l.provider, l.provider_model_id, l.input_tokens, l.output_tokens,
                      COALESCE(l.total_cost_usd_provider, l.total_cost_usd_estimated) AS cost,
                      l.finish_reason, s.agent_pubkey, s.agent_slug
               FROM llm_calls l JOIN spans s USING(span_id)
               ORDER BY s.started_at_ms DESC LIMIT ?1"#,
        )?;
        let rows = stmt
            .query_map(params![limit], |row| {
                let agent_pubkey: Option<String> = row.get(11)?;
                let recorded_slug: Option<String> = row.get(12)?;
                Ok(RecentLlmCall {
                    span_id: row.get(0)?,
                    trace_id: row.get(1)?,
                    started_at_ms: row.get(2)?,
                    duration_ms: row.get(3)?,
                    status: row.get(4)?,
                    provider: row.get(5)?,
                    provider_model_id: row.get(6)?,
                    input_tokens: row.get(7)?,
                    output_tokens: row.get(8)?,
                    cost_usd: row.get(9)?,
                    finish_reason: row.get(10)?,
                    agent_slug: self
                        .agent_labels
                        .slug(agent_pubkey.as_deref(), recorded_slug.as_deref()),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn span_messages(&self, span_id: &str) -> Result<Vec<SpanMessage>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            r#"SELECT position, role, classification, content_hash, content_preview,
                      content_full, tokens_estimated, cache_breakpoint_after
               FROM llm_call_messages WHERE span_id=?1 ORDER BY position ASC"#,
        )?;
        let rows = stmt
            .query_map(params![span_id], |row| {
                Ok(SpanMessage {
                    position: row.get(0)?,
                    role: row.get(1)?,
                    classification: row.get(2)?,
                    content_hash: row.get(3)?,
                    content_preview: row.get(4)?,
                    content_full: row.get(5)?,
                    tokens_estimated: row.get(6)?,
                    cache_breakpoint_after: row.get::<_, i64>(7)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[derive(Debug, Default, Clone)]
pub struct TraceFilter {
    pub since_ms: Option<i64>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub outcome: Option<String>,
    pub root_kind: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceSummary {
    pub trace_id: String,
    pub root_kind: String,
    pub label: Option<String>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub user_pubkey: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub wall_duration_ms: Option<i64>,
    pub outcome: String,
    pub total_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_reasoning_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
    pub total_llm_calls: i64,
    pub total_tool_calls: i64,
    pub total_embeddings: i64,
    pub max_depth: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceDetail {
    pub trace: TraceSummary,
    pub spans: Vec<SpanDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanDetail {
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub kind: String,
    pub agent_pubkey: Option<String>,
    pub agent_slug: Option<String>,
    pub agent_role: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub depth: i64,
    pub status: String,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub llm: Option<LlmCallSummary>,
    pub tool: Option<ToolCallSummary>,
    pub embedding: Option<EmbeddingSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCallSummary {
    pub provider: String,
    pub provider_model_id: String,
    pub operation: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_cost_usd_provider: Option<f64>,
    pub total_cost_usd_estimated: Option<f64>,
    pub cost_drift_usd: Option<f64>,
    pub shadow_cost_usd: Option<f64>,
    pub shadow_cost_reference_model: Option<String>,
    pub ttft_ms: Option<i64>,
    pub output_tokens_per_second: Option<f64>,
    pub finish_reason: Option<String>,
    pub openrouter_provider: Option<String>,
    pub openrouter_generation_id: Option<String>,
}

impl LlmCallSummary {
    #[allow(clippy::too_many_arguments)]
    fn from_optional(
        provider: Option<String>,
        model_id: Option<String>,
        operation: Option<String>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        reasoning_tokens: Option<i64>,
        cache_read_tokens: Option<i64>,
        cache_write_tokens: Option<i64>,
        total_cost_usd_provider: Option<f64>,
        total_cost_usd_estimated: Option<f64>,
        cost_drift_usd: Option<f64>,
        shadow_cost_usd: Option<f64>,
        shadow_cost_reference_model: Option<String>,
        ttft_ms: Option<i64>,
        output_tokens_per_second: Option<f64>,
        finish_reason: Option<String>,
        openrouter_provider: Option<String>,
        openrouter_generation_id: Option<String>,
    ) -> Option<Self> {
        let provider = provider?;
        Some(Self {
            provider,
            provider_model_id: model_id?,
            operation: operation.unwrap_or_default(),
            input_tokens: input_tokens.unwrap_or(0),
            output_tokens: output_tokens.unwrap_or(0),
            reasoning_tokens: reasoning_tokens.unwrap_or(0),
            cache_read_tokens: cache_read_tokens.unwrap_or(0),
            cache_write_tokens: cache_write_tokens.unwrap_or(0),
            total_cost_usd_provider,
            total_cost_usd_estimated,
            cost_drift_usd,
            shadow_cost_usd,
            shadow_cost_reference_model,
            ttft_ms,
            output_tokens_per_second,
            finish_reason,
            openrouter_provider,
            openrouter_generation_id,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallSummary {
    pub tool_name: String,
    pub duration_ms: Option<i64>,
    pub was_invalid: bool,
    pub result_status: Option<String>,
    pub args_preview: Option<String>,
    pub result_preview: Option<String>,
}

impl ToolCallSummary {
    fn from_optional(
        tool_name: Option<String>,
        duration_ms: Option<i64>,
        was_invalid: Option<i64>,
        result_status: Option<String>,
        args_preview: Option<String>,
        result_preview: Option<String>,
    ) -> Option<Self> {
        let tool_name = tool_name?;
        Some(Self {
            tool_name,
            duration_ms,
            was_invalid: was_invalid.unwrap_or(0) != 0,
            result_status,
            args_preview,
            result_preview,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingSummary {
    pub provider: String,
    pub model: String,
    pub dimension: Option<i64>,
    pub batch_size: i64,
    pub total_input_tokens: i64,
    pub cost_usd: f64,
    pub throughput_tokens_per_sec: Option<f64>,
}

impl EmbeddingSummary {
    fn from_optional(
        provider: Option<String>,
        model: Option<String>,
        dimension: Option<i64>,
        batch_size: Option<i64>,
        total_input_tokens: Option<i64>,
        cost_usd: Option<f64>,
        throughput_tokens_per_sec: Option<f64>,
    ) -> Option<Self> {
        let provider = provider?;
        Some(Self {
            provider,
            model: model?,
            dimension,
            batch_size: batch_size.unwrap_or(0),
            total_input_tokens: total_input_tokens.unwrap_or(0),
            cost_usd: cost_usd.unwrap_or(0.0),
            throughput_tokens_per_sec,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCostRow {
    pub provider: String,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
    pub cost_estimated_usd: f64,
    pub shadow_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCostRow {
    pub provider: String,
    pub provider_model_id: String,
    pub model_family: Option<String>,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cost_usd: f64,
    pub avg_latency_ms: Option<f64>,
    pub avg_output_tps: Option<f64>,
    pub avg_ttft_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceCostRow {
    pub service: String,
    pub traces: i64,
    pub llm_calls: i64,
    pub tool_calls: i64,
    pub embeddings: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
    pub avg_duration_ms: Option<f64>,
    pub errored: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCostRow {
    pub agent: String,
    pub agent_pubkey: Option<String>,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingSummaryRow {
    pub provider: String,
    pub model: String,
    pub spans: i64,
    pub items: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub avg_throughput: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Overview {
    pub since_ms: i64,
    pub traces_total: i64,
    pub traces_completed: i64,
    pub traces_errored: i64,
    pub total_cost_usd: f64,
    pub llm_calls: i64,
    pub embeddings: i64,
    pub tool_calls: i64,
    pub cost_by_provider: Vec<ProviderCostRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentLlmCall {
    pub span_id: String,
    pub trace_id: String,
    pub started_at_ms: i64,
    pub duration_ms: Option<i64>,
    pub status: String,
    pub provider: String,
    pub provider_model_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: Option<f64>,
    pub finish_reason: Option<String>,
    pub agent_slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanMessage {
    pub position: i64,
    pub role: String,
    pub classification: Option<String>,
    pub content_hash: String,
    pub content_preview: Option<String>,
    pub content_full: Option<String>,
    pub tokens_estimated: Option<i64>,
    pub cache_breakpoint_after: bool,
}

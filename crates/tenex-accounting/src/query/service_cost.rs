use anyhow::Result;
use rusqlite::params;

use super::{QueryService, ServiceCostRow};

impl QueryService {
    pub fn cost_by_service(&self, since_ms: Option<i64>) -> Result<Vec<ServiceCostRow>> {
        let conn = self.open()?;
        let sql = r#"
            SELECT
                root_kind,
                COUNT(*) AS traces,
                COALESCE(SUM(total_llm_calls),0) AS llm_calls,
                COALESCE(SUM(total_tool_calls),0) AS tool_calls,
                COALESCE(SUM(total_embeddings),0) AS embeddings,
                COALESCE(SUM(total_input_tokens),0) AS input_tokens,
                COALESCE(SUM(total_output_tokens),0) AS output_tokens,
                COALESCE(SUM(total_cache_read_tokens),0) AS cache_read_tokens,
                COALESCE(SUM(total_cache_write_tokens),0) AS cache_write_tokens,
                COALESCE(SUM(total_cost_usd),0) AS cost_usd,
                AVG(wall_duration_ms) AS avg_duration_ms,
                SUM(CASE WHEN outcome='errored' THEN 1 ELSE 0 END) AS errored
            FROM traces
            WHERE started_at_ms >= ?1
            GROUP BY root_kind
            ORDER BY cost_usd DESC, traces DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![since_ms.unwrap_or(0)], |row| {
                Ok(ServiceCostRow {
                    service: row.get(0)?,
                    traces: row.get(1)?,
                    llm_calls: row.get(2)?,
                    tool_calls: row.get(3)?,
                    embeddings: row.get(4)?,
                    input_tokens: row.get(5)?,
                    output_tokens: row.get(6)?,
                    cache_read_tokens: row.get(7)?,
                    cache_write_tokens: row.get(8)?,
                    cost_usd: row.get(9)?,
                    avg_duration_ms: row.get(10)?,
                    errored: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

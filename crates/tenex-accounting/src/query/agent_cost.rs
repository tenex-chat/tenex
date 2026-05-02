use anyhow::Result;
use rusqlite::params;

use super::{AgentCostRow, QueryService};

impl QueryService {
    pub fn cost_by_agent(&self, since_ms: Option<i64>) -> Result<Vec<AgentCostRow>> {
        let conn = self.open()?;
        let sql = r#"
            SELECT
                COALESCE(NULLIF(s.agent_pubkey,''), NULLIF(s.agent_slug,''), '<unknown>') AS agent_key,
                MAX(NULLIF(s.agent_pubkey,'')) AS agent_pubkey,
                MAX(NULLIF(s.agent_slug,'')) AS agent_slug,
                COUNT(*) AS calls,
                COALESCE(SUM(l.input_tokens),0),
                COALESCE(SUM(l.output_tokens),0),
                COALESCE(SUM(COALESCE(l.total_cost_usd_provider, l.total_cost_usd_estimated)),0)
            FROM llm_calls l
            JOIN spans s USING(span_id)
            WHERE s.started_at_ms >= ?1
            GROUP BY agent_key
            ORDER BY 7 DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![since_ms.unwrap_or(0)], |row| {
                let agent_key: String = row.get(0)?;
                let agent_pubkey: Option<String> = row.get(1)?;
                let recorded_slug: Option<String> = row.get(2)?;
                Ok(AgentCostRow {
                    agent: self.agent_labels.label(
                        agent_pubkey.as_deref(),
                        recorded_slug.as_deref(),
                        &agent_key,
                    ),
                    agent_pubkey,
                    calls: row.get(3)?,
                    input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                    cost_usd: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

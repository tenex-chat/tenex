//! Tool-result decay.
//!
//! Tool result messages whose originating tool has `preserve_results: true`
//! are *never* evicted. Results from tools with `preserve_results: false`,
//! or from tools no longer present in the current `tool_defs` (e.g., a
//! deactivated built-in skill), are eligible for decay.
//!
//! Eviction keeps the [`KEEP_RECENT_RESULTS`] most recent decay-eligible
//! tool results in place; older eligible results are replaced by a
//! decay marker so the assistant→tool linkage is not severed.

use std::collections::HashMap;

use crate::strategies::{ProjectionContext, Strategy};
use crate::types::{Message, ToolDef};
use async_trait::async_trait;

const NAME: &str = "tool_result_decay";

/// Number of decay-eligible tool results retained verbatim. Older
/// eligible results are replaced by a decay marker.
const KEEP_RECENT_RESULTS: usize = 3;

#[derive(Default)]
pub struct ToolResultDecayStrategy;

#[async_trait]
impl Strategy for ToolResultDecayStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        let preserve = build_preserve_lookup(ctx.tool_defs);

        // First pass: identify decay-eligible positions, oldest-first.
        let mut eligible: Vec<usize> = Vec::new();
        for (idx, msg) in ctx.messages.iter().enumerate() {
            if let Message::ToolResult { tool_name, .. } = msg {
                let preserved = preserve.get(tool_name.as_str()).copied().unwrap_or(false);
                if !preserved {
                    eligible.push(idx);
                }
            }
        }

        if eligible.len() <= KEEP_RECENT_RESULTS {
            return Ok(());
        }

        // Decay all but the trailing KEEP_RECENT_RESULTS.
        let to_decay = eligible.len() - KEEP_RECENT_RESULTS;
        let mut evicted = 0usize;
        for &idx in eligible.iter().take(to_decay) {
            if let Message::ToolResult {
                tool_call_id,
                tool_name,
                ..
            } = &ctx.messages[idx]
            {
                let marker = Message::ToolResult {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    content: format!(
                        "[tool result decayed: {} (call {})]",
                        tool_name, tool_call_id
                    ),
                    provider_call_id: None,
                    is_error: false,
                };
                ctx.messages[idx] = marker;
                evicted += 1;
            }
        }

        if evicted > 0 {
            ctx.telemetry.evicted_count += evicted;
            ctx.telemetry.strategies_applied.push(NAME.to_string());
        }
        Ok(())
    }
}

fn build_preserve_lookup(tool_defs: &[ToolDef]) -> HashMap<&str, bool> {
    let mut map: HashMap<&str, bool> = HashMap::with_capacity(tool_defs.len());
    for def in tool_defs {
        map.insert(def.name.as_str(), def.preserve_results);
    }
    map
}

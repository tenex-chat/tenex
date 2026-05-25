use crate::skills::{self, SkillLookupCtx};
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct SkillListArgs {}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SkillListError(String);

#[derive(Clone)]
pub struct SkillListTool {
    ctx: Arc<SkillLookupCtx>,
}

impl SkillListTool {
    pub fn new(ctx: Arc<SkillLookupCtx>) -> Self {
        Self { ctx }
    }
}

impl Tool for SkillListTool {
    const NAME: &'static str = "skill_list";
    type Error = SkillListError;
    type Args = SkillListArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List all available skills grouped by scope (builtIn, agent, project, shared) with per-scope counts and total.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    async fn call(&self, _args: SkillListArgs) -> Result<String, SkillListError> {
        let all_skills = skills::list_available_skills(&self.ctx);
        let grouped = skills::group_by_scope(&all_skills);

        let scope_keys = ["builtIn", "agent", "project", "shared"];
        let mut scopes = serde_json::Map::new();
        let mut counts = serde_json::Map::new();
        let mut total = 0usize;

        for key in &scope_keys {
            let bucket = grouped.get(key).map_or(&[][..], Vec::as_slice);
            let count = bucket.len();
            total += count;
            let bucket_json: Vec<serde_json::Value> = bucket
                .iter()
                .map(|s| serde_json::to_value(s).unwrap_or(serde_json::Value::Null))
                .collect();
            scopes.insert((*key).to_string(), serde_json::Value::Array(bucket_json));
            counts.insert((*key).to_string(), serde_json::Value::Number(count.into()));
        }
        counts.insert("total".to_string(), serde_json::Value::Number(total.into()));

        let result = json!({
            "total": total,
            "scopes": scopes,
            "counts": counts,
        });

        serde_json::to_string_pretty(&result).map_err(|e| SkillListError(e.to_string()))
    }
}

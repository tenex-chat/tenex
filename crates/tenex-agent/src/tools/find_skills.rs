use crate::skills::{self, SkillLookupCtx};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct FindSkillsArgs {
    pub query: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct FindSkillsError(String);

#[derive(Clone)]
pub struct FindSkillsTool {
    ctx: Arc<SkillLookupCtx>,
}

impl FindSkillsTool {
    pub fn new(ctx: Arc<SkillLookupCtx>) -> Self {
        Self { ctx }
    }
}

fn matches_query(text: &str, query: &str) -> bool {
    let text_lower = text.to_lowercase();
    let query_lower = query.to_lowercase();

    // Split query into keywords and match all of them
    query_lower
        .split_whitespace()
        .all(|keyword| text_lower.contains(keyword))
}

impl Tool for FindSkillsTool {
    const NAME: &'static str = "find_skills";
    type Error = FindSkillsError;
    type Args = FindSkillsArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search for skills by domain or task (e.g., 'react testing', 'deploy docker', 'changelog'). Returns matching skills with names, descriptions, scopes, and installation instructions. Results are ranked by relevance.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query: keywords for the skill domain or task you need (e.g., 'react', 'testing', 'deployment')"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: FindSkillsArgs) -> Result<String, FindSkillsError> {
        let query = args.query.trim();

        if query.is_empty() {
            return Ok(json!({
                "success": false,
                "message": "Query cannot be empty. Provide keywords like 'react testing' or 'deploy'.",
                "results": []
            }).to_string());
        }

        let all_skills = skills::list_available_skills(&self.ctx);

        // Score and filter skills based on query match
        let mut matched_skills: Vec<(f32, skills::SkillData)> = all_skills
            .into_iter()
            .filter_map(|skill| {
                let mut score = 0.0f32;

                // Check skill ID (highest priority match)
                if skill.id.to_lowercase().contains(&query.to_lowercase()) {
                    score += 10.0;
                }

                // Check name (second priority)
                if let Some(ref name) = skill.frontmatter.as_ref().and_then(|fm| fm.name.as_ref()) {
                    if matches_query(name, query) {
                        score += 5.0;
                    }
                }

                // Check description
                if let Some(ref desc) = skill
                    .frontmatter
                    .as_ref()
                    .and_then(|fm| fm.description.as_ref())
                {
                    if matches_query(desc, query) {
                        score += 3.0;
                    }
                }

                // Check content body for keyword matches
                if matches_query(&skill.content, query) {
                    score += 1.0;
                }

                if score > 0.0 {
                    Some((score, skill))
                } else {
                    None
                }
            })
            .collect();

        // Sort by score (descending)
        matched_skills.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        if matched_skills.is_empty() {
            return Ok(json!({
                "success": false,
                "message": format!(
                    "No skills found matching '{query}'. Try different keywords or browse available skills with `skill_list`.",
                ),
                "results": [],
                "suggestion": "Popular skill categories: react, nextjs, testing, deploy, docker, kubernetes, changelog, documentation, design, automation"
            }).to_string());
        }

        let results: Vec<serde_json::Value> = matched_skills
            .iter()
            .map(|(_, skill)| {
                let fm = &skill.frontmatter;
                json!({
                    "id": skill.id,
                    "name": fm.as_ref().and_then(|f| f.name.as_ref()),
                    "description": fm.as_ref().and_then(|f| f.description.as_ref()),
                    "scope": skill.scope.as_key(),
                    "hasTools": fm.as_ref().map(|f| !f.tools.is_empty()).unwrap_or(false),
                    "installCommand": format_install_command(&skill.id, &self.ctx),
                })
            })
            .collect();

        let message = if results.len() == 1 {
            format!("Found 1 skill matching '{query}'.")
        } else {
            format!("Found {} skills matching '{query}'.", results.len())
        };

        Ok(json!({
            "success": true,
            "message": message,
            "results": results,
            "next": "Use `skills_set` with `add: [<skill-id>]` to activate a skill for this conversation, or check https://skills.sh/ to learn more about skills."
        }).to_string())
    }
}

/// Format installation instructions for a skill
fn format_install_command(skill_id: &str, ctx: &SkillLookupCtx) -> String {
    format!(
        "npx skills add {} --dir \"$PROJECT_BASE/.agents/{}/skills\" -y",
        skill_id,
        &ctx.agent_pubkey[..8.min(ctx.agent_pubkey.len())]
    )
}

use crate::skills::{self, SkillLookupCtx};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::Deserialize;
use serde_json::json;
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct SkillsSetArgs {
    pub add: Option<Vec<String>>,
    pub remove: Option<Vec<String>>,
    pub always: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SkillsSetError(String);

#[derive(Clone)]
pub struct SkillsSetTool {
    ctx: Arc<SkillLookupCtx>,
    self_applied: Arc<Mutex<Vec<String>>>,
}

impl SkillsSetTool {
    pub fn new(ctx: Arc<SkillLookupCtx>, self_applied: Arc<Mutex<Vec<String>>>) -> Self {
        Self { ctx, self_applied }
    }
}

impl Tool for SkillsSetTool {
    const NAME: &'static str = "skills_set";
    type Error = SkillsSetError;
    type Args = SkillsSetArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Add or remove skills for this conversation. Use `add` to activate skills and `remove` to deactivate them (or pass remove: [\"*\"] to clear all). Both fields are optional and can be combined. Only newly-added skill content is returned; use `skill_list` to find available skill identifiers.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "add": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Skill IDs to activate (merged into current set). Use IDs returned by `skill_list`."
                    },
                    "remove": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Skill IDs to deactivate. Pass [\"*\"] to clear all skills before applying `add`."
                    },
                    "always": {
                        "type": "boolean",
                        "description": "When true, persists the resulting skill set to agent config for all future conversations."
                    }
                }
            }),
        }
    }

    async fn call(&self, args: SkillsSetArgs) -> Result<String, SkillsSetError> {
        let add_ids: Vec<String> = args
            .add
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let remove_ids: Vec<String> = args
            .remove
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let always = args.always.unwrap_or(false);

        // Reject conflicting: same ID in both add and remove
        let conflicting: Vec<&String> = add_ids
            .iter()
            .filter(|id| remove_ids.contains(id))
            .collect();
        if !conflicting.is_empty() {
            let names: Vec<&str> = conflicting.iter().map(|s| s.as_str()).collect();
            return Ok(json!({
                "success": false,
                "message": format!(
                    "Conflicting intent: {} appear in both `add` and `remove`. Decide whether to add or remove, not both.",
                    names.join(", ")
                ),
                "activeSkills": [],
                "skillContent": ""
            }).to_string());
        }

        let mut current = self.self_applied.lock();

        // No-op path
        if add_ids.is_empty() && remove_ids.is_empty() {
            let msg = if current.is_empty() {
                "No skills currently active. Pass `add` to activate skills.".to_string()
            } else {
                format!(
                    "Currently active skills: {}. Pass `add` or `remove` to change.",
                    current.join(", ")
                )
            };
            return Ok(json!({
                "success": true,
                "message": msg,
                "activeSkills": current.clone(),
                "skillContent": ""
            })
            .to_string());
        }

        // Snapshot before applying remove so we can restore on add-validation failure.
        let snapshot = current.clone();

        // Apply remove
        if remove_ids.contains(&"*".to_string()) {
            current.clear();
        } else {
            current.retain(|id| !remove_ids.contains(id));
        }

        // If only remove, persist and return
        if add_ids.is_empty() {
            let final_skills = current.clone();
            drop(current); // release lock before slow ops

            if always {
                if let Err(e) =
                    skills::write_skills_to_agent_config(&self.ctx.agent_config_path, &final_skills)
                {
                    eprintln!("[skills_set] Failed to update agent config: {e}");
                }
            }

            let msg = if final_skills.is_empty() {
                "All self-applied skills cleared.".to_string()
            } else {
                format!(
                    "Removed skill(s). Active skills: {}.",
                    final_skills.join(", ")
                )
            };
            return Ok(json!({
                "success": true,
                "message": msg,
                "activeSkills": final_skills,
                "skillContent": ""
            })
            .to_string());
        }

        // Validate add IDs against available skills
        let available = skills::list_available_skills(&self.ctx);
        let available_ids: std::collections::HashSet<&str> =
            available.iter().map(|s| s.id.as_str()).collect();
        let unresolved: Vec<&str> = add_ids
            .iter()
            .filter(|id| !available_ids.contains(id.as_str()))
            .map(|s| s.as_str())
            .collect();
        if !unresolved.is_empty() {
            *current = snapshot; // restore: remove must not persist if add fails
            return Ok(json!({
                "success": false,
                "message": format!(
                    "Partial resolution rejected: {} skill(s) are not available from `skill_list`: {}. All IDs must be valid skill IDs. No changes were made.",
                    unresolved.len(),
                    unresolved.join(", ")
                ),
                "activeSkills": [],
                "skillContent": ""
            }).to_string());
        }

        // Track genuinely new IDs (not already in current set)
        let newly_added: Vec<String> = add_ids
            .iter()
            .filter(|id| !current.contains(id))
            .cloned()
            .collect();

        // Merge add into current set (deduped)
        for id in &add_ids {
            if !current.contains(id) {
                current.push(id.clone());
            }
        }
        let final_skills = current.clone();
        drop(current); // release lock before fetching skill content

        // Fetch and render only newly-added skills
        let rendered_content = if newly_added.is_empty() {
            String::new()
        } else {
            let new_skills = skills::fetch_skills(&newly_added, &self.ctx);
            if new_skills.is_empty() {
                return Ok(json!({
                    "success": false,
                    "message": format!(
                        "Could not resolve any skills from: {}",
                        newly_added.join(", ")
                    ),
                    "activeSkills": [],
                    "skillContent": ""
                })
                .to_string());
            }
            // Build path vars for rendering
            let user_home = dirs_next::home_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let agent_home = self
                .ctx
                .base_dir
                .join("home")
                .join(&self.ctx.agent_pubkey[..8.min(self.ctx.agent_pubkey.len())])
                .display()
                .to_string();
            let tenex_base = self.ctx.base_dir.display().to_string();
            let path_vars: Vec<(&str, &str)> = vec![
                ("$USER_HOME", &user_home),
                ("$AGENT_HOME", &agent_home),
                ("$TENEX_BASE_DIR", &tenex_base),
                ("$PROJECT_BASE", &self.ctx.project_path),
            ];
            new_skills
                .iter()
                .map(|s| skills::render_skill(s, &path_vars))
                .collect::<Vec<_>>()
                .join("\n\n")
        };

        if always {
            if let Err(e) =
                skills::write_skills_to_agent_config(&self.ctx.agent_config_path, &final_skills)
            {
                eprintln!("[skills_set] Failed to update agent config: {e}");
            }
        }

        let msg = if always {
            format!(
                "Activated {} skill(s): {}. Saved as always-on to agent config.",
                add_ids.len(),
                add_ids.join(", ")
            )
        } else {
            format!(
                "Activated {} skill(s): {}. Full skill content is included below — apply it immediately.",
                add_ids.len(),
                add_ids.join(", ")
            )
        };

        Ok(json!({
            "success": true,
            "message": msg,
            "activeSkills": final_skills,
            "skillContent": rendered_content
        })
        .to_string())
    }
}

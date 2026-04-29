use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tenex_project::{Project, paths};

#[derive(Debug, Deserialize, Serialize)]
pub struct ProjectListArgs {}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ProjectListError(String);

#[derive(Clone)]
pub struct ProjectListTool {
    base_dir: PathBuf,
}

impl ProjectListTool {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }
}

impl Tool for ProjectListTool {
    const NAME: &'static str = "project_list";
    type Error = ProjectListError;
    type Args = ProjectListArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List all TENEX projects available on this system, including their IDs, titles, and repository URLs. Use this before delegate_crossproject to discover project IDs and available agents.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    async fn call(&self, _args: ProjectListArgs) -> Result<String, ProjectListError> {
        let projects_dir = paths::projects_dir(&self.base_dir);

        let entries = std::fs::read_dir(&projects_dir)
            .map_err(|e| ProjectListError(format!("failed to read projects directory: {e}")))?;

        let mut lines = vec!["Available projects:".to_string()];
        let mut count = 0;

        for entry in entries.flatten() {
            let d_tag = entry.file_name().to_string_lossy().to_string();
            if let Ok(project) = Project::open(&d_tag, &self.base_dir) {
                if let Ok(Some(meta)) = project.metadata() {
                    let title = meta.title.as_deref().unwrap_or("(untitled)");
                    let repo = meta.repo_url.as_deref().unwrap_or("");
                    let agents: Vec<String> = project
                        .agents()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|a| a.slug)
                        .collect();
                    let agents_str = if agents.is_empty() {
                        String::new()
                    } else {
                        format!(" [agents: {}]", agents.join(", "))
                    };
                    let repo_str = if repo.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", repo)
                    };
                    lines.push(format!("  {d_tag}: {title}{repo_str}{agents_str}"));
                    count += 1;
                }
            }
        }

        if count == 0 {
            return Ok("No projects found.".to_string());
        }

        Ok(lines.join("\n"))
    }
}

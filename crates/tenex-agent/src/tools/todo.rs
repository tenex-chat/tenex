use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub status: TodoStatus,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TodoWriteItem {
    pub id: Option<String>,
    pub title: String,
    pub status: TodoStatus,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TodoWriteArgs {
    pub todos: Vec<TodoWriteItem>,
    pub force: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TodoError(String);

pub struct TodoWriteTool {
    todos: Arc<Mutex<Vec<TodoItem>>>,
}

impl TodoWriteTool {
    pub fn new(todos: Arc<Mutex<Vec<TodoItem>>>) -> Self {
        Self { todos }
    }
}

fn slug_from_title(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        format!("todo-{:x}", title.len())
    } else {
        slug
    }
}

impl Tool for TodoWriteTool {
    const NAME: &'static str = "todo_write";
    type Error = TodoError;
    type Args = TodoWriteArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Write the complete todo list, replacing all existing items. \
                Provide ALL items you want to exist — this is a full state replacement. \
                By default, removing existing items is blocked (use force=true to allow). \
                Use skip_reason when status='skipped'."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "Complete todo list (replaces all existing items)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "Unique ID (auto-generated from title if omitted)" },
                                "title": { "type": "string", "description": "Short description" },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "done", "skipped"]
                                },
                                "skip_reason": { "type": "string", "description": "Required when status=skipped" }
                            },
                            "required": ["title", "status"]
                        }
                    },
                    "force": {
                        "type": "boolean",
                        "description": "Allow removing existing items (default: false)"
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    async fn call(&self, args: TodoWriteArgs) -> Result<Self::Output, TodoError> {
        let force = args.force.unwrap_or(false);

        // Validate skip_reason presence
        for item in &args.todos {
            if item.status == TodoStatus::Skipped && item.skip_reason.is_none() {
                return Ok(format!(
                    "Error: skip_reason is required when status='skipped' (item: {:?})",
                    item.id.as_deref().unwrap_or(&item.title)
                ));
            }
        }

        let mut todos = self
            .todos
            .lock()
            .map_err(|_| TodoError("Failed to acquire todo lock".to_string()))?;

        // Safety check: detect removals
        if !force {
            let new_ids: std::collections::HashSet<&str> = args
                .todos
                .iter()
                .map(|t| t.id.as_deref().unwrap_or(t.title.as_str()))
                .collect();
            let missing: Vec<&str> = todos
                .iter()
                .filter(|t| !new_ids.contains(t.id.as_str()))
                .map(|t| t.id.as_str())
                .collect();
            if !missing.is_empty() {
                return Ok(format!(
                    "Error: {} existing item(s) would be removed: {}. Use force=true to allow.",
                    missing.len(),
                    missing.join(", ")
                ));
            }
        }

        // Build new list
        let new_todos: Vec<TodoItem> = args
            .todos
            .into_iter()
            .map(|item| {
                let id = item.id.unwrap_or_else(|| slug_from_title(&item.title));
                TodoItem {
                    id,
                    title: item.title,
                    status: item.status,
                    skip_reason: item.skip_reason,
                }
            })
            .collect();

        let count = new_todos.len();
        *todos = new_todos;

        let summary: Vec<String> = todos
            .iter()
            .map(|t| {
                let status_icon = match t.status {
                    TodoStatus::Pending => "○",
                    TodoStatus::InProgress => "◉",
                    TodoStatus::Done => "✓",
                    TodoStatus::Skipped => "⊘",
                };
                format!("{status_icon} [{}] {}", t.id, t.title)
            })
            .collect();

        Ok(format!(
            "Todo list updated ({count} items):\n{}",
            summary.join("\n")
        ))
    }
}

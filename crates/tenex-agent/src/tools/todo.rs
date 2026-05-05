use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TodoStatus,
    pub skip_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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
    pub description: Option<String>,
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn format_todos_reminder(todos: &[TodoItem]) -> String {
    if todos.is_empty() {
        return String::new();
    }

    let pending = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Pending)
        .count();
    let in_progress = todos
        .iter()
        .filter(|t| t.status == TodoStatus::InProgress)
        .count();
    let done = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Done)
        .count();
    let skipped = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Skipped)
        .count();

    let mut lines = vec![
        "<system-reminder>".to_string(),
        "<agent-todos>".to_string(),
        String::new(),
        format!(
            "Status: {} pending, {} in progress, {} done, {} skipped",
            pending, in_progress, done, skipped
        ),
        String::new(),
    ];

    for t in todos {
        let marker = match t.status {
            TodoStatus::Pending => "[ ]",
            TodoStatus::InProgress => "[~]",
            TodoStatus::Done => "[x]",
            TodoStatus::Skipped => "[-]",
        };
        lines.push(format!("{} {} (id: {})", marker, t.title, t.id));
    }

    lines.push(String::new());
    lines.push(
        "Use `todo_write` to update statuses. Mark items in_progress when starting, done when complete."
            .to_string(),
    );

    if pending > 0 {
        lines.push(String::new());
        lines.push(format!(
            "**ATTENTION:** You have {pending} pending todo item(s) that need to be addressed."
        ));
    }

    lines.push("</agent-todos>".to_string());
    lines.push("</system-reminder>".to_string());

    lines.join("\n")
}

/// Apply a `todo_write` invocation to the shared todo list. Encapsulates
/// validation (skip_reason, duplicate IDs, removal protection) and the
/// preservation of `created_at` / `description` for items that already
/// existed. Used by both the `todo_write` tool and `run_workflow`, which
/// activates a freshly-generated checklist with the same semantics.
pub fn apply_todo_write(
    todos: &Arc<Mutex<Vec<TodoItem>>>,
    args: TodoWriteArgs,
) -> Result<String, TodoError> {
    let force = args.force.unwrap_or(false);
    let now = now_ms();

    // Validate skip_reason presence
    for item in &args.todos {
        if item.status == TodoStatus::Skipped && item.skip_reason.is_none() {
            return Ok(format!(
                "Error: skip_reason is required when status='skipped' (item: {:?})",
                item.id.as_deref().unwrap_or(&item.title)
            ));
        }
    }

    // Validate no duplicate IDs in input
    let mut seen_ids = std::collections::HashSet::new();
    for item in &args.todos {
        let id = item
            .id
            .clone()
            .unwrap_or_else(|| slug_from_title(&item.title));
        if !seen_ids.insert(id.clone()) {
            return Ok(format!("Error: duplicate id '{id}' in input"));
        }
    }

    let mut todos = todos
        .lock()
        .map_err(|_| TodoError("Failed to acquire todo lock".to_string()))?;

    // Safety check: detect removals
    if !force {
        let new_ids: std::collections::HashSet<String> = args
            .todos
            .iter()
            .map(|t| t.id.clone().unwrap_or_else(|| slug_from_title(&t.title)))
            .collect();
        let missing: Vec<&str> = todos
            .iter()
            .filter(|t| !new_ids.contains(&t.id))
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

    // Build new list, preserving created_at/description from existing items
    let new_todos: Vec<TodoItem> = args
        .todos
        .into_iter()
        .map(|item| {
            let id = item.id.unwrap_or_else(|| slug_from_title(&item.title));
            let existing = todos.iter().find(|t| t.id == id);
            let created_at = existing.map_or(now, |e| e.created_at);
            let description = item
                .description
                .or_else(|| existing.map(|e| e.description.clone()))
                .unwrap_or_default();
            let status_changed = existing.is_none_or(|e| e.status != item.status);
            let updated_at = if status_changed {
                now
            } else {
                existing.map_or(now, |e| e.updated_at)
            };
            TodoItem {
                id,
                title: item.title,
                description,
                status: item.status,
                skip_reason: item.skip_reason,
                created_at,
                updated_at,
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
                                "description": { "type": "string", "description": "Detailed description (omit to preserve existing value on updates)" },
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
        apply_todo_write(&self.todos, args)
    }
}

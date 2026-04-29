//! Renders tool-use intents as Telegram-friendly strings.
//!
//! Mirrors `src/services/telegram/telegram-runtime-tool-publications.ts`.

use tenex_protocol::ToolUseIntent;

const MAX_LEN: usize = 3500;

pub fn render_tool_publication(intent: &ToolUseIntent) -> Option<String> {
    let base_name = strip_mcp_prefix(&intent.tool_name);
    match base_name {
        "todo_write" => Some(render_todo_write(intent)),
        _ => None,
    }
}

fn strip_mcp_prefix(name: &str) -> &str {
    // MCP tool names are prefixed with "mcp__<server>__", strip to base name.
    if let Some(idx) = name.rfind("__") {
        &name[idx + 2..]
    } else {
        name
    }
}

fn render_todo_write(intent: &ToolUseIntent) -> String {
    let args: serde_json::Value = intent
        .args_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null);

    let todos = match args.get("todos").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => {
            return [
                "**Updating todo list**",
                "",
                "- The todo payload could not be rendered.",
            ]
            .join("\n");
        }
    };

    if todos.is_empty() {
        return [
            "**Updating todo list**",
            "",
            "- Requested todo list is empty.",
        ]
        .join("\n");
    }

    let summary = summarize_statuses(&todos);
    let count = todos.len();
    let summary_str = summary
        .as_deref()
        .map(|s| format!(": {s}"))
        .unwrap_or_default();

    let mut lines = vec![
        "**Updating todo list**".to_string(),
        String::new(),
        format!(
            "{count} item{}{}",
            if count == 1 { "" } else { "s" },
            summary_str
        ),
        String::new(),
    ];
    for todo in &todos {
        lines.push(build_todo_line(todo));
    }

    truncate_lines(lines)
}

fn build_todo_line(todo: &serde_json::Value) -> String {
    let title = sanitize(todo.get("title").and_then(|v| v.as_str()).unwrap_or(""));
    let title = if title.is_empty() {
        "Untitled item".to_string()
    } else {
        title
    };
    let status = todo.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let status_label = match status {
        "pending" => "Pending",
        "in_progress" => "In progress",
        "done" => "Done",
        "skipped" => "Skipped",
        _ => "Todo",
    };
    let desc = sanitize(
        todo.get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let skip_reason = if status == "skipped" {
        sanitize(
            todo.get("skip_reason")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )
    } else {
        String::new()
    };

    let mut details = Vec::new();
    if !desc.is_empty() {
        details.push(desc);
    }
    if !skip_reason.is_empty() {
        details.push(format!("reason: {skip_reason}"));
    }

    if details.is_empty() {
        format!("- {status_label}: {title}")
    } else {
        format!("- {status_label}: {title} ({})", details.join(" | "))
    }
}

fn summarize_statuses(todos: &[serde_json::Value]) -> Option<String> {
    let order = ["in_progress", "pending", "done", "skipped"];
    let labels = [
        ("in_progress", "in progress"),
        ("pending", "pending"),
        ("done", "done"),
        ("skipped", "skipped"),
    ];
    let mut counts = std::collections::HashMap::new();
    for todo in todos {
        if let Some(s) = todo.get("status").and_then(|v| v.as_str()) {
            *counts.entry(s.to_string()).or_insert(0u32) += 1;
        }
    }
    let segments: Vec<String> = order
        .iter()
        .zip(labels.iter())
        .filter_map(|(key, (_, label))| counts.get(*key).map(|n| format!("{n} {label}")))
        .collect();
    if segments.is_empty() {
        None
    } else {
        Some(segments.join(", "))
    }
}

fn sanitize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_lines(lines: Vec<String>) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut total = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let next_len = if out.is_empty() {
            line.len()
        } else {
            total + 1 + line.len()
        };
        if next_len <= MAX_LEN {
            out.push(line.as_str());
            total = next_len;
        } else {
            let remaining = lines.len() - i;
            if remaining > 0 {
                out.push(if remaining == 1 {
                    "- ...and 1 more item"
                } else {
                    "- ...and more items"
                });
            }
            break;
        }
    }
    out.join("\n")
}

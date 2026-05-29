use crate::emit::EmitState;
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tenex_conversations::{
    model::ConversationRow, paths::CONVERSATION_DB_FILENAME, store::ConversationListFilter,
    ConversationStore,
};
use tenex_project::{resolve_recipient, Agent, RecipientResolution};
use tenex_protocol::intent::{Intent, ToolUseIntent};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationListArgs {
    pub description: String,
    pub limit: Option<i64>,
    pub from_time: Option<i64>,
    pub to_time: Option<i64>,
    pub with: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationListError(String);

#[derive(Clone)]
pub struct ConversationListTool {
    state: Arc<EmitState>,
    conv_db_path: PathBuf,
    base_dir: PathBuf,
    project_d_tag: String,
    project_agents: Arc<Vec<Agent>>,
}

impl ConversationListTool {
    pub fn new(
        state: Arc<EmitState>,
        conv_db_path: PathBuf,
        base_dir: PathBuf,
        project_d_tag: String,
        project_agents: Arc<Vec<Agent>>,
    ) -> Self {
        Self {
            state,
            conv_db_path,
            base_dir,
            project_d_tag,
            project_agents,
        }
    }
}

/// A conversation row tagged with its originating project.
struct TaggedConv {
    project_id: Option<String>,
    row: ConversationRow,
}

fn parent_conversation_id(row: &ConversationRow) -> Option<String> {
    row.runtime_state
        .get("rustRuntime")
        .and_then(|r| r.get("delegation"))
        .and_then(|d| d.get("parent_conversation_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn query_store(
    db_path: &Path,
    project_label: Option<String>,
    filter: &ConversationListFilter,
) -> Vec<TaggedConv> {
    if !db_path.exists() {
        return Vec::new();
    }
    let store = match ConversationStore::open(db_path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match store.list_recent(filter.clone()) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.into_iter()
        .map(|row| TaggedConv {
            project_id: project_label.clone(),
            row,
        })
        .collect()
}

fn format_conv_line(tagged: &TaggedConv, indent: &str) -> String {
    let row = &tagged.row;
    let id_short = tenex_ids::shorten_full_event_id(&row.id);
    let title = row.title.as_deref().unwrap_or("(untitled)");
    let last_msg = row
        .last_user_message
        .as_deref()
        .map(|m| {
            let truncated: String = m.chars().take(60).collect();
            if m.chars().count() > 60 {
                format!("{truncated}…")
            } else {
                truncated
            }
        })
        .unwrap_or_default();
    let activity = row
        .last_activity
        .map(|ts| format!(" [last active: {ts}]"))
        .unwrap_or_default();
    let preview = if last_msg.is_empty() {
        String::new()
    } else {
        format!(" | {last_msg}")
    };
    let project_prefix = tagged
        .project_id
        .as_deref()
        .map(|p| format!("[{p}] "))
        .unwrap_or_default();
    format!("{indent}{project_prefix}{id_short}: {title}{activity}{preview}",)
}

/// Build a tree-ordered flat list: roots by `last_activity` desc, each
/// root followed immediately by its direct and transitive children in
/// `last_activity` desc order, indented by `depth * "    └─ "`.
fn build_tree_lines(tagged: Vec<TaggedConv>) -> Vec<String> {
    // Index conversations by id for fast parent lookup.
    let id_set: std::collections::HashSet<String> =
        tagged.iter().map(|t| t.row.id.clone()).collect();

    // Group children by parent_id.
    let mut children_of: HashMap<String, Vec<usize>> = HashMap::new();
    let mut roots: Vec<usize> = Vec::new();

    for (i, t) in tagged.iter().enumerate() {
        match parent_conversation_id(&t.row) {
            Some(parent_id) if id_set.contains(&parent_id) => {
                children_of.entry(parent_id).or_default().push(i);
            }
            _ => roots.push(i),
        }
    }

    // Sort roots by last_activity desc.
    roots.sort_by(|&a, &b| {
        tagged[b]
            .row
            .last_activity
            .cmp(&tagged[a].row.last_activity)
    });

    // Sort each child list by last_activity desc.
    for children in children_of.values_mut() {
        children.sort_by(|&a, &b| {
            tagged[b]
                .row
                .last_activity
                .cmp(&tagged[a].row.last_activity)
        });
    }

    let mut lines: Vec<String> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (index, depth)

    // Push roots in reverse so we pop them in sorted order.
    for &root in roots.iter().rev() {
        stack.push((root, 0));
    }

    while let Some((idx, depth)) = stack.pop() {
        let indent = if depth == 0 {
            "  ".to_string()
        } else {
            format!("  {}", "    └─ ".repeat(depth))
        };
        lines.push(format_conv_line(&tagged[idx], &indent));

        // Push children in reverse sorted order.
        if let Some(children) = children_of.get(&tagged[idx].row.id) {
            for &child in children.iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }

    lines
}

impl Tool for ConversationListTool {
    const NAME: &'static str = "conversation_list";
    type Error = ConversationListError;
    type Args = ConversationListArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List conversations sorted by most recent activity. Supports filtering by participant, time range, and project scope. Returns conversation IDs, titles, last activity timestamps, and preview text. Child conversations (delegated sub-tasks) are nested under their parent.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "One-line reason why you are listing conversations"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of conversations to return per project (default: 20)"
                    },
                    "from_time": {
                        "type": "integer",
                        "description": "Filter conversations with activity after this Unix timestamp (milliseconds)"
                    },
                    "to_time": {
                        "type": "integer",
                        "description": "Filter conversations with activity before this Unix timestamp (milliseconds)"
                    },
                    "with": {
                        "type": "string",
                        "description": "Filter to conversations where this agent is a participant (author or recipient)."
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Project dTag to list, or 'ALL' to list across all projects. Defaults to current project."
                    }
                },
                "required": ["description"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let ral = self.state.meta.lock().unwrap().ral;
        let mut ctx = self.state.build_ctx(ral);
        ctx.llm_runtime_ms = self.state.take_runtime_delta();
        let args_json = serde_json::to_string(&args).unwrap_or_default();
        self.state
            .channel
            .send(
                Intent::ToolUse(ToolUseIntent {
                    tool_name: Self::NAME.to_string(),
                    content: String::new(),
                    args_json: Some(args_json),
                    referenced_messages: vec![],
                    usage: None,
                    extra_tags: vec![],
                }),
                &ctx,
            )
            .await
            .map_err(|e| ConversationListError(format!("failed to emit tool-use event: {e}")))?;

        let participant_pubkey = match args.with.as_deref() {
            None => None,
            Some(input) => match resolve_recipient(&self.project_agents, input) {
                RecipientResolution::Resolved(agent) => Some(agent.pubkey.clone()),
                RecipientResolution::Ambiguous(candidates) => {
                    let labels: Vec<String> = candidates
                        .iter()
                        .map(|a| format!("{} ({})", a.slug, &a.pubkey[..8.min(a.pubkey.len())]))
                        .collect();
                    return Ok(format!(
                        "Error: 'with' value '{}' matches multiple agents: {}. Use a longer pubkey prefix or the agent slug.",
                        input,
                        labels.join(", ")
                    ));
                }
                RecipientResolution::NotFound => Some(input.to_string()),
            },
        };

        let filter = ConversationListFilter {
            limit: Some(args.limit.unwrap_or(20).max(20)),
            from_time: args.from_time,
            to_time: args.to_time,
            participant_pubkey,
        };

        let scope = args.project_id.as_deref().unwrap_or("");
        let search_all = scope.eq_ignore_ascii_case("ALL");

        let tagged: Vec<TaggedConv> = if search_all {
            let projects_dir = self.base_dir.join("projects");
            let entries = std::fs::read_dir(&projects_dir)
                .map_err(|e| ConversationListError(format!("cannot read projects dir: {e}")))?;

            let mut all: Vec<TaggedConv> = Vec::new();
            for entry in entries.flatten() {
                let db_path = entry.path().join(CONVERSATION_DB_FILENAME);
                let project_label = entry.file_name().to_string_lossy().into_owned();
                let mut results = query_store(&db_path, Some(project_label), &filter);
                all.append(&mut results);
            }
            all
        } else if scope.is_empty() || scope == self.project_d_tag {
            query_store(&self.conv_db_path, None, &filter)
        } else {
            let db_path = self
                .base_dir
                .join("projects")
                .join(scope)
                .join(CONVERSATION_DB_FILENAME);
            query_store(&db_path, Some(scope.to_string()), &filter)
        };

        if tagged.is_empty() {
            return Ok("No conversations found.".to_string());
        }

        let count = tagged.len();
        let mut lines = vec![format!("{count} conversation(s):")];
        lines.extend(build_tree_lines(tagged));

        Ok(lines.join("\n"))
    }
}

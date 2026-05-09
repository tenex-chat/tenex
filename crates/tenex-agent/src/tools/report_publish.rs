use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tenex_protocol::{Intent, PublishArticleIntent};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ReportPublishError(String);

#[derive(Debug, Deserialize, Serialize)]
pub struct ReportPublishArgs {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct ReportPublishOutput {
    pub success: bool,
    pub published: Vec<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct FileEntry {
    absolute_path: PathBuf,
    d_tag: String,
    document_tag: String,
}

fn collect_files(input_path: &Path) -> Result<Vec<FileEntry>, ReportPublishError> {
    let real_path = input_path.canonicalize().map_err(|_| {
        ReportPublishError(format!("path does not exist: {}", input_path.display()))
    })?;

    if !real_path.is_dir() {
        let filename = real_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let document_tag = real_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&filename)
            .to_string();
        return Ok(vec![FileEntry {
            absolute_path: real_path,
            d_tag: filename,
            document_tag,
        }]);
    }

    let dir_name = real_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut entries: Vec<FileEntry> = Vec::new();
    walk_dir(&real_path, &real_path, &dir_name, &mut entries)?;
    entries.sort_by(|a, b| a.d_tag.cmp(&b.d_tag));
    Ok(entries)
}

fn walk_dir(
    current: &Path,
    base: &Path,
    dir_name: &str,
    out: &mut Vec<FileEntry>,
) -> Result<(), ReportPublishError> {
    let read_dir = std::fs::read_dir(current).map_err(|e| {
        ReportPublishError(format!("Cannot read directory {}: {e}", current.display()))
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let full_path = entry.path();
        let real_entry = match full_path.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if real_entry.is_dir() {
            walk_dir(&real_entry, base, dir_name, out)?;
        } else {
            let relative = real_entry.strip_prefix(base).unwrap_or(&real_entry);
            let d_tag = format!("{dir_name}/{}", relative.display());
            out.push(FileEntry {
                absolute_path: real_entry,
                d_tag,
                document_tag: dir_name.to_string(),
            });
        }
    }
    Ok(())
}

pub struct ReportPublishTool {
    state: Arc<EmitState>,
    project_base: String,
}

impl ReportPublishTool {
    pub fn new(state: Arc<EmitState>, project_base: String) -> Self {
        Self {
            state,
            project_base,
        }
    }
}

impl Tool for ReportPublishTool {
    const NAME: &'static str = "report_publish";
    type Error = ReportPublishError;
    type Args = ReportPublishArgs;
    type Output = ReportPublishOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Publish markdown files as NIP-23 long-form articles (kind:30023) to \
                Nostr, signed with this agent's keys. Accepts a single file or a directory \
                (recursive). Absolute paths may point anywhere readable (e.g. the agent home); \
                relative paths resolve against the project root."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or project-relative path to a markdown file or directory."
                    },
                    "title": {
                        "type": "string",
                        "description": "NIP-23 article title published as the 'title' tag."
                    }
                },
                "required": ["path", "title"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let input_path = if Path::new(&args.path).is_absolute() {
            PathBuf::from(&args.path)
        } else {
            PathBuf::from(&self.project_base).join(&args.path)
        };

        let files = collect_files(&input_path)?;

        if files.is_empty() {
            return Ok(ReportPublishOutput {
                success: false,
                published: Vec::new(),
                summary: String::new(),
                error: Some(format!("No files found at {}", input_path.display())),
            });
        }

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);
        let mut published: Vec<String> = Vec::new();

        for file in files {
            let content = std::fs::read_to_string(&file.absolute_path).map_err(|e| {
                ReportPublishError(format!(
                    "Failed to read {}: {e}",
                    file.absolute_path.display()
                ))
            })?;

            let intent = PublishArticleIntent {
                d_tag: file.d_tag.clone(),
                document_tag: file.document_tag.clone(),
                title: args.title.clone(),
                content,
            };

            self.state
                .channel
                .send(Intent::PublishArticle(intent), &ctx)
                .await
                .map_err(|e| {
                    ReportPublishError(format!("Failed to publish {}: {e}", file.d_tag))
                })?;

            published.push(file.d_tag);
        }

        let summary = if published.len() == 1 {
            format!("Published 1 article: {}", published[0])
        } else {
            format!("Published {} articles", published.len())
        };

        Ok(ReportPublishOutput {
            success: true,
            published,
            summary,
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_tree() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "# Hello").unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs").join("guide.md"), "# Guide").unwrap();
        dir
    }

    #[test]
    fn single_file_entry() {
        let dir = make_tree();
        let file = dir.path().join("note.md");
        let entries = collect_files(&file).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "note.md");
        assert_eq!(entries[0].document_tag, "note");
    }

    #[test]
    fn directory_entry_prefixes_dir_name() {
        let dir = make_tree();
        let docs = dir.path().join("docs");
        let entries = collect_files(&docs).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "docs/guide.md");
        assert_eq!(entries[0].document_tag, "docs");
    }

    #[test]
    fn absolute_path_anywhere_readable_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("report.md"), "# external").unwrap();
        let entries = collect_files(&dir.path().join("report.md")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "report.md");
    }

    #[test]
    fn missing_path_returns_error() {
        let result = collect_files(Path::new("/nonexistent/path/file.md"));
        assert!(result.is_err());
    }
}

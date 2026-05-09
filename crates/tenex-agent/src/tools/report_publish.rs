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

/// Expand `$VAR` and `${VAR}` substrings using `std::env::var`. Unknown vars
/// are left in place verbatim so callers can spot misconfigured paths in the
/// resulting filesystem error rather than getting a silent empty expansion.
fn expand_env_vars(input: &str) -> String {
    // `$`, `{`, `}`, ASCII alphanumerics and `_` are all single-byte in UTF-8,
    // so byte-index scanning is safe: every index we slice at lands on a char
    // boundary. Literal spans between substitutions are copied as `&str`
    // slices, preserving any multi-byte chars they contain (e.g. `café`).
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut literal_start = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            // ${NAME}
            if bytes[i + 1] == b'{' {
                if let Some(end_rel) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                    let name_end = i + 2 + end_rel;
                    let name = &input[i + 2..name_end];
                    if !name.is_empty() {
                        out.push_str(&input[literal_start..i]);
                        match std::env::var(name) {
                            Ok(v) => out.push_str(&v),
                            Err(_) => out.push_str(&input[i..name_end + 1]),
                        }
                        i = name_end + 1;
                        literal_start = i;
                        continue;
                    }
                }
            }
            // $NAME — terminated by anything that's not [A-Za-z0-9_]
            let name_start = i + 1;
            let mut name_end = name_start;
            while name_end < bytes.len()
                && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'_')
            {
                name_end += 1;
            }
            if name_end > name_start {
                let name = &input[name_start..name_end];
                out.push_str(&input[literal_start..i]);
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&input[i..name_end]),
                }
                i = name_end;
                literal_start = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&input[literal_start..]);
    out
}

/// Resolve an agent-supplied path string into a concrete filesystem path and
/// the containment root (if any) that `collect_files` must enforce.
///
/// Env vars are expanded first, *then* absolute/relative is decided. This lets
/// agents publish from `$AGENT_HOME` (or any other absolute location) without
/// being silently re-anchored under the project base.
fn resolve_input_path(
    project_base: &str,
    raw_path: &str,
) -> Result<(PathBuf, Option<PathBuf>), ReportPublishError> {
    let expanded = expand_env_vars(raw_path);
    if Path::new(&expanded).is_absolute() {
        Ok((PathBuf::from(&expanded), None))
    } else {
        let root = PathBuf::from(project_base)
            .canonicalize()
            .map_err(|e| ReportPublishError(format!("Project base path not accessible: {e}")))?;
        let path = PathBuf::from(project_base).join(&expanded);
        Ok((path, Some(root)))
    }
}

fn assert_contained(real_path: &Path, allowed_root: &Path) -> Result<(), ReportPublishError> {
    if real_path != allowed_root && !real_path.starts_with(allowed_root) {
        return Err(ReportPublishError(
            "Access denied: path is outside the project directory".into(),
        ));
    }
    Ok(())
}

fn collect_files(
    input_path: &Path,
    allowed_root: Option<&Path>,
) -> Result<Vec<FileEntry>, ReportPublishError> {
    let real_path = input_path.canonicalize().map_err(|_| {
        ReportPublishError(format!("path does not exist: {}", input_path.display()))
    })?;

    if let Some(root) = allowed_root {
        assert_contained(&real_path, root)?;
    }

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
    walk_dir(
        &real_path,
        &real_path,
        &dir_name,
        allowed_root,
        &mut entries,
    )?;
    entries.sort_by(|a, b| a.d_tag.cmp(&b.d_tag));
    Ok(entries)
}

fn walk_dir(
    current: &Path,
    base: &Path,
    dir_name: &str,
    allowed_root: Option<&Path>,
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
        // Skip symlinks: following them can leak files outside the visible
        // tree (and produce d_tags with absolute path fragments) when no
        // containment root is set. What you see in the directory is what
        // gets published.
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let logical_path = entry.path();
        if let Some(root) = allowed_root {
            let real = match logical_path.canonicalize() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if assert_contained(&real, root).is_err() {
                continue;
            }
        }
        if file_type.is_dir() {
            walk_dir(&logical_path, base, dir_name, allowed_root, out)?;
        } else if file_type.is_file() {
            let relative = logical_path.strip_prefix(base).unwrap_or(&logical_path);
            let d_tag = format!("{dir_name}/{}", relative.display());
            out.push(FileEntry {
                absolute_path: logical_path,
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
                (recursive). Path may be absolute or relative to the project root, and \
                supports $VAR / ${VAR} env-var substitution (e.g. $AGENT_HOME)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or project-relative path to a markdown file or directory. Supports $VAR and ${VAR} env-var substitution."
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
        let (input_path, allowed_root) = resolve_input_path(&self.project_base, &args.path)?;

        let files = collect_files(&input_path, allowed_root.as_deref())?;

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
        let root = dir.path().canonicalize().unwrap();
        let entries = collect_files(&file, Some(&root)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "note.md");
        assert_eq!(entries[0].document_tag, "note");
    }

    #[test]
    fn directory_entry_prefixes_dir_name() {
        let dir = make_tree();
        let docs = dir.path().join("docs");
        let root = dir.path().canonicalize().unwrap();
        let entries = collect_files(&docs, Some(&root)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "docs/guide.md");
        assert_eq!(entries[0].document_tag, "docs");
    }

    #[test]
    fn rooted_path_traversal_rejected() {
        let outer = tempfile::tempdir().unwrap();
        let inner = tempfile::tempdir().unwrap();
        fs::write(inner.path().join("secret.md"), "secret").unwrap();
        let root = outer.path().canonicalize().unwrap();
        let bad_path = inner.path().join("secret.md");
        let result = collect_files(&bad_path, Some(&root));
        assert!(
            result.is_err(),
            "paths outside the containment root must be rejected"
        );
    }

    #[test]
    fn absolute_path_outside_root_allowed() {
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("note.md");
        fs::write(&file, "# Hello").unwrap();
        let entries = collect_files(&file, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].d_tag, "note.md");
    }

    #[test]
    fn missing_path_returns_error() {
        let result = collect_files(Path::new("/nonexistent/path/file.md"), None);
        assert!(result.is_err());
    }

    #[test]
    fn symlinks_in_directory_are_skipped() {
        // A symlink inside the published directory pointing at a file outside
        // the tree must not be included — otherwise an agent could leak
        // arbitrary files (and produce broken `d_tag`s) by planting a link.
        #[cfg(unix)]
        {
            let inside = tempfile::tempdir().unwrap();
            fs::write(inside.path().join("real.md"), "# Real").unwrap();
            let outside = tempfile::tempdir().unwrap();
            let secret = outside.path().join("secret.md");
            fs::write(&secret, "secret").unwrap();
            std::os::unix::fs::symlink(&secret, inside.path().join("link.md")).unwrap();

            let entries = collect_files(inside.path(), None).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].d_tag.split('/').next_back().unwrap(), "real.md");
        }
    }

    #[test]
    fn resolve_input_path_absolute_returns_no_root() {
        let outside = tempfile::tempdir().unwrap();
        let abs = outside.path().join("note.md");
        let project_base = tempfile::tempdir().unwrap();
        let (resolved, root) =
            resolve_input_path(project_base.path().to_str().unwrap(), abs.to_str().unwrap())
                .unwrap();
        assert_eq!(resolved, abs);
        assert!(root.is_none());
    }

    #[test]
    fn resolve_input_path_relative_anchors_to_project_base() {
        let project_base = tempfile::tempdir().unwrap();
        let (resolved, root) =
            resolve_input_path(project_base.path().to_str().unwrap(), "docs/note.md").unwrap();
        assert_eq!(resolved, project_base.path().join("docs/note.md"));
        assert_eq!(
            root.expect("relative path must produce a containment root"),
            project_base.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn resolve_input_path_expands_env_var_to_absolute() {
        let outside = tempfile::tempdir().unwrap();
        std::env::set_var("REPORT_PUBLISH_TEST_DIR", outside.path());
        let project_base = tempfile::tempdir().unwrap();
        let (resolved, root) = resolve_input_path(
            project_base.path().to_str().unwrap(),
            "$REPORT_PUBLISH_TEST_DIR/note.md",
        )
        .unwrap();
        std::env::remove_var("REPORT_PUBLISH_TEST_DIR");
        assert_eq!(resolved, outside.path().join("note.md"));
        assert!(
            root.is_none(),
            "env-var-expanded absolute path must not be re-anchored under project base"
        );
    }

    #[test]
    fn resolve_input_path_preserves_non_ascii_segments() {
        let project_base = tempfile::tempdir().unwrap();
        let (resolved, _root) =
            resolve_input_path(project_base.path().to_str().unwrap(), "reports/café.md").unwrap();
        assert_eq!(resolved, project_base.path().join("reports/café.md"));
    }

    #[test]
    fn resolve_input_path_expands_env_var_in_relative_path() {
        std::env::set_var("REPORT_PUBLISH_TEST_SUBDIR", "docs");
        let project_base = tempfile::tempdir().unwrap();
        let (resolved, root) = resolve_input_path(
            project_base.path().to_str().unwrap(),
            "${REPORT_PUBLISH_TEST_SUBDIR}/note.md",
        )
        .unwrap();
        std::env::remove_var("REPORT_PUBLISH_TEST_SUBDIR");
        assert_eq!(resolved, project_base.path().join("docs/note.md"));
        assert!(root.is_some());
    }
}

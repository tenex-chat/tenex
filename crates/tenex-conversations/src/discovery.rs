//! Enumerate project directories that have both an `event.json` and a
//! `conversation.db`. Used by `tenex-summarizer` and `tenex-embedder` to
//! pick up new projects without a daemon restart.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::paths;

/// One discovered project directory under `<base_dir>/projects/`.
#[derive(Debug, Clone)]
pub struct ProjectRef {
    /// d-tag (the directory name; matches the project event's `d` tag).
    pub d_tag: String,
    /// Absolute path to the project root: `<base_dir>/projects/<d_tag>`.
    pub root: PathBuf,
    /// Absolute path to the canonical conversation database.
    pub conversation_db: PathBuf,
}

/// Walk `<base_dir>/projects/` and return entries that have both
/// `event.json` and `conversation.db`. Sorted by `d_tag` for stable order.
pub fn discover_projects(base_dir: &Path) -> Result<Vec<ProjectRef>> {
    let root = paths::projects_dir(base_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let d_tag = match dir.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let event = dir.join("event.json");
        let conversation_db = dir.join(paths::CONVERSATION_DB_FILENAME);
        if !event.exists() || !conversation_db.exists() {
            continue;
        }
        out.push(ProjectRef {
            d_tag,
            root: dir,
            conversation_db,
        });
    }
    out.sort_by(|a, b| a.d_tag.cmp(&b.d_tag));
    Ok(out)
}

/// Convenience: discover under `default_base_dir()`.
pub fn discover_projects_default() -> Result<Vec<ProjectRef>> {
    discover_projects(&paths::default_base_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_project(base: &Path, d_tag: &str, with_db: bool, with_event: bool) {
        let dir = paths::project_dir(base, d_tag);
        fs::create_dir_all(&dir).unwrap();
        if with_event {
            fs::write(dir.join("event.json"), b"{}").unwrap();
        }
        if with_db {
            fs::write(dir.join(paths::CONVERSATION_DB_FILENAME), b"").unwrap();
        }
    }

    #[test]
    fn returns_empty_when_root_missing() {
        let dir = TempDir::new().unwrap();
        let projects = discover_projects(dir.path()).unwrap();
        assert!(projects.is_empty());
    }

    #[test]
    fn returns_only_complete_projects_sorted() {
        let dir = TempDir::new().unwrap();
        make_project(dir.path(), "zeta", true, true);
        make_project(dir.path(), "alpha", true, true);
        make_project(dir.path(), "missing-db", false, true);
        make_project(dir.path(), "missing-event", true, false);

        let projects = discover_projects(dir.path()).unwrap();
        let tags: Vec<&str> = projects.iter().map(|p| p.d_tag.as_str()).collect();
        assert_eq!(tags, vec!["alpha", "zeta"]);
        assert!(projects[0].conversation_db.ends_with("conversation.db"));
    }
}

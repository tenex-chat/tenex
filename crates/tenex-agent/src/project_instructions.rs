use std::path::{Path, PathBuf};

const MAX_ROOT_AGENTS_MD_BYTES: usize = 2000;

pub(crate) fn read_root_agents_md(project_root: &Path) -> Option<String> {
    let content = std::fs::read_to_string(project_root.join("AGENTS.md")).ok()?;
    if content.len() < MAX_ROOT_AGENTS_MD_BYTES {
        Some(content)
    } else {
        None
    }
}

// Used by the tenex-agent bin (main.rs); the tenex-agent-acp bin includes
// this module but does not call this function.
#[allow(dead_code)]
pub(crate) fn infer_project_root(working_dir: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    let mut saw_component = false;

    for component in working_dir.components() {
        if component.as_os_str() == ".worktrees" {
            return if saw_component {
                root
            } else {
                working_dir.to_path_buf()
            };
        }
        root.push(component.as_os_str());
        saw_component = true;
    }

    working_dir.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::{infer_project_root, read_root_agents_md};
    use std::path::Path;

    #[test]
    fn reads_small_root_agents_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "root rules\n").unwrap();

        assert_eq!(
            read_root_agents_md(dir.path()).as_deref(),
            Some("root rules\n")
        );
    }

    #[test]
    fn skips_large_root_agents_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "x".repeat(2000)).unwrap();

        assert!(read_root_agents_md(dir.path()).is_none());
    }

    #[test]
    fn infers_project_root_from_worktree_path() {
        let root = infer_project_root(Path::new("/repo/.worktrees/feature"));

        assert_eq!(root, Path::new("/repo"));
    }

    #[test]
    fn keeps_non_worktree_path_as_project_root() {
        let root = infer_project_root(Path::new("/repo/subdir"));

        assert_eq!(root, Path::new("/repo/subdir"));
    }
}

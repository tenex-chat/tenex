use std::path::Path;

const MAX_ROOT_AGENTS_MD_BYTES: usize = 2000;

pub(crate) fn read_root_agents_md(project_root: &Path) -> Option<String> {
    let content = std::fs::read_to_string(project_root.join("AGENTS.md")).ok()?;
    if content.len() < MAX_ROOT_AGENTS_MD_BYTES {
        Some(content)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::read_root_agents_md;

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
}

//! Embeds the TENEX built-in skill tree and installs it into `<base_dir>/skills/built-in/`
//! at daemon startup.
//!
//! [`ensure`] is idempotent and version-aware: it writes each file only when the
//! on-disk content differs from the embedded bytes, so daemon restarts don't cause
//! unnecessary I/O.
//!
//! Lives in its own crate so both the `tenex` daemon and any other binary that needs
//! the skill tree can depend on it without pulling in the full `tenex-agent` graph.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// All built-in skill files embedded at compile time.
/// Each entry is `(relative_path_from_built-in_root, content)`.
static BUILTIN_SKILLS: &[(&str, &[u8])] = &[
    (
        "agent-management/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/agent-management/SKILL.md"),
    ),
    (
        "conversation-search/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/conversation-search/SKILL.md"),
    ),
    (
        "mcp/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/mcp/SKILL.md"),
    ),
    (
        "nostr/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/nostr/SKILL.md"),
    ),
    (
        "project-list/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/project-list/SKILL.md"),
    ),
    (
        "rag/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/rag/SKILL.md"),
    ),
    (
        "read-access/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/read-access/SKILL.md"),
    ),
    (
        "report/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/report/SKILL.md"),
    ),
    (
        "schedule/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/schedule/SKILL.md"),
    ),
    (
        "shell/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/shell/SKILL.md"),
    ),
    (
        "signer/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/signer/SKILL.md"),
    ),
    (
        "skills/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/skills/SKILL.md"),
    ),
    (
        "skills/references/creating-skills.md",
        include_bytes!(
            "../../tenex-agent/skills/built-in/skills/references/creating-skills.md"
        ),
    ),
    (
        "skills/references/search.md",
        include_bytes!("../../tenex-agent/skills/built-in/skills/references/search.md"),
    ),
    (
        "teams/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/teams/SKILL.md"),
    ),
    (
        "workflows/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/workflows/SKILL.md"),
    ),
    (
        "write-access/SKILL.md",
        include_bytes!("../../tenex-agent/skills/built-in/write-access/SKILL.md"),
    ),
];

/// Install built-in skills into `<base_dir>/skills/built-in/`.
///
/// Each file is written only when its on-disk content differs from the
/// embedded bytes. Existing files with matching content are left untouched.
/// Files in the directory tree that are not in the embed list are removed,
/// and empty directories left behind are pruned. This keeps the on-disk
/// tree an exact mirror of the embedded set across releases that rename or
/// drop built-in skills.
pub fn ensure(base_dir: &Path) -> Result<()> {
    let dest = base_dir.join("skills").join("built-in");
    let mut expected: HashSet<PathBuf> = HashSet::with_capacity(BUILTIN_SKILLS.len());
    for (rel_path, content) in BUILTIN_SKILLS {
        let file_path = dest.join(rel_path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating directory {}", parent.display()))?;
        }
        let needs_write = std::fs::read(&file_path)
            .map(|existing| existing != *content)
            .unwrap_or(true);
        if needs_write {
            std::fs::write(&file_path, content)
                .with_context(|| format!("writing built-in skill {}", file_path.display()))?;
        }
        expected.insert(file_path);
    }

    let mut on_disk = Vec::new();
    collect_files(&dest, &mut on_disk)?;
    for path in on_disk {
        if !expected.contains(&path) {
            std::fs::remove_file(&path)
                .with_context(|| format!("pruning stale built-in skill {}", path.display()))?;
        }
    }
    prune_empty_dirs(&dest, &dest)?;
    Ok(())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("reading directory {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(&path, out)?;
        } else if file_type.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

fn prune_empty_dirs(dir: &Path, root: &Path) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("reading directory {}", dir.display()))?
    {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            prune_empty_dirs(&entry.path(), root)?;
        }
    }
    if dir != root && std::fs::read_dir(dir)?.next().is_none() {
        std::fs::remove_dir(dir)
            .with_context(|| format!("removing empty directory {}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_prunes_unknown_files_and_empty_dirs() {
        let tmp = tempdir().unwrap();
        let base = tmp.path();
        let built_in = base.join("skills").join("built-in");

        let stale_dir = built_in.join("find-skills");
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::write(stale_dir.join("SKILL.md"), b"obsolete").unwrap();

        let stale_ref = built_in.join("teams").join("references");
        std::fs::create_dir_all(&stale_ref).unwrap();
        let stale_ref_file = stale_ref.join("old.md");
        std::fs::write(&stale_ref_file, b"obsolete").unwrap();

        ensure(base).unwrap();

        assert!(!stale_dir.exists(), "stale find-skills dir should be pruned");
        assert!(
            !stale_ref_file.exists(),
            "stale teams/references file should be pruned"
        );
        assert!(
            !stale_ref.exists(),
            "empty teams/references dir should be pruned"
        );
        assert!(
            built_in.join("teams").join("SKILL.md").exists(),
            "embedded teams/SKILL.md should still be present"
        );
        assert!(
            built_in
                .join("skills")
                .join("references")
                .join("search.md")
                .exists(),
            "embedded skills/references/search.md should still be present"
        );
    }
}

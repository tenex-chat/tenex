//! Embeds the TENEX built-in skill tree and installs it into `<base_dir>/skills/built-in/`
//! at daemon startup.
//!
//! [`ensure`] is idempotent and version-aware: it writes each file only when the
//! on-disk content differs from the embedded bytes, so daemon restarts don't cause
//! unnecessary I/O.
//!
//! Lives in its own crate so both the `tenex` daemon and any other binary that needs
//! the skill tree can depend on it without pulling in the full `tenex-agent` graph.

use std::path::Path;

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
/// Unknown files already in the directory are not removed.
pub fn ensure(base_dir: &Path) -> Result<()> {
    let dest = base_dir.join("skills").join("built-in");
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
    }
    Ok(())
}

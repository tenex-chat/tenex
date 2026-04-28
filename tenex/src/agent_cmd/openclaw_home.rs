//! Materialize an agent's home directory from an OpenClaw workspace.
//!
//! Mirrors `createHomeDir` and `getAgentHomeDirectory`
//! (`src/commands/agent/import/openclaw.ts:22-74` +
//! `src/lib/agent-home.ts:38-49`).
//!
//! Two modes, mirroring TS verbatim:
//!
//! - **copy** (`no_sync = true`, i.e. user passed `--no-sync`): recursive
//!   copy of the entire workspace into the agent home dir. The
//!   `+INDEX.md` text is the "copied from" variant.
//! - **symlink** (default, `no_sync = false`): symlink only the two
//!   live-synced paths — `MEMORY.md` and `memory/`. The `+INDEX.md` text
//!   is the "synced live from" variant. Pre-existing entries at the
//!   target paths are removed first; dangling symlinks are allowed
//!   because the workspace files may not exist yet.
//!
//! Unix-only — TENEX is unix-targeted and the symlink semantics differ
//! on Windows.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// `getAgentHomeDirectory` (`agent-home.ts:46-49`):
/// `<base>/home/<first-8-of-pubkey>`. The 8-char prefix is enough to
/// keep collisions astronomically unlikely while staying short for
/// shell tooling.
pub fn get_agent_home_directory(base_dir: &Path, pubkey: &str) -> PathBuf {
    let short: String = pubkey.chars().take(8).collect();
    base_dir.join("home").join(short)
}

const COPIED_INDEX_PREAMBLE: &str = "# Memory Files\n\n\
This agent's memory was copied from an OpenClaw installation.\n\n\
- `MEMORY.md` — long-term curated memory (copied from OpenClaw)\n\
- `memory/YYYY-MM-DD.md` — daily session logs (copied from OpenClaw)\n\n";

const SYNCED_INDEX_PREAMBLE: &str = "# Memory Files\n\n\
This agent's memory is synced live from an OpenClaw installation.\n\n\
- `MEMORY.md` — long-term curated memory (updated by OpenClaw)\n\
- `memory/YYYY-MM-DD.md` — daily session logs (updated by OpenClaw)\n\n";

/// Build the `+INDEX.md` content. Trailing `Source: <workspace>\n` line
/// matches the TS template literal (`openclaw.ts:38-46, 61-69`).
fn index_content(no_sync: bool, workspace_path: &Path) -> String {
    let preamble = if no_sync {
        COPIED_INDEX_PREAMBLE
    } else {
        SYNCED_INDEX_PREAMBLE
    };
    format!("{preamble}Source: {}\n", workspace_path.display())
}

/// Recursive copy — matches `fs.cp(src, dst, { recursive: true })`.
/// Files overwrite, directories merge.
fn copy_recursive(src: &Path, dst: &Path) -> Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst).with_context(|| format!("create {}", dst.display()))?;
        for entry in fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst).with_context(|| {
            format!("copy {} → {}", src.display(), dst.display())
        })?;
    }
    Ok(())
}

/// Remove `path` whether it's a regular file, symlink, or directory.
/// Returns `Ok(())` whether or not it existed (matches `fs.rm(p,
/// { force: true })`).
fn remove_anything(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
                fs::remove_dir_all(path)
                    .with_context(|| format!("remove dir {}", path.display()))?;
            } else {
                fs::remove_file(path)
                    .with_context(|| format!("remove {}", path.display()))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::Error::new(e)
            .context(format!("stat {}", path.display()))),
    }
}

/// Mirror `createHomeDir` (`openclaw.ts:26-74`).
///
/// Returns the materialized home directory path.
pub fn create_home_dir(
    base_dir: &Path,
    pubkey: &str,
    workspace_path: &Path,
    no_sync: bool,
) -> Result<PathBuf> {
    let home_dir = get_agent_home_directory(base_dir, pubkey);
    fs::create_dir_all(&home_dir)
        .with_context(|| format!("create {}", home_dir.display()))?;

    if no_sync {
        copy_recursive(workspace_path, &home_dir)?;
    } else {
        // Symlink MEMORY.md (dangling is OK — workspace file may not
        // exist yet at import time).
        let memory_md_target = workspace_path.join("MEMORY.md");
        let memory_md_link = home_dir.join("MEMORY.md");
        remove_anything(&memory_md_link)?;
        symlink(&memory_md_target, &memory_md_link).with_context(|| {
            format!(
                "symlink {} → {}",
                memory_md_target.display(),
                memory_md_link.display()
            )
        })?;

        // Symlink memory/ directory (dangling is OK).
        let memory_dir_target = workspace_path.join("memory");
        let memory_dir_link = home_dir.join("memory");
        remove_anything(&memory_dir_link)?;
        symlink(&memory_dir_target, &memory_dir_link).with_context(|| {
            format!(
                "symlink {} → {}",
                memory_dir_target.display(),
                memory_dir_link.display()
            )
        })?;
    }

    let index_path = home_dir.join("+INDEX.md");
    fs::write(&index_path, index_content(no_sync, workspace_path))
        .with_context(|| format!("write {}", index_path.display()))?;

    Ok(home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-openclaw-home-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixture_pubkey() -> &'static str {
        // 64-char hex; only the first 8 matter to the home-dir mapping.
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    }

    // ── get_agent_home_directory ───────────────────────────────────────

    #[test]
    fn home_dir_uses_first_8_of_pubkey_under_base_home() {
        let base = PathBuf::from("/tmp/test-base");
        let home = get_agent_home_directory(&base, fixture_pubkey());
        assert_eq!(home, PathBuf::from("/tmp/test-base/home/abcdef12"));
    }

    #[test]
    fn home_dir_handles_short_pubkey() {
        // First 8 chars or fewer if pubkey shorter (TS slice semantics).
        let base = PathBuf::from("/tmp/test-base");
        let home = get_agent_home_directory(&base, "abc");
        assert_eq!(home, PathBuf::from("/tmp/test-base/home/abc"));
    }

    // ── index_content ──────────────────────────────────────────────────

    #[test]
    fn index_content_copy_branch_uses_was_copied_phrasing() {
        let workspace = PathBuf::from("/some/workspace");
        let body = index_content(true, &workspace);
        assert!(body.contains("This agent's memory was copied from an OpenClaw installation."));
        assert!(body.contains("(copied from OpenClaw)"));
        assert!(body.ends_with("Source: /some/workspace\n"));
    }

    #[test]
    fn index_content_symlink_branch_uses_synced_live_phrasing() {
        let workspace = PathBuf::from("/some/workspace");
        let body = index_content(false, &workspace);
        assert!(body.contains("This agent's memory is synced live from an OpenClaw installation."));
        assert!(body.contains("(updated by OpenClaw)"));
        assert!(body.ends_with("Source: /some/workspace\n"));
    }

    // ── copy mode (no_sync = true) ─────────────────────────────────────

    #[test]
    fn copy_mode_recursively_copies_workspace_and_writes_index() {
        let base = unique_temp();
        let workspace = base.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("MEMORY.md"), "long-term").unwrap();
        let memory_dir = workspace.join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        fs::write(memory_dir.join("2026-04-28.md"), "session log").unwrap();

        let pubkey = fixture_pubkey();
        let home = create_home_dir(&base, pubkey, &workspace, true).unwrap();

        assert_eq!(
            fs::read_to_string(home.join("MEMORY.md")).unwrap(),
            "long-term"
        );
        assert_eq!(
            fs::read_to_string(home.join("memory").join("2026-04-28.md"))
                .unwrap(),
            "session log"
        );
        let index = fs::read_to_string(home.join("+INDEX.md")).unwrap();
        assert!(index.contains("was copied from"));
        assert!(index.ends_with(&format!("Source: {}\n", workspace.display())));

        // Symlink check: in copy mode, MEMORY.md is a regular file, not a link.
        let meta = fs::symlink_metadata(home.join("MEMORY.md")).unwrap();
        assert!(!meta.file_type().is_symlink());
        fs::remove_dir_all(&base).ok();
    }

    // ── symlink mode (no_sync = false) ─────────────────────────────────

    #[test]
    fn symlink_mode_creates_dangling_symlinks_when_workspace_paths_absent() {
        // The TS source explicitly says "dangling is ok — file may not
        // exist yet". Verify symlinks are created even when the
        // workspace files don't exist at import time.
        let base = unique_temp();
        let workspace = base.join("workspace");
        // Don't create any workspace files.

        let pubkey = fixture_pubkey();
        let home = create_home_dir(&base, pubkey, &workspace, false).unwrap();

        let memory_md_link = home.join("MEMORY.md");
        let meta = fs::symlink_metadata(&memory_md_link).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "MEMORY.md should be a symlink"
        );
        assert_eq!(
            fs::read_link(&memory_md_link).unwrap(),
            workspace.join("MEMORY.md")
        );

        let memory_dir_link = home.join("memory");
        let meta = fs::symlink_metadata(&memory_dir_link).unwrap();
        assert!(meta.file_type().is_symlink(), "memory should be a symlink");
        assert_eq!(
            fs::read_link(&memory_dir_link).unwrap(),
            workspace.join("memory")
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn symlink_mode_replaces_pre_existing_links_and_files() {
        let base = unique_temp();
        let workspace = base.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("MEMORY.md"), "real").unwrap();
        fs::create_dir_all(workspace.join("memory")).unwrap();

        let pubkey = fixture_pubkey();
        let home = get_agent_home_directory(&base, pubkey);
        fs::create_dir_all(&home).unwrap();
        // Pre-existing MEMORY.md as a regular file (not a symlink).
        fs::write(home.join("MEMORY.md"), "stale").unwrap();
        // Pre-existing memory/ as a real directory.
        fs::create_dir_all(home.join("memory")).unwrap();
        fs::write(home.join("memory").join("stale.md"), "x").unwrap();

        let resolved = create_home_dir(&base, pubkey, &workspace, false).unwrap();
        assert_eq!(resolved, home);

        // Both should now be symlinks.
        let meta = fs::symlink_metadata(home.join("MEMORY.md")).unwrap();
        assert!(meta.file_type().is_symlink());
        let meta = fs::symlink_metadata(home.join("memory")).unwrap();
        assert!(meta.file_type().is_symlink());
        // Stale file inside the old `memory/` dir is gone.
        assert!(!home.join("memory").join("stale.md").exists() || {
            // It might still resolve through the new symlink if the
            // target dir exists with that file — but we didn't create
            // workspace/memory/stale.md, so it should not resolve.
            !workspace.join("memory").join("stale.md").exists()
        });
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn symlink_mode_writes_synced_index_content() {
        let base = unique_temp();
        let workspace = base.join("workspace");
        let pubkey = fixture_pubkey();
        let home = create_home_dir(&base, pubkey, &workspace, false).unwrap();
        let index = fs::read_to_string(home.join("+INDEX.md")).unwrap();
        assert!(index.contains("synced live from"));
        assert!(index.contains("(updated by OpenClaw)"));
        fs::remove_dir_all(&base).ok();
    }

    // ── helpers ────────────────────────────────────────────────────────

    #[test]
    fn remove_anything_handles_missing_path_silently() {
        let base = unique_temp();
        let p = base.join("does-not-exist");
        assert!(remove_anything(&p).is_ok());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_recursive_creates_subdirs_and_copies_nested_files() {
        let base = unique_temp();
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("sub").join("nested")).unwrap();
        fs::write(src.join("top.txt"), "T").unwrap();
        fs::write(src.join("sub").join("mid.txt"), "M").unwrap();
        fs::write(src.join("sub").join("nested").join("deep.txt"), "D").unwrap();
        copy_recursive(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("top.txt")).unwrap(), "T");
        assert_eq!(fs::read_to_string(dst.join("sub").join("mid.txt")).unwrap(), "M");
        assert_eq!(
            fs::read_to_string(dst.join("sub").join("nested").join("deep.txt")).unwrap(),
            "D"
        );
        fs::remove_dir_all(&base).ok();
    }
}

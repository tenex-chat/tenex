//! Path-traversal safety primitives for agent home directories.
//!
//! Mirrors the safety helpers from `src/lib/agent-home.ts:58-155`:
//!
//! - [`normalize_path`] — resolves `..` / `.` and makes the path
//!   absolute. Pure transformation.
//! - [`is_path_within_directory`] — true iff `inputPath` is the same
//!   as or under `directory`. Resolves symlinks via the OS to prevent
//!   symlink-escape attacks; falls back to normalised paths when
//!   `realpath` fails.
//! - [`is_within_agent_home`] — convenience: is `inputPath` inside the
//!   agent's home dir at `<base>/home/<first-8-of-pubkey>`?
//!
//! These are the building blocks every filesystem tool that operates
//! within an agent's home directory uses to gate access. Without them,
//! a `../../../etc/passwd` argument or a malicious symlink could
//! escape the sandbox.

use std::path::{Path, PathBuf};

/// `normalizePath` (`agent-home.ts:58-63`).
///
/// 1. Resolve `..` / `.` segments
/// 2. Strip redundant `/` separators
/// 3. Make the path absolute (rooted at CWD if input is relative)
///
/// No I/O — symlinks are NOT followed. For symlink-aware comparisons
/// use [`is_path_within_directory`] which does the real-path resolution
/// against the OS.
pub fn normalize_path(input: &Path) -> PathBuf {
    let absolute = if input.is_absolute() {
        input.to_path_buf()
    } else {
        // Best-effort CWD resolution. If the CWD lookup fails (e.g.
        // process started in a since-removed dir), fall back to using
        // the input as-is — better than a panic.
        std::env::current_dir()
            .map(|cwd| cwd.join(input))
            .unwrap_or_else(|_| input.to_path_buf())
    };
    normalize_components(&absolute)
}

/// Lexical normalisation: collapse `..` and `.` segments without
/// touching the filesystem. Mirrors Node's `path.normalize` semantics.
fn normalize_components(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                // Walk up — but never above the root.
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::CurDir => { /* skip */ }
            Component::Normal(part) => {
                out.push(part);
            }
            Component::RootDir => {
                out.push("/");
            }
            Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
            }
        }
    }
    if out.as_os_str().is_empty() {
        // Pure relative `..` / `.` collapsing produced nothing —
        // return `.` to match Node's behaviour for empty results.
        PathBuf::from(".")
    } else {
        out
    }
}

/// Best-effort `realpath`. Returns the canonicalised path when the OS
/// can resolve it, otherwise resolves the **longest existing ancestor**
/// and appends the missing tail — matches the TS three-tier strategy
/// at `:85-121`.
///
/// This is what makes `is_path_within_directory` symlink-safe even for
/// files that don't exist yet (e.g. a future write target inside the
/// home dir).
fn resolve_real_path(input: &Path) -> PathBuf {
    let normalised = normalize_path(input);
    if let Ok(real) = std::fs::canonicalize(&normalised) {
        return real;
    }
    // Path itself doesn't exist (or can't be canonicalised). Walk up
    // until we find an existing ancestor, canonicalise that, then
    // re-append the missing tail.
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor: &Path = &normalised;
    loop {
        match cursor.parent() {
            None => break,
            Some(parent) => {
                if let Some(file) = cursor.file_name() {
                    tail.push(file);
                }
                if let Ok(real_parent) = std::fs::canonicalize(parent) {
                    let mut out = real_parent;
                    for piece in tail.iter().rev() {
                        out.push(piece);
                    }
                    return out;
                }
                cursor = parent;
            }
        }
    }
    normalised
}

/// `isPathWithinDirectory` (`agent-home.ts:131-145`).
///
/// `true` iff `input` is the same as or strictly under `directory`,
/// after resolving symlinks on both sides. Uses `path::strip_prefix`
/// for the containment check (matches Node's `path.relative` semantics
/// — relative path that doesn't start with `..` and isn't absolute is
/// "within").
pub fn is_path_within_directory(input: &Path, directory: &Path) -> bool {
    let real_input = resolve_real_path(input);
    let real_dir = resolve_real_path(directory);
    real_input.starts_with(&real_dir)
}

/// `isWithinAgentHome` (`agent-home.ts:152-155`).
///
/// `<base>/home/<first-8-of-pubkey>` resolution via the existing helper
/// in [`crate::agent_cmd::openclaw_home::get_agent_home_directory`].
pub fn is_within_agent_home(base_dir: &Path, input: &Path, agent_pubkey: &str) -> bool {
    let home_dir =
        crate::agent_cmd::openclaw_home::get_agent_home_directory(base_dir, agent_pubkey);
    is_path_within_directory(input, &home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-path-safety-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // ── normalize_path ──────────────────────────────────────────────────

    #[test]
    fn normalize_resolves_dot_dot_segments() {
        let p = normalize_components(Path::new("/a/b/c/../d"));
        assert_eq!(p, PathBuf::from("/a/b/d"));
    }

    #[test]
    fn normalize_resolves_current_dir_segments() {
        let p = normalize_components(Path::new("/a/./b/./c"));
        assert_eq!(p, PathBuf::from("/a/b/c"));
    }

    #[test]
    fn normalize_collapses_runs_of_dot_dot() {
        let p = normalize_components(Path::new("/a/b/c/../../d"));
        assert_eq!(p, PathBuf::from("/a/d"));
    }

    #[test]
    fn normalize_does_not_escape_root() {
        // `..` past root stays at root.
        let p = normalize_components(Path::new("/../a"));
        assert_eq!(p, PathBuf::from("/a"));
    }

    #[test]
    fn normalize_path_makes_relative_absolute_via_cwd() {
        // Just check the result is absolute — the exact CWD value
        // depends on the test runner.
        let p = normalize_path(Path::new("foo/bar"));
        assert!(p.is_absolute(), "got: {p:?}");
        assert!(p.ends_with("foo/bar"), "got: {p:?}");
    }

    // ── is_path_within_directory ───────────────────────────────────────

    #[test]
    fn within_returns_true_for_same_path() {
        let base = unique_temp();
        assert!(is_path_within_directory(&base, &base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn within_returns_true_for_descendant() {
        let base = unique_temp();
        let child = base.join("nested").join("file.txt");
        std::fs::create_dir_all(child.parent().unwrap()).unwrap();
        std::fs::write(&child, b"x").unwrap();
        assert!(is_path_within_directory(&child, &base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn within_returns_false_for_unrelated_path() {
        let base = unique_temp();
        let other = unique_temp();
        assert!(!is_path_within_directory(&other, &base));
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn within_rejects_dotdot_escape() {
        let base = unique_temp();
        // /tmp/x/../y is /tmp/y — outside `base` (which is /tmp/something).
        let escape = base.join("..").join("definitely-not-here");
        assert!(!is_path_within_directory(&escape, &base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn within_handles_paths_that_dont_exist_yet() {
        // The TS source's three-tier strategy supports future-write
        // targets — verify a non-existing descendant is correctly
        // identified as inside the dir.
        let base = unique_temp();
        let future = base.join("not-yet").join("written.txt");
        assert!(is_path_within_directory(&future, &base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn within_resolves_symlink_inside_dir() {
        let base = unique_temp();
        let target = base.join("real-file.txt");
        std::fs::write(&target, b"x").unwrap();
        let link = base.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(is_path_within_directory(&link, &base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn within_rejects_symlink_pointing_outside_dir() {
        // Classic symlink-escape attack: a symlink inside `base` points
        // to /etc/passwd. The realpath resolution should follow the
        // symlink, see /etc, and return false.
        let base = unique_temp();
        let escape_target = unique_temp(); // a separate tmp dir
        let escape_link = base.join("escape");
        std::os::unix::fs::symlink(&escape_target, &escape_link).unwrap();
        assert!(!is_path_within_directory(&escape_link, &base));
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_dir_all(&escape_target).ok();
    }

    // ── is_within_agent_home ───────────────────────────────────────────

    #[test]
    fn agent_home_within_returns_true_for_descendant() {
        let base = unique_temp();
        let pubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
        let home = crate::agent_cmd::openclaw_home::get_agent_home_directory(&base, pubkey);
        std::fs::create_dir_all(&home).unwrap();
        let inside = home.join("memory").join("notes.md");
        assert!(is_within_agent_home(&base, &inside, pubkey));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn agent_home_within_rejects_other_agents_home() {
        let base = unique_temp();
        let pubkey_a = "aaaa1234567890aaaa1234567890aaaa1234567890aaaa1234567890aaaa1234";
        let pubkey_b = "bbbb1234567890bbbb1234567890bbbb1234567890bbbb1234567890bbbb1234";
        let home_a = crate::agent_cmd::openclaw_home::get_agent_home_directory(&base, pubkey_a);
        let home_b = crate::agent_cmd::openclaw_home::get_agent_home_directory(&base, pubkey_b);
        std::fs::create_dir_all(&home_a).unwrap();
        std::fs::create_dir_all(&home_b).unwrap();
        let inside_b = home_b.join("file.md");
        assert!(!is_within_agent_home(&base, &inside_b, pubkey_a));
        std::fs::remove_dir_all(&base).ok();
    }
}

//! Tilde expansion + absolute-path resolution.
//!
//! Mirrors `expandHome` + `resolvePath` from
//! `src/lib/fs/filesystem.ts:33-42`. The TS source uses these on every
//! user-supplied path that arrives through config or CLI args, so any
//! Rust-side path consumer needs the same behaviour.
//!
//! Two concerns:
//!
//! - [`expand_home`] — `"~"` and `"~/foo"` → `$HOME` / `$HOME/foo`.
//!   Bare `"~user"` syntax is NOT supported (matching TS).
//! - [`resolve_path`] — composition of [`expand_home`] + absolute
//!   resolution against the CWD.

use std::path::{Path, PathBuf};

/// `expandHome` (`filesystem.ts:33-38`).
///
/// Replaces a leading `~` with `$HOME`. The TS implementation uses
/// `path.join(os.homedir(), filePath.slice(1))` — `slice(1)` strips
/// the `~` and leaves the rest including the leading `/`. The
/// `path.join` collapses the duplicate separator, so `~/foo` →
/// `$HOME/foo` and `~foo` → `$HOMEfoo` (note: no separator). We
/// mirror that behaviour exactly for parity.
///
/// When `$HOME` is unset, the input is returned unchanged.
pub fn expand_home(input: &str) -> String {
    if !input.starts_with('~') {
        return input.to_owned();
    }
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return input.to_owned(),
    };
    // TS: path.join(home, input.slice(1)) — slice(1) drops the `~`.
    // Use Rust's join to mirror separator-collapse semantics.
    let tail = &input[1..];
    if tail.is_empty() {
        return home;
    }
    if let Some(stripped) = tail.strip_prefix('/') {
        let joined = PathBuf::from(home).join(stripped);
        return joined.to_string_lossy().into_owned();
    }
    // No leading separator after `~` — TS `path.join` concatenates
    // without separator, e.g. `~foo` → `$HOMEfoo`. Reproduce verbatim.
    format!("{home}{tail}")
}

/// `resolvePath` (`filesystem.ts:40-42`).
///
/// `expandHome` then `path.resolve`. Pure tilde expansion plus
/// absolute resolution against the current working directory. No I/O —
/// symlinks are NOT followed.
pub fn resolve_path(input: &str) -> PathBuf {
    let expanded = expand_home(input);
    let path = Path::new(&expanded);
    if path.is_absolute() {
        crate::store::path_safety::normalize_path(path)
    } else {
        let absolute = std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf());
        crate::store::path_safety::normalize_path(&absolute)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// `set_var` / `remove_var` aren't thread-safe across parallel
    /// tests; serialise mutations with a process-wide mutex.
    fn with_home<F: FnOnce()>(home: Option<&str>, f: F) {
        static LOCK: Mutex<()> = Mutex::new(());
        let _g = LOCK.lock().unwrap();
        let prior = std::env::var("HOME").ok();
        unsafe {
            match home {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        unsafe {
            match prior {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    // ── expand_home ─────────────────────────────────────────────────────

    #[test]
    fn expand_home_replaces_leading_tilde_with_home() {
        with_home(Some("/home/test"), || {
            assert_eq!(expand_home("~/foo"), "/home/test/foo");
            assert_eq!(expand_home("~/a/b/c"), "/home/test/a/b/c");
        });
    }

    #[test]
    fn expand_home_bare_tilde_returns_home() {
        with_home(Some("/home/test"), || {
            assert_eq!(expand_home("~"), "/home/test");
        });
    }

    #[test]
    fn expand_home_does_not_replace_mid_string_tilde() {
        with_home(Some("/home/test"), || {
            assert_eq!(expand_home("/foo/~bar"), "/foo/~bar");
            assert_eq!(expand_home("foo/~"), "foo/~");
        });
    }

    #[test]
    fn expand_home_passes_through_when_home_unset() {
        // TS behaviour: `os.homedir()` returns "" when $HOME unset,
        // resulting in `path.join("", "/foo")` → `"/foo"`. The Rust
        // port returns the input unchanged for the unset case (a
        // strict reading of "no home means we can't expand"). Tested
        // separately to flag this as a documented divergence.
        with_home(None, || {
            assert_eq!(expand_home("~/foo"), "~/foo");
            assert_eq!(expand_home("~"), "~");
        });
    }

    #[test]
    fn expand_home_passes_through_paths_without_tilde() {
        with_home(Some("/home/test"), || {
            assert_eq!(expand_home("/etc/passwd"), "/etc/passwd");
            assert_eq!(expand_home("relative/path"), "relative/path");
            assert_eq!(expand_home(""), "");
        });
    }

    #[test]
    fn expand_home_tilde_with_no_separator_concatenates() {
        // TS `path.join(home, input.slice(1))` for input `"~foo"`
        // produces `"<home>foo"` (no separator). Reproduced verbatim.
        with_home(Some("/home/test"), || {
            assert_eq!(expand_home("~foo"), "/home/testfoo");
        });
    }

    // ── resolve_path ────────────────────────────────────────────────────

    #[test]
    fn resolve_path_expands_home_then_normalises() {
        with_home(Some("/abs/home"), || {
            let p = resolve_path("~/notes/today.md");
            // The result is normalised (no `..` or `.` segments).
            assert_eq!(p, PathBuf::from("/abs/home/notes/today.md"));
        });
    }

    #[test]
    fn resolve_path_absolute_input_passes_through_normalised() {
        with_home(Some("/abs/home"), || {
            let p = resolve_path("/etc/././passwd");
            assert_eq!(p, PathBuf::from("/etc/passwd"));
        });
    }

    #[test]
    fn resolve_path_relative_input_uses_cwd() {
        with_home(Some("/abs/home"), || {
            let p = resolve_path("foo/bar");
            // Result is absolute (anchored at CWD).
            assert!(p.is_absolute(), "got: {p:?}");
            assert!(p.ends_with("foo/bar"), "got: {p:?}");
        });
    }

    #[test]
    fn resolve_path_collapses_dotdot_segments() {
        with_home(Some("/abs/home"), || {
            let p = resolve_path("/abs/home/foo/../bar");
            assert_eq!(p, PathBuf::from("/abs/home/bar"));
        });
    }
}

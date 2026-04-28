//! Agent-home file scanner and scoped-path resolver.
//!
//! Mirrors `agent-home.ts:183-349` byte-for-byte. Two concerns:
//!
//! 1. [`get_agent_home_injected_files`] — scan the agent's home dir
//!    for `+`-prefixed regular files, read up to
//!    [`MAX_INJECTED_FILES`] of them with a bounded read length, and
//!    return them as [`InjectedFile`]s. Used to auto-inject custom
//!    instructions into the agent's system prompt without the agent
//!    having to opt in.
//! 2. [`resolve_home_scoped_path`] — resolve an arbitrary input path
//!    against the agent's home dir, returning the absolute resolved
//!    path. Refuses to escape the home dir — returns
//!    [`HomeScopeViolationError`] (same shape as the TS class) when the
//!    resolved path is outside.
//!
//! Both rely on [`crate::store::path_safety::is_path_within_directory`]
//! for symlink-aware containment checks. The scanner adds extra
//! TOCTOU defences:
//!
//! - **Skip symlinks** via `lstat` (don't follow them, don't read them).
//! - **Skip non-files** (directories, FIFOs, sockets, etc.).
//! - **Re-verify realpath inside the home dir** — catches bind-mount
//!   shenanigans even with regular-file metadata.
//! - **Bounded read** to `MAX_INJECTED_FILE_READ_SIZE` bytes — prevents
//!   memory spikes from a large file accidentally placed in home.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::agent_cmd::openclaw_home::get_agent_home_directory;
use crate::store::path_safety::is_path_within_directory;

/// Maximum number of `+`-prefixed files returned. Mirrors
/// `MAX_INJECTED_FILES = 10` (`agent-home.ts:19`).
pub const MAX_INJECTED_FILES: usize = 10;

/// Maximum content length per file before truncation. Mirrors
/// `MAX_INJECTED_FILE_LENGTH = 1500` (`agent-home.ts:24`).
pub const MAX_INJECTED_FILE_LENGTH: usize = 1500;

/// Bounded read size. The TS source reads 100 extra bytes beyond the
/// 1500-char limit so it can detect truncation without re-stat'ing.
/// Mirrors `MAX_INJECTED_FILE_READ_SIZE = MAX_INJECTED_FILE_LENGTH +
/// 100` (`agent-home.ts:187`).
pub const MAX_INJECTED_FILE_READ_SIZE: usize = MAX_INJECTED_FILE_LENGTH + 100;

/// One file injected into the agent system prompt. Mirrors
/// `InjectedFile` (`agent-home.ts:29-33`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedFile {
    pub filename: String,
    pub content: String,
    pub truncated: bool,
}

/// Mirror `HomeScopeViolationError` (`agent-home.ts:8-13`).
///
/// Returned by [`resolve_home_scoped_path`] when the input path
/// resolves outside the agent home dir. The `Display` form matches the
/// TS error message verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeScopeViolationError {
    pub input_path: String,
}

impl std::fmt::Display for HomeScopeViolationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Path \"{}\" is outside your home directory. You can only access files within your home directory.",
            self.input_path,
        )
    }
}

impl std::error::Error for HomeScopeViolationError {}

/// `getAgentHomeInjectedFiles` (`agent-home.ts:310-317`).
///
/// Returns up to [`MAX_INJECTED_FILES`] entries with content truncated
/// to [`MAX_INJECTED_FILE_LENGTH`] chars. Empty Vec on missing dir,
/// scan errors, or zero matching files.
pub fn get_agent_home_injected_files(
    base_dir: &Path,
    agent_pubkey: &str,
) -> Vec<InjectedFile> {
    let home_dir = get_agent_home_directory(base_dir, agent_pubkey);
    // `ensureAgentHomeDirectory` is called by TS but we delegate that
    // to the caller that materialised the home — if the dir doesn't
    // exist, we just return empty.
    if !home_dir.exists() {
        return Vec::new();
    }
    get_injected_files_from_directory(&home_dir)
}

/// Inner helper. Mirrors `getInjectedFilesFromDirectory`
/// (`agent-home.ts:266-308`).
fn get_injected_files_from_directory(directory: &Path) -> Vec<InjectedFile> {
    let entries = match fs::read_dir(directory) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut plus_candidates: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with('+') {
            continue;
        }
        plus_candidates.push((name, entry.path()));
    }
    plus_candidates.sort_by(|a, b| a.0.cmp(&b.0));
    plus_candidates.truncate(MAX_INJECTED_FILES);

    let mut out = Vec::with_capacity(plus_candidates.len());
    for (name, path) in plus_candidates {
        let Some(read) = safe_read_bounded_file(&path, directory, MAX_INJECTED_FILE_READ_SIZE)
        else {
            continue;
        };
        let truncated_by_length = read.content.chars().count() > MAX_INJECTED_FILE_LENGTH;
        let truncated = truncated_by_length || read.truncated;
        let mut content = read.content;
        if truncated_by_length {
            content = content.chars().take(MAX_INJECTED_FILE_LENGTH).collect();
        }
        out.push(InjectedFile {
            filename: name,
            content,
            truncated,
        });
    }
    out
}

struct BoundedRead {
    content: String,
    truncated: bool,
}

/// Mirror `safeReadBoundedFile` (`agent-home.ts:198-250`).
///
/// Returns `None` for symlinks, non-files, paths that resolve outside
/// `home_dir`, or any I/O error.
fn safe_read_bounded_file(
    file_path: &Path,
    home_dir: &Path,
    max_bytes: usize,
) -> Option<BoundedRead> {
    // TOCTOU defence #1: lstat (don't follow symlinks).
    let lstat = fs::symlink_metadata(file_path).ok()?;
    if lstat.file_type().is_symlink() {
        // The TS source emits a console.warn — we silently skip to
        // avoid log spam in legitimate use (e.g. operator-set symlinks
        // they don't intend to inject).
        return None;
    }
    if !lstat.is_file() {
        return None;
    }
    // TOCTOU defence #2: realpath check — even with non-symlink lstat,
    // a bind mount or hardlink could escape the home dir. Use the
    // shared symlink-aware containment helper.
    if !is_path_within_directory(file_path, home_dir) {
        return None;
    }

    let file_size = lstat.len() as usize;
    let bytes_to_read = file_size.min(max_bytes);

    // Use low-level open/read for precise control. `File::open` +
    // `Read::take` gives us bounded read without slurping the whole
    // file when it's larger than `max_bytes`.
    let file = fs::File::open(file_path).ok()?;
    let mut buf = Vec::with_capacity(bytes_to_read);
    file.take(bytes_to_read as u64).read_to_end(&mut buf).ok()?;
    let content = String::from_utf8(buf).ok()?;
    let truncated = file_size > max_bytes;
    Some(BoundedRead { content, truncated })
}

/// `resolveHomeScopedPath` (`agent-home.ts:331-350`).
///
/// Resolve `input` relative to the agent home dir. Absolute paths are
/// taken as-is; relative paths are joined onto the home dir.
/// Refuses to escape the home dir via [`is_path_within_directory`].
///
/// **Does NOT create** the home dir — the TS source calls
/// `ensureAgentHomeDirectory` here, but that's a side effect the Rust
/// caller can perform explicitly if needed (mirrors the rule of "no
/// hidden filesystem mutations from a getter-shaped function").
pub fn resolve_home_scoped_path(
    base_dir: &Path,
    input: &Path,
    agent_pubkey: &str,
) -> Result<PathBuf, HomeScopeViolationError> {
    let home_dir = get_agent_home_directory(base_dir, agent_pubkey);
    let resolved = if input.is_absolute() {
        input.to_path_buf()
    } else {
        home_dir.join(input)
    };
    if !is_path_within_directory(&resolved, &home_dir) {
        return Err(HomeScopeViolationError {
            input_path: input.to_string_lossy().into_owned(),
        });
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-home-files-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixture_pubkey() -> &'static str {
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }

    fn home_for(base: &Path, pubkey: &str) -> PathBuf {
        let h = get_agent_home_directory(base, pubkey);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    // ── HomeScopeViolationError ─────────────────────────────────────────

    #[test]
    fn home_scope_violation_message_matches_ts_verbatim() {
        let e = HomeScopeViolationError {
            input_path: "../escape".into(),
        };
        assert_eq!(
            e.to_string(),
            "Path \"../escape\" is outside your home directory. You can only access files within your home directory."
        );
    }

    // ── get_agent_home_injected_files ───────────────────────────────────

    #[test]
    fn returns_empty_when_home_dir_missing() {
        let base = unique_temp();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        assert!(result.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn returns_empty_when_no_plus_files_present() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        std::fs::write(home.join("regular.md"), "x").unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        assert!(result.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn picks_up_plus_files_in_alphabetical_order() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        std::fs::write(home.join("+ZED.md"), "z").unwrap();
        std::fs::write(home.join("+ABC.md"), "a").unwrap();
        std::fs::write(home.join("+MID.md"), "m").unwrap();
        std::fs::write(home.join("regular.md"), "ignored").unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        let names: Vec<&str> = result.iter().map(|f| f.filename.as_str()).collect();
        // localeCompare on ASCII = byte cmp.
        assert_eq!(names, vec!["+ABC.md", "+MID.md", "+ZED.md"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn caps_at_max_injected_files() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        // Create 15 files; only 10 should be returned.
        for i in 0..15 {
            std::fs::write(home.join(format!("+{i:02}.md")), "x").unwrap();
        }
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        assert_eq!(result.len(), MAX_INJECTED_FILES);
        // First 10 alphabetically: 00..09.
        let first = &result[0].filename;
        let last = &result[result.len() - 1].filename;
        assert_eq!(first, "+00.md");
        assert_eq!(last, "+09.md");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn truncates_content_at_max_length() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        // Write 1600 bytes ('a' * 1600 = 1600 chars in utf8).
        let big = "a".repeat(MAX_INJECTED_FILE_LENGTH + 100);
        std::fs::write(home.join("+big.md"), &big).unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content.chars().count(), MAX_INJECTED_FILE_LENGTH);
        assert!(result[0].truncated);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn small_files_are_not_marked_truncated() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        std::fs::write(home.join("+small.md"), "hello").unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content, "hello");
        assert!(!result[0].truncated);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn skips_directories_with_plus_prefix() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        std::fs::create_dir_all(home.join("+notes")).unwrap();
        std::fs::write(home.join("+real.md"), "x").unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        let names: Vec<&str> = result.iter().map(|f| f.filename.as_str()).collect();
        assert_eq!(names, vec!["+real.md"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_with_plus_prefix() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        let target = home.join("real-target.md");
        std::fs::write(&target, "should not be injected via symlink").unwrap();
        let link = home.join("+symlinked.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let result = get_agent_home_injected_files(&base, fixture_pubkey());
        // The symlink is rejected; nothing else in the dir matches `+`,
        // so result is empty.
        assert!(result.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── resolve_home_scoped_path ────────────────────────────────────────

    #[test]
    fn resolves_relative_input_against_home() {
        let base = unique_temp();
        home_for(&base, fixture_pubkey());
        let resolved =
            resolve_home_scoped_path(&base, Path::new("notes/today.md"), fixture_pubkey())
                .unwrap();
        assert!(resolved.ends_with("notes/today.md"));
        assert!(resolved.starts_with(&base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn passes_through_absolute_input_inside_home() {
        let base = unique_temp();
        let home = home_for(&base, fixture_pubkey());
        let inside = home.join("memory.md");
        let resolved =
            resolve_home_scoped_path(&base, &inside, fixture_pubkey()).unwrap();
        assert_eq!(resolved, inside);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rejects_dotdot_escape_with_verbatim_error() {
        let base = unique_temp();
        home_for(&base, fixture_pubkey());
        let err = resolve_home_scoped_path(
            &base,
            Path::new("../escape"),
            fixture_pubkey(),
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Path \"../escape\" is outside your home directory. You can only access files within your home directory."
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rejects_absolute_path_outside_home() {
        let base = unique_temp();
        let other = unique_temp();
        home_for(&base, fixture_pubkey());
        let err = resolve_home_scoped_path(&base, &other, fixture_pubkey()).unwrap_err();
        assert!(err.input_path.contains("tenex-home-files-"));
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_dir_all(&other).ok();
    }
}

//! File-modification tracking for `fs_write`.
//!
//! When an agent writes a file via `fs_write`, [`FileSnapshotWriter::capture`]
//! snapshots the written content (up to [`MAX_SNAPSHOT_BYTES`]) into the
//! conversation DB, keyed by `(conversation_id, agent_pubkey, file_path)`.
//!
//! On a later run of the same agent in the same conversation,
//! [`render_reminder`] diffs each snapshot against the current on-disk state
//! and produces a `<system-reminder type="file-modifications">` block listing
//! every file that changed externally since the agent last wrote it.
//!
//! Both sides resolve `file_path` identically (env-var expansion + join against
//! `working_dir`, matching `tools::fs::resolve_path`) and hash the *bytes read
//! back from disk* with SHA-256, so capture and compare stay symmetric — a file
//! the agent wrote and nobody else touched never reports as modified.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tenex_conversations::{ConversationStore, FileSnapshot, NewFileSnapshot};

/// Files larger than this are snapshotted by hash + size only (`content_bytes`
/// is `None`); they can report "modified" but cannot produce an inline diff.
const MAX_SNAPSHOT_BYTES: u64 = 50 * 1024;

/// Maximum rendered unified-diff size to inline. Larger diffs collapse to a
/// summary. Independent of [`MAX_SNAPSHOT_BYTES`].
const MAX_INLINE_DIFF_BYTES: usize = 8 * 1024;

/// The prefix `fs_write` emits on success. Capture is gated on this so blocked
/// (`skip` reason) and failed (`Error writing …`) tool results never produce a
/// bogus baseline.
const FS_WRITE_SUCCESS_PREFIX: &str = "Successfully wrote";

/// Captures `fs_write` snapshots into the conversation DB. Holds the addressing
/// needed to resolve a written path and persist it under the right conversation
/// + agent. Stateless beyond its configuration; opens the store per capture
/// (writes are serialized upstream by RAL).
pub struct FileSnapshotWriter {
    db_path: PathBuf,
    conversation_id: String,
    agent_pubkey: String,
    execution_id: String,
    working_dir: String,
}

impl FileSnapshotWriter {
    pub fn new(
        db_path: PathBuf,
        conversation_id: String,
        agent_pubkey: String,
        execution_id: String,
        working_dir: String,
    ) -> Self {
        Self {
            db_path,
            conversation_id,
            agent_pubkey,
            execution_id,
            working_dir,
        }
    }

    /// Snapshot the file an `fs_write` call just wrote. No-op unless `result`
    /// indicates the write succeeded. `args` is the raw `fs_write` argument
    /// JSON; its `path` field is resolved against `working_dir` and the file is
    /// re-read from disk to hash it.
    pub fn capture(&self, args: &str, result: &str) {
        if !result.starts_with(FS_WRITE_SUCCESS_PREFIX) {
            return;
        }
        let Some(rel_path) = parse_write_path(args) else {
            return;
        };
        let resolved = resolve_path(&self.working_dir, &rel_path);
        let bytes = match std::fs::read(&resolved) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(
                    path = %resolved.display(),
                    error = %e,
                    "fs_write snapshot: could not read written file"
                );
                return;
            }
        };
        let size_bytes = bytes.len() as i64;
        let content_hash = hash_bytes(&bytes);
        let content_bytes = if bytes.len() as u64 <= MAX_SNAPSHOT_BYTES {
            Some(bytes)
        } else {
            None
        };

        let store = match ConversationStore::open(&self.db_path) {
            Ok(store) => store,
            Err(e) => {
                tracing::warn!(error = %e, "fs_write snapshot: conversation store unavailable");
                return;
            }
        };
        if let Err(e) = store.record_file_snapshot(
            &self.conversation_id,
            &NewFileSnapshot {
                agent_pubkey: self.agent_pubkey.clone(),
                execution_id: self.execution_id.clone(),
                file_path: rel_path,
                content_hash,
                content_bytes,
                size_bytes,
            },
        ) {
            tracing::warn!(error = %e, "fs_write snapshot: failed to record");
        }
    }
}

/// Build the `<system-reminder type="file-modifications">` block for this
/// agent + conversation, or `None` when no tracked file changed externally.
///
/// Opens the conversation DB at `db_path`, reads every snapshot this agent
/// wrote in this conversation, re-reads each file from disk (resolved against
/// `working_dir`), and includes only those whose content now differs from the
/// snapshot hash.
pub fn render_reminder(
    db_path: &Path,
    conversation_id: &str,
    agent_pubkey: &str,
    working_dir: &str,
) -> Option<String> {
    let store = ConversationStore::open(db_path).ok()?;
    let snapshots = store
        .get_file_snapshots_for_agent(conversation_id, agent_pubkey)
        .ok()?;
    if snapshots.is_empty() {
        return None;
    }

    let mut blocks = Vec::new();
    for snapshot in &snapshots {
        if let Some(block) = render_file_block(snapshot, working_dir) {
            blocks.push(block);
        }
    }
    if blocks.is_empty() {
        return None;
    }

    let mut out = String::from(
        "<system-reminder type=\"file-modifications\">\nThe following files you wrote in this conversation have been modified externally since your last run:\n",
    );
    for block in blocks {
        out.push('\n');
        out.push_str(&block);
    }
    out.push_str("</system-reminder>");
    Some(out)
}

/// Render a single `<file-modification>` block for a snapshot whose on-disk
/// content differs from the recorded hash. Returns `None` when the file is
/// unchanged or can no longer be read.
fn render_file_block(snapshot: &FileSnapshot, working_dir: &str) -> Option<String> {
    let resolved = resolve_path(working_dir, &snapshot.file_path);
    let current = std::fs::read(&resolved).ok()?;
    if hash_bytes(&current) == snapshot.content_hash {
        return None;
    }

    let path = &snapshot.file_path;
    let body = match snapshot.content_bytes.as_deref() {
        Some(old_bytes) => render_change(old_bytes, &current),
        None => summarize_change(snapshot.size_bytes, current.len() as i64, None),
    };
    Some(format!(
        "<file-modification path=\"{path}\">\n{body}\n</file-modification>\n"
    ))
}

/// Render the change between the snapshot bytes and current bytes: a unified
/// text diff when both are UTF-8 and the diff is small, otherwise a summary.
fn render_change(old_bytes: &[u8], new_bytes: &[u8]) -> String {
    let (Ok(old_text), Ok(new_text)) = (
        std::str::from_utf8(old_bytes),
        std::str::from_utf8(new_bytes),
    ) else {
        // Binary on either side: TextDiff is text-oriented, fall back to a
        // size + line-count summary (line count only when both are text).
        return summarize_change(old_bytes.len() as i64, new_bytes.len() as i64, None);
    };

    let diff = similar::TextDiff::from_lines(old_text, new_text);
    let rendered = diff
        .unified_diff()
        .context_radius(3)
        .header("your version", "current")
        .to_string();

    if rendered.len() <= MAX_INLINE_DIFF_BYTES {
        return rendered.trim_end().to_string();
    }

    let (mut added, mut removed) = (0i64, 0i64);
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    summarize_change(
        old_bytes.len() as i64,
        new_bytes.len() as i64,
        Some((added, removed)),
    )
}

/// A compact size/line-count summary used when an inline diff is unavailable
/// (binary content, snapshot stored without bytes, or oversized diff).
fn summarize_change(old_size: i64, new_size: i64, lines: Option<(i64, i64)>) -> String {
    let byte_delta = new_size - old_size;
    let mut summary = match lines {
        Some((added, removed)) => {
            format!("{added} line(s) added, {removed} line(s) removed")
        }
        None => "content changed".to_string(),
    };
    summary.push_str(&format!(
        " ({old_size} → {new_size} bytes, {byte_delta:+} bytes)"
    ));
    summary
}

/// Parse the `path` field from raw `fs_write` argument JSON. Returns the path
/// exactly as the agent supplied it (relative to the working directory).
fn parse_write_path(args: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(args).ok()?;
    value
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::to_string)
}

/// SHA-256 hex of `bytes`.
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Resolve a `fs_write` path against `working_dir`, mirroring
/// `tools::fs::resolve_path`: expand `$VAR` / `${VAR}`, then join relative
/// paths onto `working_dir`. Kept in lockstep with the tool so capture and
/// compare resolve to the same file.
fn resolve_path(working_dir: &str, path: &str) -> PathBuf {
    let expanded = expand_env_vars(path);
    let p = Path::new(&expanded);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(working_dir).join(p)
    }
}

/// Expand `$VAR` and `${VAR}` using `std::env::var`. Unknown variables are left
/// verbatim. Mirrors `tools::fs::expand_env_vars` so resolution matches the
/// `fs_write` tool exactly.
fn expand_env_vars(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'{' {
                if let Some(end_rel) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                    let name = std::str::from_utf8(&bytes[i + 2..i + 2 + end_rel]).unwrap_or("");
                    if !name.is_empty() {
                        match std::env::var(name) {
                            Ok(v) => out.push_str(&v),
                            Err(_) => out.push_str(&input[i..i + 2 + end_rel + 1]),
                        }
                        i += 2 + end_rel + 1;
                        continue;
                    }
                }
            }
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if end > start {
                let name = std::str::from_utf8(&bytes[start..end]).unwrap_or("");
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&input[i..end]),
                }
                i = end;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn writer(dir: &TempDir, db: &std::path::Path) -> FileSnapshotWriter {
        FileSnapshotWriter::new(
            db.to_path_buf(),
            "conv-1".into(),
            "agent-1".into(),
            "exec-1".into(),
            dir.path().display().to_string(),
        )
    }

    fn open_db(dir: &TempDir) -> (std::path::PathBuf, ConversationStore) {
        let db_path = dir.path().join("conversation.db");
        let store = ConversationStore::open(&db_path).unwrap();
        store.ensure_conversation("conv-1").unwrap();
        (db_path, store)
    }

    #[test]
    fn capture_skips_failed_write() {
        let dir = TempDir::new().unwrap();
        let (db_path, store) = open_db(&dir);
        let w = writer(&dir, &db_path);
        // No file on disk; result is an error string → must not record.
        w.capture(
            r#"{"path":"foo.txt","content":"x"}"#,
            "Error writing foo.txt: permission denied",
        );
        assert!(store
            .get_file_snapshots_for_agent("conv-1", "agent-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn capture_then_no_reminder_when_unchanged() {
        let dir = TempDir::new().unwrap();
        let (db_path, _store) = open_db(&dir);
        std::fs::write(dir.path().join("foo.txt"), b"original\n").unwrap();
        let w = writer(&dir, &db_path);
        w.capture(
            r#"{"path":"foo.txt","content":"original\n"}"#,
            "Successfully wrote 9 bytes to /x/foo.txt",
        );
        let reminder = render_reminder(
            &db_path,
            "conv-1",
            "agent-1",
            &dir.path().display().to_string(),
        );
        assert!(reminder.is_none(), "unchanged file must not warn");
    }

    #[test]
    fn external_modification_produces_diff_reminder() {
        let dir = TempDir::new().unwrap();
        let (db_path, _store) = open_db(&dir);
        let file = dir.path().join("foo.txt");
        std::fs::write(&file, b"original\n").unwrap();
        let w = writer(&dir, &db_path);
        w.capture(
            r#"{"path":"foo.txt","content":"original\n"}"#,
            "Successfully wrote 9 bytes to /x/foo.txt",
        );
        // External overwrite.
        std::fs::write(&file, b"modified\n").unwrap();

        let reminder = render_reminder(
            &db_path,
            "conv-1",
            "agent-1",
            &dir.path().display().to_string(),
        )
        .expect("modified file must warn");
        assert!(reminder.contains("file-modifications"));
        assert!(reminder.contains("foo.txt"));
        assert!(reminder.contains("-original"));
        assert!(reminder.contains("+modified"));
    }

    #[test]
    fn oversized_file_summarizes_instead_of_diff() {
        let dir = TempDir::new().unwrap();
        let (db_path, _store) = open_db(&dir);
        let file = dir.path().join("big.txt");
        let big = vec![b'a'; (MAX_SNAPSHOT_BYTES + 10) as usize];
        std::fs::write(&file, &big).unwrap();
        let w = writer(&dir, &db_path);
        w.capture(
            r#"{"path":"big.txt","content":"..."}"#,
            "Successfully wrote 51210 bytes to /x/big.txt",
        );
        std::fs::write(&file, b"small\n").unwrap();

        let reminder = render_reminder(
            &db_path,
            "conv-1",
            "agent-1",
            &dir.path().display().to_string(),
        )
        .expect("oversized changed file must warn");
        assert!(reminder.contains("big.txt"));
        assert!(reminder.contains("bytes"));
        // No inline diff for content stored without bytes.
        assert!(!reminder.contains("+small"));
    }
}

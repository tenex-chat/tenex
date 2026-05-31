//! File-modification tracking for `fs_write`: snapshot written files, then diff against on-disk state on a later run.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tenex_conversations::{ConversationStore, FileSnapshot, NewFileSnapshot};

use crate::tools::fs::resolve_path;

/// Files larger than this store hash + size only; no inline diff.
const MAX_SNAPSHOT_BYTES: u64 = 50 * 1024;

/// Diffs larger than this collapse to a summary.
const MAX_INLINE_DIFF_BYTES: usize = 8 * 1024;

/// Capture is gated on this prefix so failed/blocked writes never produce a bogus baseline.
const FS_WRITE_SUCCESS_PREFIX: &str = "Successfully wrote";

/// Captures `fs_write` snapshots into the conversation DB.
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

    /// Snapshot the file an `fs_write` call just wrote; no-op unless the write succeeded.
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

/// Build the `<system-reminder type="file-modifications">` block for this agent + conversation, or `None` when no tracked file changed externally.
pub fn render_reminder(
    db_path: &Path,
    conversation_id: &str,
    agent_pubkey: &str,
    working_dir: &str,
) -> Option<String> {
    let store = match ConversationStore::open(db_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("file_modifications: failed to open conversation DB: {e}");
            return None;
        }
    };
    let snapshots = match store.get_file_snapshots_for_agent(conversation_id, agent_pubkey) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("file_modifications: failed to load file snapshots: {e}");
            return None;
        }
    };
    if snapshots.is_empty() {
        return None;
    }

    let mut blocks = Vec::new();
    let mut triggered_ids: Vec<i64> = Vec::new();
    for snapshot in &snapshots {
        if let Some(block) = render_file_block(snapshot, working_dir) {
            blocks.push(block);
            triggered_ids.push(snapshot.id);
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

    // Delete the triggered snapshots so this reminder fires exactly once.
    // The text is now embedded in the user message and carries forward in the
    // conversation history; re-generating it would duplicate the information.
    if let Err(e) = store.delete_file_snapshots(&triggered_ids) {
        tracing::warn!("file_modifications: failed to clear triggered snapshots: {e}");
    }

    Some(out)
}

/// Render a single `<file-modification>` block for a snapshot whose on-disk content differs from the recorded hash.
fn render_file_block(snapshot: &FileSnapshot, working_dir: &str) -> Option<String> {
    let resolved = resolve_path(working_dir, &snapshot.file_path);
    let path = &snapshot.file_path;
    let current = match std::fs::read(&resolved) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Some(format!(
                "<file-modification path=\"{path}\">\nFile was deleted.\n</file-modification>\n"
            ));
        }
        Err(e) => {
            tracing::warn!(
                "file_modifications: cannot read '{}' for diff: {e}",
                resolved.display()
            );
            return None;
        }
    };
    if hash_bytes(&current) == snapshot.content_hash {
        return None;
    }

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

/// Compact size/line-count summary used when an inline diff is unavailable.
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

fn parse_write_path(args: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(args).ok()?;
    value
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::to_string)
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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

        // Second call must return None: the reminder text is now embedded in
        // the conversation history; re-generating it would duplicate information.
        assert!(
            render_reminder(&db_path, "conv-1", "agent-1", &dir.path().display().to_string())
                .is_none(),
            "reminder must fire only once per modification"
        );
    }

    #[test]
    fn unmodified_snapshot_survives_after_modified_snapshot_clears() {
        let dir = TempDir::new().unwrap();
        let (db_path, _store) = open_db(&dir);
        let modified_file = dir.path().join("changed.txt");
        let stable_file = dir.path().join("stable.txt");
        std::fs::write(&modified_file, b"original\n").unwrap();
        std::fs::write(&stable_file, b"stable\n").unwrap();
        let w = writer(&dir, &db_path);
        w.capture(
            r#"{"path":"changed.txt","content":"original\n"}"#,
            "Successfully wrote 9 bytes to /x/changed.txt",
        );
        w.capture(
            r#"{"path":"stable.txt","content":"stable\n"}"#,
            "Successfully wrote 6 bytes to /x/stable.txt",
        );
        // Only modify one file externally.
        std::fs::write(&modified_file, b"changed\n").unwrap();

        let reminder = render_reminder(
            &db_path,
            "conv-1",
            "agent-1",
            &dir.path().display().to_string(),
        )
        .expect("modified file must warn");
        assert!(reminder.contains("changed.txt"));
        assert!(!reminder.contains("stable.txt"));

        // Now modify the stable file externally — its snapshot was kept, so it
        // triggers on the next run.
        std::fs::write(&stable_file, b"now changed\n").unwrap();
        let reminder2 = render_reminder(
            &db_path,
            "conv-1",
            "agent-1",
            &dir.path().display().to_string(),
        )
        .expect("second modified file must warn");
        assert!(reminder2.contains("stable.txt"));
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

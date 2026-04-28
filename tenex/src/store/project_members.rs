//! `~/.tenex/projects/<dTag>/event.json` — canonical project membership reader.
//!
//! Mirrors `src/services/projects/ProjectMembersReader.ts` exactly. The
//! project's kind:31933 Nostr event is persisted to disk as raw NDKEvent
//! JSON; agent pubkeys belonging to a project are the values of the `p`
//! tags on that event.
//!
//! All reads are pure file I/O — no NDK dependency. Missing files /
//! directories return empty results (mirroring TS `ENOENT` handling).

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use serde_json::Value;

const PROJECTS_DIRNAME: &str = "projects";
const EVENT_FILENAME: &str = "event.json";

fn projects_base_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join(PROJECTS_DIRNAME)
}

fn event_path(base_dir: &std::path::Path, dtag: &str) -> std::path::PathBuf {
    projects_base_path(base_dir).join(dtag).join(EVENT_FILENAME)
}

/// Read the persisted kind:31933 event for `dtag`. Returns `None` when the
/// file does not exist; propagates other I/O errors. Mirrors
/// `readPersistedProjectEvent` (`projectEventStore.ts:57-69`).
pub fn read_persisted_project_event(
    base_dir: &std::path::Path,
    dtag: &str,
) -> Result<Option<Value>> {
    let path = event_path(base_dir, dtag);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let parsed: Value = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", path.display()))?;
            Ok(Some(parsed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::new(e)
            .context(format!("read {}", path.display()))),
    }
}

/// Read the agent pubkeys (p-tag values) for a project's persisted event.
/// Returns an empty Vec when the file is missing or malformed (matching TS
/// behavior at `ProjectMembersReader.ts:37-66`).
///
/// De-duplicates while preserving order of first occurrence.
pub fn read_project_agent_pubkeys(
    base_dir: &std::path::Path,
    dtag: &str,
) -> Result<Vec<String>> {
    let parsed = match read_persisted_project_event(base_dir, dtag) {
        Ok(p) => p,
        // TS `logger.warn` and returns `[]` for malformed input — match that.
        Err(_) => return Ok(Vec::new()),
    };
    let Some(parsed) = parsed else {
        return Ok(Vec::new());
    };
    let Some(tags) = parsed.get("tags").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for tag in tags {
        let Some(arr) = tag.as_array() else { continue };
        if arr.first().and_then(Value::as_str) != Some("p") {
            continue;
        }
        let Some(value) = arr.get(1).and_then(Value::as_str) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if seen.insert(value.to_owned()) {
            out.push(value.to_owned());
        }
    }
    Ok(out)
}

/// List every project dTag that has an `event.json` on disk. Matches
/// `listProjectDTagsOnDisk` (`ProjectMembersReader.ts:71-93`).
pub fn list_project_dtags_on_disk(base_dir: &std::path::Path) -> Result<Vec<String>> {
    let base = projects_base_path(base_dir);
    let entries = match std::fs::read_dir(&base) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(anyhow::Error::new(e)
                .context(format!("read {}", base.display())))
        }
    };

    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let ft = entry.file_type()?;
        if !ft.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let event_p = entry.path().join(EVENT_FILENAME);
        if event_p.exists() {
            out.push(name);
        }
    }
    Ok(out)
}

/// Reverse lookup: every dTag whose persisted event lists `pubkey` as a
/// `p`-tag. Matches `listProjectsForAgent` (`ProjectMembersReader.ts:98-108`).
pub fn list_projects_for_agent(
    base_dir: &std::path::Path,
    pubkey: &str,
) -> Result<Vec<String>> {
    let dtags = list_project_dtags_on_disk(base_dir)?;
    let mut matches = Vec::new();
    for dtag in dtags {
        let pubkeys = read_project_agent_pubkeys(base_dir, &dtag)?;
        if pubkeys.iter().any(|p| p == pubkey) {
            matches.push(dtag);
        }
    }
    Ok(matches)
}

/// Collect every agent pubkey across every project on disk. Matches
/// `collectAllProjectAgentPubkeys` (`ProjectMembersReader.ts:113-123`).
pub fn collect_all_project_agent_pubkeys(
    base_dir: &std::path::Path,
) -> Result<std::collections::HashSet<String>> {
    let dtags = list_project_dtags_on_disk(base_dir)?;
    let mut all = std::collections::HashSet::new();
    for dtag in dtags {
        for p in read_project_agent_pubkeys(base_dir, &dtag)? {
            all.insert(p);
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-projmembers-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_event(base: &std::path::Path, dtag: &str, json: &str) {
        let dir = projects_base_path(base).join(dtag);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(EVENT_FILENAME), json).unwrap();
    }

    #[test]
    fn missing_projects_dir_returns_empty() {
        let base = unique_temp();
        assert!(list_project_dtags_on_disk(&base).unwrap().is_empty());
        assert!(read_project_agent_pubkeys(&base, "any").unwrap().is_empty());
        assert!(collect_all_project_agent_pubkeys(&base)
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_project_dtags_skips_dirs_without_event_json() {
        let base = unique_temp();
        write_event(&base, "p1", r#"{"tags":[]}"#);
        let p2 = projects_base_path(&base).join("p2");
        std::fs::create_dir_all(&p2).unwrap();
        let mut got = list_project_dtags_on_disk(&base).unwrap();
        got.sort();
        assert_eq!(got, vec!["p1".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_project_agent_pubkeys_extracts_p_tags() {
        let base = unique_temp();
        write_event(
            &base,
            "alpha",
            r#"{"tags":[
                ["d","alpha"],
                ["p","aaaa"],
                ["p","bbbb"],
                ["title","Alpha"]
            ]}"#,
        );
        let pubkeys = read_project_agent_pubkeys(&base, "alpha").unwrap();
        assert_eq!(pubkeys, vec!["aaaa".to_string(), "bbbb".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_project_agent_pubkeys_dedupes_preserving_order() {
        let base = unique_temp();
        write_event(
            &base,
            "dupes",
            r#"{"tags":[["p","a"],["p","b"],["p","a"]]}"#,
        );
        let pubkeys = read_project_agent_pubkeys(&base, "dupes").unwrap();
        assert_eq!(pubkeys, vec!["a".to_string(), "b".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_project_agent_pubkeys_skips_malformed_p_tags() {
        let base = unique_temp();
        write_event(
            &base,
            "bad",
            r#"{"tags":[["p"],["p",""],["p",42],["p","ok"]]}"#,
        );
        let pubkeys = read_project_agent_pubkeys(&base, "bad").unwrap();
        assert_eq!(pubkeys, vec!["ok".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_project_agent_pubkeys_returns_empty_on_malformed_json() {
        let base = unique_temp();
        write_event(&base, "broken", "not-json");
        // TS swallows parse errors and returns []; we mirror that.
        assert_eq!(
            read_project_agent_pubkeys(&base, "broken").unwrap(),
            Vec::<String>::new()
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_project_agent_pubkeys_returns_empty_when_tags_missing() {
        let base = unique_temp();
        write_event(&base, "no-tags", r#"{}"#);
        assert!(read_project_agent_pubkeys(&base, "no-tags").unwrap().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_projects_for_agent_finds_membership() {
        let base = unique_temp();
        write_event(&base, "p1", r#"{"tags":[["p","alice"],["p","bob"]]}"#);
        write_event(&base, "p2", r#"{"tags":[["p","bob"]]}"#);
        write_event(&base, "p3", r#"{"tags":[["p","carol"]]}"#);

        let mut bob_projects = list_projects_for_agent(&base, "bob").unwrap();
        bob_projects.sort();
        assert_eq!(bob_projects, vec!["p1".to_string(), "p2".to_string()]);

        let alice = list_projects_for_agent(&base, "alice").unwrap();
        assert_eq!(alice, vec!["p1".to_string()]);

        let dave = list_projects_for_agent(&base, "dave").unwrap();
        assert!(dave.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn collect_all_project_agent_pubkeys_unions_across_projects() {
        let base = unique_temp();
        write_event(&base, "p1", r#"{"tags":[["p","alice"],["p","bob"]]}"#);
        write_event(&base, "p2", r#"{"tags":[["p","bob"],["p","carol"]]}"#);
        let all = collect_all_project_agent_pubkeys(&base).unwrap();
        let expected: std::collections::HashSet<String> =
            ["alice", "bob", "carol"].iter().map(|s| s.to_string()).collect();
        assert_eq!(all, expected);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_persisted_project_event_returns_none_for_missing() {
        let base = unique_temp();
        std::fs::create_dir_all(projects_base_path(&base).join("ghost")).unwrap();
        assert!(read_persisted_project_event(&base, "ghost").unwrap().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn real_user_project_events_parse() {
        // Brutal-verify pin: every real persisted event.json under
        // ~/.tenex/projects/ must parse and yield ≥0 p-tags. Skip silently
        // when absent.
        let real = std::env::var("HOME")
            .ok()
            .map(std::path::PathBuf::from);
        let Some(home) = real else { return };
        if !home.join(".tenex/projects").exists() {
            return;
        }
        let dtags = list_project_dtags_on_disk(&home.join(".tenex")).unwrap();
        for dtag in &dtags {
            let pubkeys = read_project_agent_pubkeys(&home.join(".tenex"), dtag)
                .unwrap_or_else(|e| panic!("real {dtag} failed: {e}"));
            // Sanity: pubkeys are 64-char hex when present.
            for p in &pubkeys {
                assert!(
                    p.len() == 64 && p.chars().all(|c| c.is_ascii_hexdigit()),
                    "p-tag value not 64-hex on real project {dtag}: {p}"
                );
            }
        }
        eprintln!(
            "real_user_project_events_parse: scanned {} real project(s)",
            dtags.len()
        );
    }
}

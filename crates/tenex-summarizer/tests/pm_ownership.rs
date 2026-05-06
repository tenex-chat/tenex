//! `source::pm_identity` resolves the PM agent for a project and tells
//! us whether this backend can sign for it. The summarizer uses it to
//! decide whether to (a) run the LLM pass and publish kind:513s itself,
//! or (b) drop into ingest-only mode and trust events authored by the
//! known PM pubkey from another backend.

use std::fs;

use serde_json::json;
use tempfile::tempdir;
use tenex_summarizer::source;

fn write_project_event(base: &std::path::Path, d_tag: &str, p_tags: &[&str]) {
    let project_dir = base.join("projects").join(d_tag);
    fs::create_dir_all(&project_dir).unwrap();
    let mut tags: Vec<Vec<String>> = vec![vec!["d".into(), d_tag.into()]];
    for pk in p_tags {
        tags.push(vec!["p".into(), (*pk).into()]);
    }
    let event = json!({
        "id": "rooteventid",
        "pubkey": "0".repeat(64),
        "kind": 31933,
        "created_at": 1_700_000_000,
        "tags": tags,
        "content": "",
    });
    fs::write(
        project_dir.join("event.json"),
        serde_json::to_vec_pretty(&event).unwrap(),
    )
    .unwrap();
}

fn write_agent(base: &std::path::Path, pubkey: &str, with_nsec: bool) {
    let agents_dir = base.join("agents");
    fs::create_dir_all(&agents_dir).unwrap();
    let body = if with_nsec {
        json!({
            "slug": "pm",
            "name": "PM",
            "nsec": "nsec125v964gu6u6ncqdkczwjq7pdtu0adj03sjfcm3lsj67ljk7v2hrsr2juay",
        })
    } else {
        json!({
            "slug": "pm",
            "name": "PM",
        })
    };
    fs::write(
        agents_dir.join(format!("{pubkey}.json")),
        serde_json::to_vec_pretty(&body).unwrap(),
    )
    .unwrap();
}

#[test]
fn resolves_pm_pubkey_and_local_signer_when_pm_is_local() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    let other = "2".repeat(64);
    write_project_event(tmp.path(), "Project-A", &[&pm, &other]);
    write_agent(tmp.path(), &pm, true);

    let id = source::pm_identity("Project-A", tmp.path())
        .unwrap()
        .expect("pm identity present");
    assert_eq!(id.pubkey, pm);
    assert!(id.local_signer.is_some());
}

#[test]
fn resolves_pm_pubkey_with_no_signer_when_pm_file_is_missing() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    write_project_event(tmp.path(), "Project-B", &[&pm]);
    // No agent file written — PM lives on a remote backend.

    let id = source::pm_identity("Project-B", tmp.path())
        .unwrap()
        .expect("pm identity present");
    assert_eq!(id.pubkey, pm);
    assert!(id.local_signer.is_none());
}

#[test]
fn resolves_pm_pubkey_with_no_signer_when_pm_file_has_no_signer_ref() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    write_project_event(tmp.path(), "Project-C", &[&pm]);
    write_agent(tmp.path(), &pm, false);

    let id = source::pm_identity("Project-C", tmp.path())
        .unwrap()
        .expect("pm identity present");
    assert_eq!(id.pubkey, pm);
    assert!(id.local_signer.is_none());
}

#[test]
fn returns_none_when_project_event_lists_no_agents() {
    let tmp = tempdir().unwrap();
    write_project_event(tmp.path(), "Project-D", &[]);

    assert!(source::pm_identity("Project-D", tmp.path())
        .unwrap()
        .is_none());
}

#[test]
fn returns_none_when_project_event_file_is_missing() {
    let tmp = tempdir().unwrap();

    assert!(source::pm_identity("Project-F", tmp.path())
        .unwrap()
        .is_none());
}

#[test]
fn pm_pubkey_is_first_listed_agent_even_when_other_agents_are_local() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    let other = "2".repeat(64);
    write_project_event(tmp.path(), "Project-E", &[&pm, &other]);
    // We have a local signer for the second agent, but the PM lives on
    // another backend — local_signer must be None so we ingest rather
    // than publish.
    write_agent(tmp.path(), &other, true);

    let id = source::pm_identity("Project-E", tmp.path())
        .unwrap()
        .expect("pm identity present");
    assert_eq!(id.pubkey, pm);
    assert!(id.local_signer.is_none());
}

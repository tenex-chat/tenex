//! `source::pm_owned_locally` predicate. The summarizer uses it to gate
//! kind:513 publishes when several backends share the same project.

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
            "nsec": "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsm0lzze",
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
fn returns_true_when_pm_agent_has_local_signer() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    let other = "2".repeat(64);
    write_project_event(tmp.path(), "Project-A", &[&pm, &other]);
    write_agent(tmp.path(), &pm, true);

    assert!(source::pm_owned_locally("Project-A", tmp.path()).unwrap());
}

#[test]
fn returns_false_when_pm_agent_file_is_missing() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    write_project_event(tmp.path(), "Project-B", &[&pm]);
    // No agent file written — PM lives on a remote backend.

    assert!(!source::pm_owned_locally("Project-B", tmp.path()).unwrap());
}

#[test]
fn returns_false_when_pm_agent_file_has_no_signer() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    write_project_event(tmp.path(), "Project-C", &[&pm]);
    write_agent(tmp.path(), &pm, false);

    assert!(!source::pm_owned_locally("Project-C", tmp.path()).unwrap());
}

#[test]
fn returns_false_when_project_event_lists_no_agents() {
    let tmp = tempdir().unwrap();
    write_project_event(tmp.path(), "Project-D", &[]);

    assert!(!source::pm_owned_locally("Project-D", tmp.path()).unwrap());
}

#[test]
fn returns_false_when_project_event_file_is_missing() {
    // No `event.json` written at all — the project directory simply does not
    // exist on this backend. `tenex_project::Project::member_pubkeys` treats a
    // missing event file as "no members", so PM ownership resolves cleanly to
    // `false` rather than bubbling up a read error and skipping the project.
    let tmp = tempdir().unwrap();

    assert!(!source::pm_owned_locally("Project-F", tmp.path()).unwrap());
}

#[test]
fn returns_false_when_only_non_pm_agent_is_local() {
    let tmp = tempdir().unwrap();
    let pm = "1".repeat(64);
    let other = "2".repeat(64);
    write_project_event(tmp.path(), "Project-E", &[&pm, &other]);
    // We have a local signer for the second agent, but the PM lives on
    // another backend — we must not publish kind:513s for this project.
    write_agent(tmp.path(), &other, true);

    assert!(!source::pm_owned_locally("Project-E", tmp.path()).unwrap());
}

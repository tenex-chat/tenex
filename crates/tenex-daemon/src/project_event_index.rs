use std::collections::BTreeMap;

use crate::nostr_classification::KIND_PROJECT;
use crate::nostr_event::SignedNostrEvent;
use crate::project_status_descriptors::{
    ProjectStatusDescriptor, ProjectStatusDescriptorReport,
};

/// In-memory index of kind 31933 project events, keyed by
/// `(owner_pubkey, d_tag)`. The daemon owns one instance at the top of its
/// runtime and every subsystem that needs to know which projects exist reads
/// a snapshot of this index — there is no on-disk `project.json`.
///
/// Newer `created_at` wins per coordinate: if a relay replays an older
/// revision of a 31933 event after a newer one has been ingested, the older
/// one is discarded. Deletions (kind 5) are intentionally not handled here;
/// current ingress code does not honour them either, and adding that would
/// belong alongside the rest of kind 5 handling.
#[derive(Debug, Clone, Default)]
pub struct ProjectEventIndex {
    entries: BTreeMap<(String, String), SignedNostrEvent>,
}

impl ProjectEventIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inserts the 31933 event if nothing is stored for the coordinate or if
    /// the stored revision is older than `event.created_at`. Returns `true`
    /// when the index changed.
    pub fn upsert(&mut self, event: SignedNostrEvent) -> bool {
        if event.kind != KIND_PROJECT {
            return false;
        }
        let Some(d_tag) = tag_value(&event, "d") else {
            return false;
        };
        let key = (event.pubkey.clone(), d_tag.to_string());
        match self.entries.get(&key) {
            Some(existing) if existing.created_at >= event.created_at => false,
            _ => {
                self.entries.insert(key, event);
                true
            }
        }
    }

    pub fn get(&self, owner_pubkey: &str, d_tag: &str) -> Option<&SignedNostrEvent> {
        self.entries
            .get(&(owner_pubkey.to_string(), d_tag.to_string()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Projects every indexed 31933 event into the descriptor struct that the
    /// rest of the daemon consumes. Replaces the old filesystem scan in
    /// `read_project_status_descriptors`.
    pub fn descriptors_report(&self) -> ProjectStatusDescriptorReport {
        let descriptors = self
            .entries
            .values()
            .map(project_status_descriptor_from_event)
            .collect();
        ProjectStatusDescriptorReport {
            descriptors,
            skipped_files: Vec::new(),
        }
    }
}

fn project_status_descriptor_from_event(event: &SignedNostrEvent) -> ProjectStatusDescriptor {
    let project_d_tag = tag_value(event, "d").unwrap_or("").to_string();
    let project_manager_pubkey = tag_value(event, "p").map(str::to_string);
    ProjectStatusDescriptor {
        project_owner_pubkey: event.pubkey.clone(),
        project_d_tag,
        project_manager_pubkey,
        project_base_path: None,
        worktrees: Vec::new(),
    }
}

fn tag_value<'a>(event: &'a SignedNostrEvent, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_event(
        id: &str,
        pubkey: &str,
        d_tag: &str,
        created_at: u64,
        p_tags: &[&str],
    ) -> SignedNostrEvent {
        let mut tags = vec![vec!["d".to_string(), d_tag.to_string()]];
        for p in p_tags {
            tags.push(vec!["p".to_string(), p.to_string()]);
        }
        SignedNostrEvent {
            id: id.to_string(),
            pubkey: pubkey.to_string(),
            created_at,
            kind: KIND_PROJECT,
            tags,
            content: String::new(),
            sig: "b".repeat(128),
        }
    }

    #[test]
    fn new_index_is_empty() {
        let index = ProjectEventIndex::new();
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
        assert!(index.descriptors_report().descriptors.is_empty());
    }

    #[test]
    fn upsert_inserts_first_event_and_projects_descriptor() {
        let mut index = ProjectEventIndex::new();
        let owner = "a".repeat(64);
        let manager = "c".repeat(64);
        let event = project_event("event-one", &owner, "demo", 1_000, &[&manager]);

        assert!(index.upsert(event));
        assert_eq!(index.len(), 1);

        let report = index.descriptors_report();
        assert_eq!(report.descriptors.len(), 1);
        let d = &report.descriptors[0];
        assert_eq!(d.project_owner_pubkey, owner);
        assert_eq!(d.project_d_tag, "demo");
        assert_eq!(d.project_manager_pubkey.as_deref(), Some(manager.as_str()));
    }

    #[test]
    fn upsert_replaces_when_created_at_is_newer() {
        let mut index = ProjectEventIndex::new();
        let owner = "a".repeat(64);
        assert!(index.upsert(project_event("old", &owner, "demo", 1_000, &[])));
        assert!(index.upsert(project_event("new", &owner, "demo", 2_000, &[])));
        assert_eq!(index.get(&owner, "demo").unwrap().id, "new");
    }

    #[test]
    fn upsert_ignores_older_or_equal_revisions() {
        let mut index = ProjectEventIndex::new();
        let owner = "a".repeat(64);
        assert!(index.upsert(project_event("latest", &owner, "demo", 2_000, &[])));
        assert!(!index.upsert(project_event("older", &owner, "demo", 1_000, &[])));
        assert!(!index.upsert(project_event("same", &owner, "demo", 2_000, &[])));
        assert_eq!(index.get(&owner, "demo").unwrap().id, "latest");
    }

    #[test]
    fn upsert_rejects_non_project_kinds() {
        let mut index = ProjectEventIndex::new();
        let mut event = project_event("x", &"a".repeat(64), "demo", 1_000, &[]);
        event.kind = 1;
        assert!(!index.upsert(event));
        assert!(index.is_empty());
    }

    #[test]
    fn upsert_rejects_events_without_d_tag() {
        let mut index = ProjectEventIndex::new();
        let mut event = project_event("x", &"a".repeat(64), "demo", 1_000, &[]);
        event.tags.clear();
        assert!(!index.upsert(event));
        assert!(index.is_empty());
    }

    #[test]
    fn descriptors_report_sorts_by_coordinate() {
        let mut index = ProjectEventIndex::new();
        let owner_a = "a".repeat(64);
        let owner_b = "b".repeat(64);
        index.upsert(project_event("1", &owner_b, "zeta", 1_000, &[]));
        index.upsert(project_event("2", &owner_a, "alpha", 1_000, &[]));
        index.upsert(project_event("3", &owner_a, "beta", 1_000, &[]));

        let descriptors = index.descriptors_report().descriptors;
        let coords: Vec<_> = descriptors
            .iter()
            .map(|d| (d.project_owner_pubkey.clone(), d.project_d_tag.clone()))
            .collect();
        assert_eq!(
            coords,
            vec![
                (owner_a.clone(), "alpha".to_string()),
                (owner_a, "beta".to_string()),
                (owner_b, "zeta".to_string()),
            ]
        );
    }

    #[test]
    fn manager_pubkey_is_first_p_tag() {
        let mut index = ProjectEventIndex::new();
        let owner = "a".repeat(64);
        let manager = "c".repeat(64);
        let agent = "d".repeat(64);
        index.upsert(project_event("1", &owner, "demo", 1, &[&manager, &agent]));

        let descriptor = &index.descriptors_report().descriptors[0];
        assert_eq!(
            descriptor.project_manager_pubkey.as_deref(),
            Some(manager.as_str())
        );
    }
}

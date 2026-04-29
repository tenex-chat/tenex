//! Pure mutation logic for kind:31933 NDKProject events.
//!
//! Mirrors `ProjectEventPublishService.applyMutation`
//! (`src/services/projects/ProjectEventPublishService.ts:248-365`) verbatim.
//!
//! No I/O, no signing, no publishing. Takes the base event's `tags` +
//! `content` and a [`PublishProjectMutationParams`], returns the
//! mutated tags+content plus an audit trail (added/removed/updated/skipped).
//!
//! The publish pipeline that consumes this output:
//!
//! 1. fetch latest persisted kind:31933 event (already ported in
//!    `crate::store::project_members::read_persisted_project_event`)
//! 2. call [`apply_mutation`]
//! 3. sign with the project owner's nsec
//! 4. publish the new event
//!
//! Step 2 is exhaustively unit-testable in isolation, which is what this
//! module enables.

/// Metadata fields that `applyMutation` knows how to update. Mirrors
/// `ProjectMetadataKey` (`ProjectEventPublishService.ts:9`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataKey {
    Title,
    Repo,
    Image,
    Description,
}

impl MetadataKey {
    /// String form used in skip-messages — matches the TS string literal
    /// that gets interpolated into `${metadataKey} unchanged` /
    /// `${metadataKey} already cleared`. Verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            MetadataKey::Title => "title",
            MetadataKey::Repo => "repo",
            MetadataKey::Image => "image",
            MetadataKey::Description => "description",
        }
    }
}

/// Mutation parameters. Mirrors the TS `PublishProjectMutationParams`
/// shape at `:17-25`.
///
/// `set_*` fields use three-state semantics:
/// - `None` — field not provided (no change)
/// - `Some(String::new())` — clear the field (drop the tag, or empty content)
/// - `Some("foo")` — set to `"foo"`
///
/// This matches TS's `params.set?.[metadataKey]` access where `undefined`
/// = absent and `""` = explicit clear.
#[derive(Debug, Clone, Default)]
pub struct PublishProjectMutationParams {
    pub owner_pubkey: String,
    pub project_dtag: String,
    pub add_agent_pubkeys: Vec<String>,
    pub remove_agent_pubkeys: Vec<String>,
    /// When non-empty, **set semantics**: any `p` tag whose value is not
    /// in this list is removed (in addition to any `remove_agent_pubkeys`
    /// not already present).
    pub retain_agent_pubkeys: Vec<String>,
    pub set_title: Option<String>,
    pub set_repo: Option<String>,
    pub set_image: Option<String>,
    pub set_description: Option<String>,
}

/// Output of `applyMutation`. Mirrors `AppliedProjectMutation` (`:46-54`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedProjectMutation {
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub added_pubkeys: Vec<String>,
    pub removed_pubkeys: Vec<String>,
    pub updated_fields: Vec<MetadataKey>,
    pub skipped: Vec<String>,
    pub has_changes: bool,
}

/// `uniqueOrdered` (`:56-58`): trim, drop empty, dedupe preserving first
/// occurrence (TS `new Set(…)` preserves insertion order).
fn unique_ordered(values: &[String]) -> Vec<String> {
    let mut seen: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for v in values {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            continue;
        }
        seen.insert(trimmed.to_string());
    }
    seen.into_iter().collect()
}

fn get_first_tag_value<'a>(tags: &'a [Vec<String>], tag_name: &str) -> Option<&'a str> {
    for tag in tags {
        if tag.first().map(String::as_str) == Some(tag_name) {
            return tag.get(1).map(String::as_str);
        }
    }
    None
}

/// `applyMutation` (`:248-365`).
///
/// The order of operations matters and is preserved verbatim:
///
/// 1. **Retain filter** (`:268-285`) — when `retain_agent_pubkeys` is
///    non-empty, drop every `p` tag whose value isn't in the retain set;
///    track each unique drop in `removed_pubkeys`.
/// 2. **Explicit removes** (`:287-300`) — for each `remove_agent_pubkeys`
///    entry not already removed: drop matching `p` tags, or push
///    `"agent <pubkey> already absent"` to `skipped`.
/// 3. **Explicit adds** (`:302-310`) — for each `add_agent_pubkeys` entry
///    not already present: append `["p", <pubkey>]`, or push
///    `"agent <pubkey> already present"` to `skipped`.
/// 4. **Tag fields** (`:312-341`) — title/repo/image; replaces or clears
///    the existing tag. Skip messages: `<key> unchanged`, `<key> already
///    cleared`.
/// 5. **Description** (`:343-350`) — sets/replaces `content`. Skip message:
///    `description unchanged` (note: no key prefix unlike tag fields).
///
/// `has_changes` is `true` iff any of `added_pubkeys`, `removed_pubkeys`,
/// `updated_fields` is non-empty (`:359-363`).
pub fn apply_mutation(
    base_tags: &[Vec<String>],
    base_content: &str,
    params: &PublishProjectMutationParams,
) -> AppliedProjectMutation {
    let mut tags: Vec<Vec<String>> = base_tags.to_vec();
    let mut content = base_content.to_owned();

    let mut added_pubkeys: Vec<String> = Vec::new();
    let mut removed_pubkeys: Vec<String> = Vec::new();
    let mut updated_fields: Vec<MetadataKey> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    let mut removed_set: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let add_agent_pubkeys = unique_ordered(&params.add_agent_pubkeys);
    let remove_agent_pubkeys = unique_ordered(&params.remove_agent_pubkeys);
    let retain_agent_pubkeys = unique_ordered(&params.retain_agent_pubkeys);

    // ── 1. Retain filter ──────────────────────────────────────────────
    if !retain_agent_pubkeys.is_empty() {
        let retain_set: indexmap::IndexSet<&String> = retain_agent_pubkeys.iter().collect();
        let mut filtered: Vec<Vec<String>> = Vec::with_capacity(tags.len());
        for tag in tags.into_iter() {
            // Keep non-`p` tags, `p` tags missing a value, and `p` tags
            // whose pubkey is in the retain set. Mirrors `tag[0] !== "p"
            // || !tag[1] || retainSet.has(tag[1])` at `:273`.
            let is_p = tag.first().map(String::as_str) == Some("p");
            let value = tag.get(1).cloned().unwrap_or_default();
            if !is_p || value.is_empty() || retain_set.contains(&value) {
                filtered.push(tag);
                continue;
            }
            if !removed_set.contains(&value) {
                removed_set.insert(value.clone());
                removed_pubkeys.push(value);
            }
            // The tag is dropped (not pushed to `filtered`).
        }
        tags = filtered;
    }

    let has_agent_tag = |tags: &[Vec<String>], pubkey: &str| -> bool {
        tags.iter().any(|tag| {
            tag.first().map(String::as_str) == Some("p")
                && tag.get(1).map(String::as_str) == Some(pubkey)
        })
    };

    // ── 2. Explicit removes ───────────────────────────────────────────
    for pubkey in &remove_agent_pubkeys {
        if removed_set.contains(pubkey) {
            continue;
        }
        if !has_agent_tag(&tags, pubkey) {
            skipped.push(format!("agent {pubkey} already absent"));
            continue;
        }
        tags.retain(|tag| {
            !(tag.first().map(String::as_str) == Some("p")
                && tag.get(1).map(String::as_str) == Some(pubkey))
        });
        removed_set.insert(pubkey.clone());
        removed_pubkeys.push(pubkey.clone());
    }

    // ── 3. Explicit adds ──────────────────────────────────────────────
    for pubkey in &add_agent_pubkeys {
        if has_agent_tag(&tags, pubkey) {
            skipped.push(format!("agent {pubkey} already present"));
            continue;
        }
        tags.push(vec!["p".to_string(), pubkey.clone()]);
        added_pubkeys.push(pubkey.clone());
    }

    // ── 4. Tag fields (title / repo / image) ──────────────────────────
    apply_tag_field(
        &mut tags,
        &mut updated_fields,
        &mut skipped,
        MetadataKey::Title,
        "title",
        params.set_title.as_deref(),
    );
    apply_tag_field(
        &mut tags,
        &mut updated_fields,
        &mut skipped,
        MetadataKey::Repo,
        "repo",
        params.set_repo.as_deref(),
    );
    apply_tag_field(
        &mut tags,
        &mut updated_fields,
        &mut skipped,
        MetadataKey::Image,
        "picture",
        params.set_image.as_deref(),
    );

    // ── 5. Description (content) ──────────────────────────────────────
    if let Some(next_description) = params.set_description.as_deref() {
        if content == next_description {
            skipped.push("description unchanged".to_string());
        } else {
            content = next_description.to_string();
            updated_fields.push(MetadataKey::Description);
        }
    }

    let has_changes =
        !added_pubkeys.is_empty() || !removed_pubkeys.is_empty() || !updated_fields.is_empty();

    AppliedProjectMutation {
        tags,
        content,
        added_pubkeys,
        removed_pubkeys,
        updated_fields,
        skipped,
        has_changes,
    }
}

/// `applyTagField` (`:312-337`). Note the asymmetry in the tag name: the
/// `image` metadata key maps to the `picture` Nostr tag (NIP-78
/// convention). title/repo map to identically-named tags.
fn apply_tag_field(
    tags: &mut Vec<Vec<String>>,
    updated_fields: &mut Vec<MetadataKey>,
    skipped: &mut Vec<String>,
    metadata_key: MetadataKey,
    tag_name: &str,
    next_value: Option<&str>,
) {
    let Some(next_value) = next_value else {
        return;
    };
    let current_value = get_first_tag_value(tags, tag_name);

    if current_value.unwrap_or("") == next_value {
        skipped.push(format!("{} unchanged", metadata_key.as_str()));
        return;
    }
    if next_value.is_empty() && current_value.is_none() {
        skipped.push(format!("{} already cleared", metadata_key.as_str()));
        return;
    }

    tags.retain(|tag| tag.first().map(String::as_str) != Some(tag_name));
    if !next_value.is_empty() {
        tags.push(vec![tag_name.to_string(), next_value.to_string()]);
    }
    updated_fields.push(metadata_key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(name: &str, value: &str) -> Vec<String> {
        vec![name.to_string(), value.to_string()]
    }

    fn dtag(value: &str) -> Vec<Vec<String>> {
        vec![tag("d", value)]
    }

    fn empty_params() -> PublishProjectMutationParams {
        PublishProjectMutationParams {
            owner_pubkey: "owner".into(),
            project_dtag: "P1".into(),
            ..Default::default()
        }
    }

    // ── unique_ordered ──────────────────────────────────────────────────

    #[test]
    fn unique_ordered_trims_and_drops_empty() {
        let v = unique_ordered(&["  alice  ".into(), "".into(), "   ".into(), "bob".into()]);
        assert_eq!(v, vec!["alice".to_string(), "bob".to_string()]);
    }

    #[test]
    fn unique_ordered_dedupes_preserving_first_occurrence() {
        let v = unique_ordered(&[
            "alice".into(),
            "bob".into(),
            "alice".into(),
            "carol".into(),
            "bob".into(),
        ]);
        assert_eq!(
            v,
            vec!["alice".to_string(), "bob".to_string(), "carol".to_string()]
        );
    }

    // ── add agent ────────────────────────────────────────────────────────

    #[test]
    fn add_agent_appends_p_tag() {
        let mut params = empty_params();
        params.add_agent_pubkeys = vec!["alice".into()];
        let result = apply_mutation(&dtag("P1"), "", &params);
        assert!(result.has_changes);
        assert_eq!(result.added_pubkeys, vec!["alice".to_string()]);
        assert_eq!(result.tags.last().unwrap(), &tag("p", "alice"));
        assert!(result.skipped.is_empty());
    }

    #[test]
    fn add_agent_already_present_records_skip_message() {
        let mut params = empty_params();
        params.add_agent_pubkeys = vec!["alice".into()];
        let mut base = dtag("P1");
        base.push(tag("p", "alice"));
        let result = apply_mutation(&base, "", &params);
        assert!(!result.has_changes);
        assert!(result.added_pubkeys.is_empty());
        assert_eq!(
            result.skipped,
            vec!["agent alice already present".to_string()]
        );
    }

    // ── remove agent ─────────────────────────────────────────────────────

    #[test]
    fn remove_agent_drops_p_tag() {
        let mut params = empty_params();
        params.remove_agent_pubkeys = vec!["alice".into()];
        let mut base = dtag("P1");
        base.push(tag("p", "alice"));
        base.push(tag("p", "bob"));
        let result = apply_mutation(&base, "", &params);
        assert_eq!(result.removed_pubkeys, vec!["alice".to_string()]);
        // bob remains; alice is gone; d tag retained.
        assert!(result.tags.contains(&tag("p", "bob")));
        assert!(!result.tags.contains(&tag("p", "alice")));
    }

    #[test]
    fn remove_agent_already_absent_records_skip_message() {
        let mut params = empty_params();
        params.remove_agent_pubkeys = vec!["alice".into()];
        let result = apply_mutation(&dtag("P1"), "", &params);
        assert!(!result.has_changes);
        assert!(result.removed_pubkeys.is_empty());
        assert_eq!(
            result.skipped,
            vec!["agent alice already absent".to_string()]
        );
    }

    // ── retain filter ────────────────────────────────────────────────────

    #[test]
    fn retain_filter_drops_p_tags_not_in_retain_set() {
        let mut params = empty_params();
        params.retain_agent_pubkeys = vec!["alice".into()];
        let mut base = dtag("P1");
        base.push(tag("p", "alice"));
        base.push(tag("p", "bob"));
        base.push(tag("p", "carol"));
        let result = apply_mutation(&base, "", &params);
        // bob + carol removed; alice retained.
        let mut sorted_removed = result.removed_pubkeys.clone();
        sorted_removed.sort();
        assert_eq!(sorted_removed, vec!["bob".to_string(), "carol".to_string()]);
        assert!(result.tags.contains(&tag("p", "alice")));
        assert!(!result.tags.contains(&tag("p", "bob")));
        assert!(result.has_changes);
    }

    #[test]
    fn retain_filter_preserves_non_p_tags() {
        let mut params = empty_params();
        params.retain_agent_pubkeys = vec!["alice".into()];
        let mut base = dtag("P1");
        base.push(tag("title", "My Project"));
        base.push(tag("p", "alice"));
        base.push(tag("p", "bob"));
        base.push(tag("repo", "https://example.com/repo"));
        let result = apply_mutation(&base, "", &params);
        assert!(result.tags.contains(&tag("title", "My Project")));
        assert!(result
            .tags
            .contains(&tag("repo", "https://example.com/repo")));
        assert!(result.tags.contains(&tag("p", "alice")));
    }

    #[test]
    fn retain_then_remove_does_not_double_count() {
        // bob already evicted by retain — explicit remove must skip it.
        let mut params = empty_params();
        params.retain_agent_pubkeys = vec!["alice".into()];
        params.remove_agent_pubkeys = vec!["bob".into()];
        let mut base = dtag("P1");
        base.push(tag("p", "alice"));
        base.push(tag("p", "bob"));
        let result = apply_mutation(&base, "", &params);
        // bob appears in removed_pubkeys exactly once (from retain pass).
        assert_eq!(result.removed_pubkeys, vec!["bob".to_string()]);
    }

    // ── tag fields (title/repo/image=picture) ────────────────────────────

    #[test]
    fn set_title_replaces_existing_title_tag() {
        let mut params = empty_params();
        params.set_title = Some("New Title".into());
        let mut base = dtag("P1");
        base.push(tag("title", "Old Title"));
        let result = apply_mutation(&base, "", &params);
        assert!(result.has_changes);
        assert_eq!(result.updated_fields, vec![MetadataKey::Title]);
        assert!(result.tags.contains(&tag("title", "New Title")));
        assert!(!result.tags.contains(&tag("title", "Old Title")));
    }

    #[test]
    fn set_image_maps_to_picture_tag() {
        // Source: `:341` — `applyTagField("image", "picture")`.
        let mut params = empty_params();
        params.set_image = Some("https://example.com/img.png".into());
        let result = apply_mutation(&dtag("P1"), "", &params);
        assert!(result
            .tags
            .contains(&tag("picture", "https://example.com/img.png")));
        assert_eq!(result.updated_fields, vec![MetadataKey::Image]);
    }

    #[test]
    fn set_field_unchanged_emits_skip_message() {
        let mut params = empty_params();
        params.set_title = Some("Same".into());
        let mut base = dtag("P1");
        base.push(tag("title", "Same"));
        let result = apply_mutation(&base, "", &params);
        assert!(!result.has_changes);
        assert_eq!(result.skipped, vec!["title unchanged".to_string()]);
    }

    #[test]
    fn set_field_to_empty_clears_existing_tag() {
        let mut params = empty_params();
        params.set_repo = Some(String::new());
        let mut base = dtag("P1");
        base.push(tag("repo", "old"));
        let result = apply_mutation(&base, "", &params);
        assert!(result.has_changes);
        assert!(!result
            .tags
            .iter()
            .any(|t| t.first().map(String::as_str) == Some("repo")));
        assert_eq!(result.updated_fields, vec![MetadataKey::Repo]);
    }

    #[test]
    fn set_field_to_empty_when_already_absent_emits_unchanged() {
        // The TS check `(currentValue ?? "") === nextValue` (`:322`) catches
        // the absent-and-empty case as "unchanged", which means the
        // "already cleared" branch (`:327`) is unreachable in practice.
        // We mirror this verbatim — the dead branch stays for source parity
        // but never fires.
        let mut params = empty_params();
        params.set_repo = Some(String::new());
        let result = apply_mutation(&dtag("P1"), "", &params);
        assert!(!result.has_changes);
        assert_eq!(result.skipped, vec!["repo unchanged".to_string()]);
    }

    // ── description (content) ────────────────────────────────────────────

    #[test]
    fn set_description_replaces_content() {
        let mut params = empty_params();
        params.set_description = Some("Brand new description.".into());
        let result = apply_mutation(&dtag("P1"), "Old description.", &params);
        assert_eq!(result.content, "Brand new description.");
        assert_eq!(result.updated_fields, vec![MetadataKey::Description]);
        assert!(result.has_changes);
    }

    #[test]
    fn set_description_unchanged_emits_bare_skip_message() {
        // Source: `:345` — emits "description unchanged" (no key prefix,
        // unlike tag fields). Verbatim string check.
        let mut params = empty_params();
        params.set_description = Some("Same".into());
        let result = apply_mutation(&dtag("P1"), "Same", &params);
        assert!(!result.has_changes);
        assert_eq!(result.skipped, vec!["description unchanged".to_string()]);
    }

    #[test]
    fn set_description_to_empty_clears_content() {
        let mut params = empty_params();
        params.set_description = Some(String::new());
        let result = apply_mutation(&dtag("P1"), "Some content", &params);
        assert_eq!(result.content, "");
        assert!(result.has_changes);
    }

    // ── combined ─────────────────────────────────────────────────────────

    #[test]
    fn full_mutation_combines_all_steps() {
        let mut params = empty_params();
        params.retain_agent_pubkeys = vec!["alice".into(), "bob".into()];
        params.add_agent_pubkeys = vec!["carol".into()];
        params.remove_agent_pubkeys = vec!["bob".into()];
        params.set_title = Some("New".into());
        params.set_description = Some("Desc".into());

        let mut base = dtag("P1");
        base.push(tag("title", "Old"));
        base.push(tag("p", "alice"));
        base.push(tag("p", "bob"));
        base.push(tag("p", "dave")); // evicted by retain

        let result = apply_mutation(&base, "", &params);
        assert!(result.has_changes);
        // dave removed via retain; bob removed via explicit remove (after retain).
        let mut sorted_removed = result.removed_pubkeys.clone();
        sorted_removed.sort();
        assert_eq!(sorted_removed, vec!["bob".to_string(), "dave".to_string()]);
        assert_eq!(result.added_pubkeys, vec!["carol".to_string()]);
        let mut updated = result.updated_fields.clone();
        updated.sort_by_key(|k| k.as_str());
        assert_eq!(updated, vec![MetadataKey::Description, MetadataKey::Title]);
    }

    #[test]
    fn no_params_no_changes() {
        let result = apply_mutation(&dtag("P1"), "", &empty_params());
        assert!(!result.has_changes);
        assert!(result.added_pubkeys.is_empty());
        assert!(result.removed_pubkeys.is_empty());
        assert!(result.updated_fields.is_empty());
        assert!(result.skipped.is_empty());
    }

    #[test]
    fn metadata_key_as_str_matches_ts_literals() {
        assert_eq!(MetadataKey::Title.as_str(), "title");
        assert_eq!(MetadataKey::Repo.as_str(), "repo");
        assert_eq!(MetadataKey::Image.as_str(), "image");
        assert_eq!(MetadataKey::Description.as_str(), "description");
    }
}

//! Project-ID normalization.
//!
//! Mirrors the rules in `src/types/project-ids.ts` (`tryExtractDTagFromAddress`)
//! and `src/services/scheduling/storage.ts` (`normalizeProjectIdForRuntime`):
//!
//! - NIP-33 coordinate: `<kind>:<authorPubkeyHex>:<dTag>` where the kind is
//!   `31933` and the pubkey is exactly 64 lowercase hex characters. Split on
//!   the first two colons; everything after the second colon is the dTag.
//! - Anything else is treated as a bare dTag (passed through verbatim).

use crate::error::{Error, Result};

const PROJECT_KIND: &str = "31933";

/// A normalized project dTag — the on-disk identifier used for paths.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProjectDTag(String);

impl ProjectDTag {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl AsRef<str> for ProjectDTag {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProjectDTag {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Accept either a NIP-33 coordinate or a bare dTag and return the dTag.
///
/// Matches the behaviour of the TS helpers exactly: a coordinate is recognized
/// only when it starts with `31933:` followed by 64 hex chars and a non-empty
/// dTag. Anything else is a dTag.
pub fn normalize_project_id(value: &str) -> Result<ProjectDTag> {
    if value.is_empty() {
        return Err(Error::InvalidProjectId("empty".into()));
    }

    if let Some(d_tag) = try_extract_d_tag(value) {
        if d_tag.is_empty() {
            return Err(Error::InvalidProjectId(value.into()));
        }
        return Ok(ProjectDTag(d_tag.to_string()));
    }

    // Bare dTag: must not look like a malformed coordinate. The TS code is
    // permissive (anything not matching the coordinate regex is a dTag), so we
    // mirror that.
    Ok(ProjectDTag(value.to_string()))
}

fn try_extract_d_tag(value: &str) -> Option<&str> {
    let mut parts = value.splitn(3, ':');
    let kind = parts.next()?;
    let pubkey = parts.next()?;
    let d_tag = parts.next()?;
    if kind != PROJECT_KIND {
        return None;
    }
    if pubkey.len() != 64
        || !pubkey
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    Some(d_tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";

    #[test]
    fn coordinate_yields_d_tag() {
        let d = normalize_project_id(&format!("31933:{HEX_PK}:my-project")).unwrap();
        assert_eq!(d.as_str(), "my-project");
    }

    #[test]
    fn bare_d_tag_passes_through() {
        let d = normalize_project_id("my-project").unwrap();
        assert_eq!(d.as_str(), "my-project");
    }

    #[test]
    fn d_tag_with_colons_passes_through() {
        // Not a 31933 coordinate -> treated as bare dTag.
        let d = normalize_project_id("foo:bar:baz").unwrap();
        assert_eq!(d.as_str(), "foo:bar:baz");
    }

    #[test]
    fn wrong_kind_is_bare_d_tag() {
        let value = format!("31000:{HEX_PK}:my-project");
        let d = normalize_project_id(&value).unwrap();
        assert_eq!(d.as_str(), value);
    }

    #[test]
    fn uppercase_hex_is_not_a_coordinate() {
        // The TS regex is `[0-9a-f]{64}` (lowercase only).
        let upper = HEX_PK.to_uppercase();
        let value = format!("31933:{upper}:my-project");
        let d = normalize_project_id(&value).unwrap();
        assert_eq!(d.as_str(), value);
    }

    #[test]
    fn empty_is_rejected() {
        assert!(normalize_project_id("").is_err());
    }

    #[test]
    fn coordinate_with_empty_d_tag_is_rejected() {
        let value = format!("31933:{HEX_PK}:");
        assert!(normalize_project_id(&value).is_err());
    }
}

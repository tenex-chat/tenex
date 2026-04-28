//! Project-id normalization at the API boundary.
//!
//! Mirrors the TS rules in `src/types/project-ids.ts` (`tryExtractDTagFromAddress`)
//! and `src/services/scheduling/storage.ts` (`normalizeProjectIdForRuntime`):
//!
//! - If the input matches `31933:<64-hex-pubkey>:<dTag>`, return everything
//!   after the second colon.
//! - Otherwise, return the input unchanged (treated as a bare dTag).

use crate::error::{ConversationsError, Result};

const PROJECT_ADDRESS_KIND: &str = "31933";

fn try_extract_dtag(value: &str) -> Option<&str> {
    let mut parts = value.splitn(3, ':');
    let kind = parts.next()?;
    let pubkey = parts.next()?;
    let d_tag = parts.next()?;
    if kind != PROJECT_ADDRESS_KIND {
        return None;
    }
    if pubkey.len() != 64 || !pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if d_tag.is_empty() {
        return None;
    }
    Some(d_tag)
}

/// Normalize a project id (either a bare dTag or a NIP-33 coordinate) to its dTag.
///
/// Returns an error only if the input is empty.
pub fn normalize_project_id(project_id: &str) -> Result<String> {
    if project_id.is_empty() {
        return Err(ConversationsError::InvalidProjectId(
            "project id is empty".to_string(),
        ));
    }
    Ok(try_extract_dtag(project_id)
        .map(str::to_owned)
        .unwrap_or_else(|| project_id.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_dtag_passthrough() {
        let id = normalize_project_id("my-project").unwrap();
        assert_eq!(id, "my-project");
    }

    #[test]
    fn nip33_coordinate_yields_dtag() {
        let pk = "a".repeat(64);
        let coord = format!("31933:{}:my-project", pk);
        assert_eq!(normalize_project_id(&coord).unwrap(), "my-project");
    }

    #[test]
    fn dtag_containing_colons_preserved() {
        let pk = "a".repeat(64);
        let coord = format!("31933:{}:weird:dtag:value", pk);
        assert_eq!(normalize_project_id(&coord).unwrap(), "weird:dtag:value");
    }

    #[test]
    fn malformed_returns_input_as_dtag() {
        // Looks like an address but pubkey is not 64-hex — treat as bare dTag.
        let weird = "31933:notapubkey:something";
        assert_eq!(normalize_project_id(weird).unwrap(), weird);
    }

    #[test]
    fn empty_rejected() {
        assert!(normalize_project_id("").is_err());
    }
}

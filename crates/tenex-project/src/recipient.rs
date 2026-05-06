//! Single source of truth for resolving a free-form recipient string to an
//! [`Agent`]. Accepted forms: exact slug, case-insensitive name, full hex
//! pubkey, or unique pubkey prefix (≥ 4 hex chars).
//!
//! Team resolution is deliberately out of scope — teams resolve to a team-lead
//! by name, which is a different mapping. Callers that need team handling
//! chain it after this function.

use crate::models::Agent;

/// Outcome of resolving a recipient string against the agent roster.
#[derive(Debug, PartialEq, Eq)]
pub enum RecipientResolution<'a> {
    /// Exactly one agent matched.
    Resolved(&'a Agent),
    /// No agent matched.
    NotFound,
    /// A pubkey prefix matched more than one agent. Callers should ask the
    /// user to disambiguate; the carried slice contains the candidates.
    Ambiguous(Vec<&'a Agent>),
}

const MIN_PUBKEY_PREFIX_LEN: usize = 4;

/// Resolve a recipient string against `agents`, in priority order:
///
/// 1. Exact slug
/// 2. Case-insensitive name
/// 3. Full hex pubkey (lowercased)
/// 4. Unique pubkey prefix of ≥ 4 hex chars
pub fn resolve_recipient<'a>(agents: &'a [Agent], recipient: &str) -> RecipientResolution<'a> {
    if let Some(agent) = agents.iter().find(|a| a.slug == recipient) {
        return RecipientResolution::Resolved(agent);
    }

    if let Some(agent) = agents
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(recipient))
    {
        return RecipientResolution::Resolved(agent);
    }

    let lower = recipient.to_ascii_lowercase();
    let is_hex = !lower.is_empty() && lower.chars().all(|c| c.is_ascii_hexdigit());
    if !is_hex {
        return RecipientResolution::NotFound;
    }

    if lower.len() == 64 {
        if let Some(agent) = agents.iter().find(|a| a.pubkey == lower) {
            return RecipientResolution::Resolved(agent);
        }
        return RecipientResolution::NotFound;
    }

    if lower.len() >= MIN_PUBKEY_PREFIX_LEN {
        let matches: Vec<&Agent> = agents
            .iter()
            .filter(|a| a.pubkey.starts_with(&lower))
            .collect();
        return match matches.len() {
            0 => RecipientResolution::NotFound,
            1 => RecipientResolution::Resolved(matches[0]),
            _ => RecipientResolution::Ambiguous(matches),
        };
    }

    RecipientResolution::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(pubkey: &str, slug: &str, name: &str) -> Agent {
        Agent {
            pubkey: pubkey.to_string(),
            slug: slug.to_string(),
            name: name.to_string(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            signer_ref: None,
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
            is_local: true,
            backend_name: None,
        }
    }

    fn roster() -> Vec<Agent> {
        vec![
            agent(
                "c433ae1b9783ba40ab73308cf238fd5f96a9340ce538f03e4d8ccd95db02bd2a",
                "chief-of-staff",
                "Chief of Staff",
            ),
            agent(
                "d766430c8e23a92f5ad7f4b6e1cd03b89e1f2a4c6b8d7e9f0a1b2c3d4e5f6a7b",
                "rocking-life",
                "Pablo's Rocking Life Agent",
            ),
            agent(
                "4108cd882d5bd7446b4b5cb0688b14694f3d0dbb52bd24f16e1e29ff1636adab",
                "human-replica",
                "Human Replica",
            ),
        ]
    }

    #[test]
    fn resolves_by_slug() {
        let r = roster();
        let m = resolve_recipient(&r, "chief-of-staff");
        assert!(matches!(m, RecipientResolution::Resolved(a) if a.slug == "chief-of-staff"));
    }

    #[test]
    fn resolves_by_exact_name_case_insensitive() {
        let r = roster();
        let m = resolve_recipient(&r, "pablo's rocking life agent");
        assert!(matches!(m, RecipientResolution::Resolved(a) if a.slug == "rocking-life"));
    }

    #[test]
    fn resolves_by_full_pubkey() {
        let r = roster();
        let m = resolve_recipient(
            &r,
            "d766430c8e23a92f5ad7f4b6e1cd03b89e1f2a4c6b8d7e9f0a1b2c3d4e5f6a7b",
        );
        assert!(matches!(m, RecipientResolution::Resolved(a) if a.slug == "rocking-life"));
    }

    #[test]
    fn resolves_by_unique_pubkey_prefix() {
        let r = roster();
        let m = resolve_recipient(&r, "d766430c");
        assert!(matches!(m, RecipientResolution::Resolved(a) if a.slug == "rocking-life"));
    }

    #[test]
    fn ambiguous_pubkey_prefix() {
        let mut r = roster();
        r.push(agent(
            "d766feedfacefacefacefacefacefacefacefacefacefacefacefacefaceface",
            "twin",
            "Twin",
        ));
        let m = resolve_recipient(&r, "d766");
        match m {
            RecipientResolution::Ambiguous(candidates) => assert_eq!(candidates.len(), 2),
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn rejects_non_hex_unknown_string() {
        let r = roster();
        assert!(matches!(
            resolve_recipient(&r, "totally-unknown"),
            RecipientResolution::NotFound
        ));
    }

    #[test]
    fn rejects_short_hex_below_threshold() {
        let r = roster();
        assert!(matches!(
            resolve_recipient(&r, "d76"),
            RecipientResolution::NotFound
        ));
    }
}

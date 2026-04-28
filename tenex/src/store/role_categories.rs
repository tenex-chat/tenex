//! Agent semantic-classification categories.
//!
//! Mirrors `src/agents/role-categories.ts` (`:1-58`) verbatim. The
//! category drives capability policy — e.g., a `domain-expert` receives
//! only `ask` calls while a `worker` is permitted follow-up delegation
//! but not new-agent spawn.
//!
//! Persisted in two places on the agent record:
//! - `category` — explicitly set (operator-authoritative)
//! - `inferredCategory` — auto-classified by the categorize backfill,
//!   kept separate so explicit provenance is preserved.
//!
//! The category strings on the wire are kebab-case literals; this module
//! preserves them byte-for-byte via [`AgentCategory::as_str`] /
//! [`AgentCategory::from_str_strict`].

/// Mirror of `AgentCategory` (`role-categories.ts:20`).
///
/// Six valid values; unknown input resolves to `None` per
/// [`resolve_category`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentCategory {
    Principal,
    Orchestrator,
    Worker,
    Reviewer,
    DomainExpert,
    Generalist,
}

impl AgentCategory {
    /// Verbatim string form used on disk and over Nostr (`category` /
    /// `inferredCategory` fields on the agent JSON).
    pub fn as_str(self) -> &'static str {
        match self {
            AgentCategory::Principal => "principal",
            AgentCategory::Orchestrator => "orchestrator",
            AgentCategory::Worker => "worker",
            AgentCategory::Reviewer => "reviewer",
            AgentCategory::DomainExpert => "domain-expert",
            AgentCategory::Generalist => "generalist",
        }
    }

    /// Strict parse — input must be exactly one of the six literals.
    /// Use [`resolve_category`] for the TS-faithful permissive variant
    /// that returns `None` on unknown input.
    pub fn from_str_strict(s: &str) -> Option<Self> {
        match s {
            "principal" => Some(AgentCategory::Principal),
            "orchestrator" => Some(AgentCategory::Orchestrator),
            "worker" => Some(AgentCategory::Worker),
            "reviewer" => Some(AgentCategory::Reviewer),
            "domain-expert" => Some(AgentCategory::DomainExpert),
            "generalist" => Some(AgentCategory::Generalist),
            _ => None,
        }
    }
}

/// Mirror of `VALID_CATEGORIES` (`role-categories.ts:26-33`):
/// the canonical list, in the canonical declaration order.
pub const VALID_CATEGORIES: &[AgentCategory] = &[
    AgentCategory::Principal,
    AgentCategory::Orchestrator,
    AgentCategory::Worker,
    AgentCategory::Reviewer,
    AgentCategory::DomainExpert,
    AgentCategory::Generalist,
];

/// Mirror of `isValidCategory` (`role-categories.ts:38-40`):
/// type-guard against the canonical literal set.
pub fn is_valid_category(value: &str) -> bool {
    AgentCategory::from_str_strict(value).is_some()
}

/// Mirror of `resolveCategory` (`role-categories.ts:50-58`):
/// permissive parse — returns `None` for empty input, unknown input,
/// **and** for `Some("")`. Mirrors the TS `if (!category)` guard which
/// treats both `undefined` and `""` as falsy.
pub fn resolve_category(value: Option<&str>) -> Option<AgentCategory> {
    let s = value?;
    if s.is_empty() {
        return None;
    }
    AgentCategory::from_str_strict(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_matches_ts_kebab_literals() {
        assert_eq!(AgentCategory::Principal.as_str(), "principal");
        assert_eq!(AgentCategory::Orchestrator.as_str(), "orchestrator");
        assert_eq!(AgentCategory::Worker.as_str(), "worker");
        assert_eq!(AgentCategory::Reviewer.as_str(), "reviewer");
        assert_eq!(AgentCategory::DomainExpert.as_str(), "domain-expert");
        assert_eq!(AgentCategory::Generalist.as_str(), "generalist");
    }

    #[test]
    fn valid_categories_in_canonical_order() {
        // Source: role-categories.ts:26-33.
        let actual: Vec<&str> = VALID_CATEGORIES.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            actual,
            vec![
                "principal",
                "orchestrator",
                "worker",
                "reviewer",
                "domain-expert",
                "generalist",
            ]
        );
    }

    #[test]
    fn from_str_strict_round_trips_every_canonical_literal() {
        for cat in VALID_CATEGORIES {
            let s = cat.as_str();
            assert_eq!(AgentCategory::from_str_strict(s), Some(*cat));
        }
    }

    #[test]
    fn from_str_strict_rejects_garbage() {
        assert_eq!(AgentCategory::from_str_strict(""), None);
        assert_eq!(AgentCategory::from_str_strict("PRINCIPAL"), None);
        assert_eq!(AgentCategory::from_str_strict("Principal"), None);
        assert_eq!(AgentCategory::from_str_strict("expert"), None);
        // Legacy values mentioned in storage.ts comments — they were
        // *auto-migrated* in TS; the strict parse here treats them as
        // unknown so the caller can choose to migrate or leave as-is.
        assert_eq!(AgentCategory::from_str_strict("executor"), None);
        assert_eq!(AgentCategory::from_str_strict("expert"), None);
        assert_eq!(AgentCategory::from_str_strict("advisor"), None);
        assert_eq!(AgentCategory::from_str_strict("creator"), None);
        assert_eq!(AgentCategory::from_str_strict("assistant"), None);
    }

    #[test]
    fn is_valid_category_accepts_canonical_set() {
        assert!(is_valid_category("principal"));
        assert!(is_valid_category("domain-expert"));
        assert!(is_valid_category("generalist"));
    }

    #[test]
    fn is_valid_category_rejects_unknown() {
        assert!(!is_valid_category(""));
        assert!(!is_valid_category("expert"));
        assert!(!is_valid_category("Domain-Expert"));
    }

    #[test]
    fn resolve_category_returns_none_for_none_input() {
        assert_eq!(resolve_category(None), None);
    }

    #[test]
    fn resolve_category_returns_none_for_empty_input() {
        // TS `if (!category)` treats `""` as falsy — we mirror that.
        assert_eq!(resolve_category(Some("")), None);
    }

    #[test]
    fn resolve_category_returns_some_for_valid_input() {
        assert_eq!(
            resolve_category(Some("worker")),
            Some(AgentCategory::Worker)
        );
        assert_eq!(
            resolve_category(Some("domain-expert")),
            Some(AgentCategory::DomainExpert)
        );
    }

    #[test]
    fn resolve_category_returns_none_for_unknown_input() {
        assert_eq!(resolve_category(Some("expert")), None);
        assert_eq!(resolve_category(Some("PRINCIPAL")), None);
    }
}

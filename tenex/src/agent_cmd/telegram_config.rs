//! Pure helpers for `tenex config telegram` per-agent flow.
//!
//! Mirrors the `TelegramDraft` shape, `toDraft`, `normalizeTelegramDraft`,
//! and `maskToken` helpers at
//! `src/commands/config/telegram.ts:18-22, 30-40, 46-61, 165-171`
//! verbatim. The interactive driver (chooseAgent → action loop) lives in
//! a screen-level module that consumes these primitives.
//!
//! `TelegramAgentConfig` itself (the typed wire shape) is in
//! [`crate::store::agent_storage`].

use crate::store::agent_storage::TelegramAgentConfig;

/// Working-set shape used by the interactive editor. Matches TS
/// `TelegramDraft` (`telegram.ts:18-22`): every field optional, no
/// invariant about `bot_token` being non-empty (that gets enforced at
/// [`normalize_telegram_draft`] time).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TelegramDraft {
    pub bot_token: Option<String>,
    pub allow_dms: Option<bool>,
    pub api_base_url: Option<String>,
}

/// `toDraft` (`telegram.ts:30-40`):
/// `Some(config)` → `Some(draft)`, `None` → `None`. Field-by-field carry
/// through.
pub fn to_draft(config: Option<&TelegramAgentConfig>) -> Option<TelegramDraft> {
    config.map(|c| TelegramDraft {
        bot_token: Some(c.bot_token.clone()),
        allow_dms: c.allow_dms,
        api_base_url: c.api_base_url.clone(),
    })
}

/// `normalizeTelegramDraft` (`telegram.ts:46-61`):
/// 1. `None` draft → `None` config (telegram disabled)
/// 2. Trim `bot_token`; empty after trim → `None` config (also disabled)
/// 3. Trim `api_base_url`; empty after trim → drop the field
/// 4. Carry `allow_dms` through verbatim
///
/// The invariant: a Some-result always has a non-empty `bot_token`.
pub fn normalize_telegram_draft(draft: Option<&TelegramDraft>) -> Option<TelegramAgentConfig> {
    let draft = draft?;
    let bot_token = draft.bot_token.as_deref()?.trim().to_owned();
    if bot_token.is_empty() {
        return None;
    }
    let api_base_url = draft
        .api_base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Some(TelegramAgentConfig {
        bot_token,
        allow_dms: draft.allow_dms,
        api_base_url,
        publish_reasoning_to_telegram: None,
        publish_conversation_to_telegram: None,
    })
}

/// `maskToken` (`telegram.ts:165-171`):
/// Tokens ≤ 8 chars passthrough; otherwise `<first-4>…<last-4>`. The
/// ellipsis is the unicode U+2026 (`…`), not three dots.
pub fn mask_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        return token.to_owned();
    }
    let first: String = chars.iter().take(4).collect();
    let last: String = chars.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{first}…{last}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(token: &str, allow_dms: Option<bool>, api: Option<&str>) -> TelegramAgentConfig {
        TelegramAgentConfig {
            bot_token: token.to_owned(),
            allow_dms,
            api_base_url: api.map(str::to_owned),
            publish_reasoning_to_telegram: None,
            publish_conversation_to_telegram: None,
        }
    }

    // ── to_draft ────────────────────────────────────────────────────────

    #[test]
    fn to_draft_none_passes_through() {
        assert_eq!(to_draft(None), None);
    }

    #[test]
    fn to_draft_carries_through_all_fields() {
        let c = cfg("tok", Some(true), Some("https://api.test"));
        let draft = to_draft(Some(&c)).unwrap();
        assert_eq!(draft.bot_token.as_deref(), Some("tok"));
        assert_eq!(draft.allow_dms, Some(true));
        assert_eq!(draft.api_base_url.as_deref(), Some("https://api.test"));
    }

    // ── normalize_telegram_draft ────────────────────────────────────────

    #[test]
    fn normalize_none_draft_returns_none() {
        assert!(normalize_telegram_draft(None).is_none());
    }

    #[test]
    fn normalize_empty_token_returns_none() {
        let d = TelegramDraft {
            bot_token: Some("".into()),
            ..Default::default()
        };
        assert!(normalize_telegram_draft(Some(&d)).is_none());
        // Whitespace-only also becomes empty after trim.
        let d = TelegramDraft {
            bot_token: Some("   \n".into()),
            ..Default::default()
        };
        assert!(normalize_telegram_draft(Some(&d)).is_none());
    }

    #[test]
    fn normalize_missing_token_returns_none() {
        let d = TelegramDraft {
            bot_token: None,
            ..Default::default()
        };
        assert!(normalize_telegram_draft(Some(&d)).is_none());
    }

    #[test]
    fn normalize_trims_and_keeps_token() {
        let d = TelegramDraft {
            bot_token: Some("  tok  ".into()),
            allow_dms: Some(false),
            api_base_url: Some("  https://api.example.com  ".into()),
        };
        let c = normalize_telegram_draft(Some(&d)).unwrap();
        assert_eq!(c.bot_token, "tok");
        assert_eq!(c.allow_dms, Some(false));
        assert_eq!(c.api_base_url.as_deref(), Some("https://api.example.com"));
    }

    #[test]
    fn normalize_drops_empty_api_base_url() {
        let d = TelegramDraft {
            bot_token: Some("tok".into()),
            allow_dms: None,
            api_base_url: Some("   ".into()),
        };
        let c = normalize_telegram_draft(Some(&d)).unwrap();
        assert!(c.api_base_url.is_none());
    }

    #[test]
    fn normalize_round_trips_through_to_draft() {
        let original = cfg("tok", Some(true), Some("https://x"));
        let draft = to_draft(Some(&original)).unwrap();
        let restored = normalize_telegram_draft(Some(&draft)).unwrap();
        assert_eq!(restored, original);
    }

    // ── mask_token ──────────────────────────────────────────────────────

    #[test]
    fn mask_token_short_passes_through() {
        assert_eq!(mask_token(""), "");
        assert_eq!(mask_token("12345678"), "12345678");
    }

    #[test]
    fn mask_token_long_replaces_middle_with_ellipsis() {
        assert_eq!(mask_token("123456789"), "1234…6789");
        assert_eq!(
            mask_token("abcdefghijklmnopqrstuvwxyz"),
            "abcd…wxyz"
        );
    }

    #[test]
    fn mask_token_uses_unicode_ellipsis() {
        // Source: TS `chalk.dim(\`${token.slice(0, 4)}…${token.slice(-4)}\`)`.
        let masked = mask_token("0123456789abcdef");
        assert!(masked.contains('…')); // U+2026
        assert!(!masked.contains("...")); // not three dots
    }

    #[test]
    fn mask_token_handles_unicode_correctly() {
        // Char-aware not byte-aware — leading/trailing chars are real chars.
        let masked = mask_token("αβγδεζηθικλμνξο");
        assert_eq!(masked, "αβγδ…λμνξο".chars().take(4).collect::<String>()
            + "…"
            + &"αβγδεζηθικλμνξο".chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>());
    }
}

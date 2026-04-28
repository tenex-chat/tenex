//! Telegram identity validation.
//!
//! Per spec doc 07 §6: the only enforced rule is that the value starts with
//! `telegram:`. The canonical form `telegram:user:<id>` is suggestion text in
//! the prompt, not enforced. Reproduce that exactly.

/// True if `s` is a Telegram identity (begins with `telegram:`).
pub fn is_telegram_identity(s: &str) -> bool {
    s.starts_with("telegram:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_telegram_user_form() {
        assert!(is_telegram_identity("telegram:user:5104033799"));
    }

    #[test]
    fn accepts_simple_form() {
        // The TS validator is `startsWith("telegram:")` — the suggested
        // canonical form `telegram:user:<id>` is *not* enforced.
        assert!(is_telegram_identity("telegram:5104033799"));
    }

    #[test]
    fn rejects_missing_prefix() {
        assert!(!is_telegram_identity("user:5104033799"));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_telegram_identity(""));
    }

    #[test]
    fn rejects_partial_prefix() {
        assert!(!is_telegram_identity("telegra"));
    }

    #[test]
    fn case_sensitive() {
        // TS `String.prototype.startsWith` is case-sensitive.
        assert!(!is_telegram_identity("TELEGRAM:1"));
    }
}

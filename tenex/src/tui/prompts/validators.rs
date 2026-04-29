//! Generic input validators with verbatim TS error strings.
//!
//! Each function pairs with [`crate::tui::prompts::adapt_static_str_validator`]
//! for use as `.with_validator(...)` on [`crate::tui::prompts::input`].
//!
//! The error strings are the literal TS strings the user sees in
//! `inquirer.prompt({ validate: … })` — anything that diverges from
//! `src/commands/config/*.ts` is a user-visible bug.

/// Integer > 0.
///
/// Matches the rule used across the config submenus that cap a numeric
/// setting at "must be a positive integer". Source examples:
/// - `src/commands/config/telemetry.ts` (interval inputs)
/// - `src/commands/config/context-management.ts` (TTL / size inputs)
pub fn validate_positive_integer(input: &str) -> Result<(), &'static str> {
    if input.is_empty() || !input.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Please enter a positive number");
    }
    let n: u64 = input.parse().unwrap_or(0);
    if n == 0 {
        Err("Please enter a positive number")
    } else {
        Ok(())
    }
}

/// Integer ≥ 0 (zero allowed).
///
/// Used wherever a "0 disables" or "0 = unlimited" semantic applies.
pub fn validate_non_negative_integer(input: &str) -> Result<(), &'static str> {
    if !input.is_empty() && input.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("Please enter a non-negative number")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_positive_integer_accepts_positive() {
        assert!(validate_positive_integer("1").is_ok());
        assert!(validate_positive_integer("30000").is_ok());
    }

    #[test]
    fn validate_positive_integer_rejects_zero_with_verbatim_message() {
        assert_eq!(
            validate_positive_integer("0"),
            Err("Please enter a positive number")
        );
    }

    #[test]
    fn validate_positive_integer_rejects_garbage_with_verbatim_message() {
        assert_eq!(
            validate_positive_integer(""),
            Err("Please enter a positive number")
        );
        assert_eq!(
            validate_positive_integer("-1"),
            Err("Please enter a positive number")
        );
        assert_eq!(
            validate_positive_integer("abc"),
            Err("Please enter a positive number")
        );
        assert_eq!(
            validate_positive_integer("3.5"),
            Err("Please enter a positive number")
        );
    }

    #[test]
    fn validate_non_negative_integer_accepts_zero() {
        assert!(validate_non_negative_integer("0").is_ok());
        assert!(validate_non_negative_integer("2").is_ok());
        assert!(validate_non_negative_integer("100").is_ok());
    }

    #[test]
    fn validate_non_negative_integer_rejects_with_verbatim_message() {
        assert_eq!(
            validate_non_negative_integer(""),
            Err("Please enter a non-negative number")
        );
        assert_eq!(
            validate_non_negative_integer("-1"),
            Err("Please enter a non-negative number")
        );
        assert_eq!(
            validate_non_negative_integer("abc"),
            Err("Please enter a non-negative number")
        );
    }
}

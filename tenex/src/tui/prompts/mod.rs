//! Inquire wrappers that pre-apply the TENEX inquirer theme.
//!
//! Theme source: `inquirerTheme` at `src/utils/cli-theme.ts:6-13`. Every
//! call site in TS passes `theme: inquirerTheme` to `inquirer.prompt(...)`;
//! the Rust port mirrors that by routing every interactive prompt through
//! one of the helpers in this module so [`theme()`] is applied centrally.
//!
//! Stock inquire cursor `❯` is used here (matches `inquirerTheme.icon.cursor`
//! at `src/utils/cli-theme.ts:8`). The custom-prompt thin chevron `›` is
//! distinct and lives in `crate::tui::custom_prompts` (next iteration).
//!
//! Color conventions (per spec doc 12 §0):
//! - **Inquirer-prompt orange** is true `#FFC107` — emit as `Color::Rgb {255,193,7}`.
//! - Section headers / banner / hints use ansi256 #214; those are NOT
//!   touched by this module — they live in [`crate::tui::theme`].
//!
//! Validators from [`crate::types`] adapt to inquire's signature via
//! [`adapt_string_validator`] / [`adapt_static_str_validator`].

mod theme;

pub use theme::theme;

use inquire::validator::Validation;
use inquire::{Confirm, CustomUserError, Password, Select, Text};

/// Build a [`Text`] prompt with the TENEX theme already applied. Caller may
/// chain `.with_default()`, `.with_validator()`, `.with_help_message()` etc.
/// before calling `.prompt()?`.
pub fn input<'a>(message: &'a str) -> Text<'a> {
    Text::new(message).with_render_config(theme())
}

/// Build a [`Password`] prompt with the TENEX theme and masked-character
/// display (matches the TS API-key entry behaviour at
/// `src/llm/utils/provider-setup.ts` — `mask: "*"`, no second confirmation).
pub fn password<'a>(message: &'a str) -> Password<'a> {
    Password::new(message)
        .with_render_config(theme())
        .with_display_mode(inquire::PasswordDisplayMode::Masked)
        .without_confirmation()
}

/// Build a [`Select`] (single-pick list) prompt with the TENEX theme.
pub fn select<'a, T: std::fmt::Display>(message: &'a str, options: Vec<T>) -> Select<'a, T> {
    Select::new(message, options).with_render_config(theme())
}

/// Build a [`Confirm`] (y/n) prompt with the TENEX theme.
pub fn confirm<'a>(message: &'a str) -> Confirm<'a> {
    Confirm::new(message).with_render_config(theme())
}

/// Adapt a `Fn(&str) -> Result<(), &'static str>` (the shape of
/// [`crate::types::relay`] validators) to inquire's
/// `Fn(&str) -> Result<Validation, CustomUserError>`. The `&'static str`
/// error becomes a `Validation::Invalid` with the same wording.
///
/// Returns a closure that satisfies `inquire::validator::StringValidator`:
/// `Clone + Send + Sync + 'static`.
pub fn adapt_static_str_validator<F>(
    f: F,
) -> impl Fn(&str) -> Result<Validation, CustomUserError> + Clone + Send + Sync + 'static
where
    F: Fn(&str) -> Result<(), &'static str> + Clone + Send + Sync + 'static,
{
    move |input| match f(input) {
        Ok(()) => Ok(Validation::Valid),
        Err(msg) => Ok(Validation::Invalid(msg.into())),
    }
}

/// Adapt an owning-error validator (`Fn(&str) -> Result<_, E: ToString>`) to
/// inquire's signature. The first non-empty error message is surfaced via
/// [`Validation::Invalid`].
pub fn adapt_string_validator<F, E>(
    f: F,
) -> impl Fn(&str) -> Result<Validation, CustomUserError> + Clone + Send + Sync + 'static
where
    F: Fn(&str) -> Result<(), E> + Clone + Send + Sync + 'static,
    E: std::fmt::Display,
{
    move |input| match f(input) {
        Ok(()) => Ok(Validation::Valid),
        Err(e) => Ok(Validation::Invalid(e.to_string().into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::relay;

    #[test]
    fn adapt_static_str_passes_through_ok() {
        let v = adapt_static_str_validator(relay::validate_onboard);
        assert!(matches!(v("wss://relay.tenex.chat"), Ok(Validation::Valid)));
    }

    #[test]
    fn adapt_static_str_surfaces_exact_ts_error_text() {
        use inquire::validator::ErrorMessage;
        let v = adapt_static_str_validator(relay::validate_onboard);
        let result = v("wss://localhost").unwrap();
        match result {
            // Must be byte-identical to the TS string at
            // src/commands/onboard.ts:1370.
            Validation::Invalid(ErrorMessage::Custom(msg)) => {
                assert_eq!(msg, "Enter a relay hostname");
            }
            other => panic!("expected Invalid(Custom), got {other:?}"),
        }
    }

    #[test]
    fn adapt_static_str_protocol_error_verbatim() {
        use inquire::validator::ErrorMessage;
        let v = adapt_static_str_validator(relay::validate_onboard);
        let result = v("https://relay.example").unwrap();
        match result {
            Validation::Invalid(ErrorMessage::Custom(msg)) => {
                assert_eq!(msg, "URL must use ws:// or wss:// protocol");
            }
            other => panic!("expected Invalid(Custom), got {other:?}"),
        }
    }

    #[test]
    fn adapt_string_validator_with_displayable_error() {
        use crate::types::pubkey::Pubkey;
        use inquire::validator::ErrorMessage;
        let v =
            adapt_string_validator(|input: &str| Pubkey::parse_hex64(input).map(|_| ()));
        let result = v("not-hex").unwrap();
        match result {
            Validation::Invalid(ErrorMessage::Custom(msg)) => {
                assert!(msg.contains("64"), "got: {msg}");
            }
            other => panic!("expected Invalid(Custom), got {other:?}"),
        }
    }
}

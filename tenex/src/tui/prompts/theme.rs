//! Inquire [`RenderConfig`] matching the TS `inquirerTheme`.
//!
//! Source: `src/utils/cli-theme.ts:6-13`:
//!
//! ```ts
//! export const inquirerTheme = {
//!     prefix: { idle: amber("?"), done: chalk.green("✓") },
//!     icon:   { cursor: amber("❯") },
//!     style:  {
//!         highlight: (text: string) => amber(text),
//!         answer:    (text: string) => amber(text),
//!     },
//! };
//! ```
//!
//! Where `amber = chalk.hex("#FFC107")` (`src/utils/cli-theme.ts:3`).
//!
//! Mapping to inquire's [`RenderConfig`]:
//!
//! | TS field                    | Inquire setter                                      |
//! |-----------------------------|-----------------------------------------------------|
//! | `prefix.idle = "?"` (amber) | [`with_prompt_prefix`]                              |
//! | `prefix.done = "✓"` (green) | [`with_answered_prompt_prefix`]                     |
//! | `icon.cursor = "❯"` (amber) | [`with_highlighted_option_prefix`]                  |
//! | `style.highlight` (amber)   | [`with_selected_option`]                            |
//! | `style.answer` (amber)      | [`with_answer`]                                     |

use inquire::ui::{Color, RenderConfig, StyleSheet, Styled};

/// `#FFC107` truecolor — the inquirer-prompt orange (per spec doc 12 §0).
/// **Distinct from** the ansi256-#214 used in banners/headers; do not unify.
pub const INQUIRER_AMBER: Color = Color::Rgb {
    r: 0xFF,
    g: 0xC1,
    b: 0x07,
};

/// Build the shared inquirer-theme [`RenderConfig`].
///
/// Returned config has `'static` lifetime so callers can stash or chain it
/// freely. Use via [`super::input`] / [`super::password`] / etc., or pass
/// directly to inquire prompts via `.with_render_config(theme())`.
pub fn theme() -> RenderConfig<'static> {
    RenderConfig::default_colored()
        .with_prompt_prefix(Styled::new("?").with_fg(INQUIRER_AMBER))
        .with_answered_prompt_prefix(Styled::new("✓").with_fg(Color::DarkGreen))
        .with_highlighted_option_prefix(Styled::new("❯").with_fg(INQUIRER_AMBER))
        .with_selected_option(Some(StyleSheet::new().with_fg(INQUIRER_AMBER)))
        .with_answer(StyleSheet::new().with_fg(INQUIRER_AMBER))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amber_constant_matches_truecolor_ffc107() {
        // Brutal-pin: must match `chalk.hex("#FFC107")` byte-for-byte.
        match INQUIRER_AMBER {
            Color::Rgb { r, g, b } => {
                assert_eq!((r, g, b), (0xFF, 0xC1, 0x07));
            }
            _ => panic!("INQUIRER_AMBER must be RGB truecolor (not ansi256-214 — see spec doc 12 §0)"),
        }
    }

    #[test]
    fn theme_uses_amber_for_idle_prefix() {
        let cfg = theme();
        assert_eq!(cfg.prompt_prefix.content, "?");
        assert_eq!(cfg.prompt_prefix.style.fg, Some(INQUIRER_AMBER));
    }

    #[test]
    fn theme_uses_check_glyph_in_green_for_done_prefix() {
        let cfg = theme();
        assert_eq!(cfg.answered_prompt_prefix.content, "✓");
        assert_eq!(cfg.answered_prompt_prefix.style.fg, Some(Color::DarkGreen));
    }

    #[test]
    fn theme_uses_heavy_chevron_for_cursor() {
        // Stock inquirer prompts use `❯` (U+276F). The thin `›` (U+203A) is
        // reserved for custom prompts (see crate::tui::custom_prompts) — do
        // not unify (spec doc 12 §2).
        let cfg = theme();
        assert_eq!(cfg.highlighted_option_prefix.content, "❯");
        assert_eq!(cfg.highlighted_option_prefix.style.fg, Some(INQUIRER_AMBER));
    }

    #[test]
    fn theme_paints_answer_amber() {
        let cfg = theme();
        assert_eq!(cfg.answer.fg, Some(INQUIRER_AMBER));
    }

    #[test]
    fn theme_paints_selected_option_amber() {
        let cfg = theme();
        let selected = cfg.selected_option.expect("selected_option set");
        assert_eq!(selected.fg, Some(INQUIRER_AMBER));
    }
}

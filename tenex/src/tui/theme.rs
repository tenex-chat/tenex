//! Color palette for the TENEX CLI.
//!
//! TENEX uses **two distinct oranges** that look similar but are not the same
//! color and **must not be unified**:
//!
//! | Constant family    | Definition           | Where in TS         | Where here |
//! |--------------------|----------------------|---------------------|------------|
//! | `INQUIRER_AMBER`   | truecolor `#FFC107`  | inquirer prompts    | inquire prompts in this crate |
//! | `DISPLAY_*` (214)  | xterm-256 #214       | section headers, banner accent, hints | banner, headers, hints |
//!
//! See `docs/tui-port/12-visual-styling.md` for the full justification.
//!
//! Each constant exposes a `Style` from `console` ready to wrap a string.
//! Avoid raw `\x1b[…]` sequences in feature code — go through these constants.

use console::Style;

// ---------------------------------------------------------------------------
// Inquirer-prompt orange (truecolor #FFC107). Only for inquire prompts.
// `src/utils/cli-theme.ts:3-13`
// ---------------------------------------------------------------------------

/// Truecolor amber `#FFC107`. Inquirer prompt cursor (`❯`), prefix (`?`),
/// highlight, answer echo. NEVER use for banner/section headers.
pub fn inquirer_amber() -> Style {
    Style::new().color256(214) // approximated for non-truecolor terminals; the
                                // emit path below uses true 24-bit RGB
}

/// Inquirer-prompt amber as a 24-bit RGB ANSI escape sequence — `console`'s
/// `Style` does not expose RGB directly, so call sites that must hit pixel-
/// exact `#FFC107` should use this and the matching reset.
pub const INQUIRER_AMBER_FG: &str = "\x1b[38;2;255;193;7m";

/// Inquirer-prompt amber as a [`crossterm::style::Color::Rgb`] value.
/// All bespoke crossterm-rendered prompts (provider-select, role menu,
/// LLM menu, agent-select, variant-list, relay) use this for their
/// active-row cursor and amber-highlight foreground. Defined in one
/// place here so the truecolor value lives at a single source of truth.
pub const INQUIRER_AMBER_CROSSTERM: crossterm::style::Color =
    crossterm::style::Color::Rgb { r: 0xFF, g: 0xC1, b: 0x07 };

/// Display-palette accent — xterm-256 #214 (`#ffaf00`). Section
/// headers, hint `→`, banner `T E N E X` letter, summary `▲`, and the
/// bespoke-prompt 'Done' label. **Distinct from**
/// [`INQUIRER_AMBER_CROSSTERM`] (truecolor `#FFC107`) — spec doc 12 §0
/// pins the two oranges as deliberately different.
pub const DISPLAY_ACCENT_CROSSTERM: crossterm::style::Color =
    crossterm::style::Color::AnsiValue(214);

/// Display-palette selected — xterm-256 #114 (`#87d787`). Used for
/// the bold `[✓]` glyph in the provider-select browse pane.
pub const DISPLAY_SELECTED_CROSSTERM: crossterm::style::Color =
    crossterm::style::Color::AnsiValue(114);

/// Display-palette muted — xterm-256 #240 (`#585858`). Used for the
/// inactive role-recommendation tint in the role-menu prompt
/// (`roles.ts:186` `chalk.ansi256(240)`).
pub const DISPLAY_MUTED_CROSSTERM: crossterm::style::Color =
    crossterm::style::Color::AnsiValue(240);

// ---------------------------------------------------------------------------
// Display palette (xterm-256). Banner gradient, section headers, hints.
// `src/commands/config/display.ts:3-12`
// ---------------------------------------------------------------------------

/// Banner row 0 (top apex) — xterm-256 #222 (`#ffd787`).
pub fn banner_glow() -> Style {
    Style::new().color256(222).bold()
}

/// Banner row 1 — xterm-256 #220 (`#ffd700`).
pub fn banner_bright() -> Style {
    Style::new().color256(220).bold()
}

/// Banner row 2 / brand accent — xterm-256 #214 (`#ffaf00`).
/// Section headers, hint `→`, banner letter `T E N E X`, summary `▲`.
pub fn display_accent() -> Style {
    Style::new().color256(214).bold()
}

/// Banner row 3 — xterm-256 #172 (`#d78700`).
pub fn banner_mid() -> Style {
    Style::new().color256(172).bold()
}

/// Banner row 4 (bottom base) — xterm-256 #130 (`#af5f00`).
pub fn banner_dark() -> Style {
    Style::new().color256(130).bold()
}

/// Info / sky blue — xterm-256 #117 (`#87d7ff`).
/// Summary line label; team-agent bullet `●`.
pub fn display_info() -> Style {
    Style::new().color256(117)
}

/// Selection green — xterm-256 #114 (`#87d787`).
/// Provider check `[✓]`.
pub fn display_selected() -> Style {
    Style::new().color256(114)
}

/// Muted dark gray — xterm-256 #240 (`#585858`).
/// Inactive role hint, secondary metadata.
pub fn display_muted() -> Style {
    Style::new().color256(240)
}

// ---------------------------------------------------------------------------
// 16-color basics (semantic).
// ---------------------------------------------------------------------------

/// Error red. `❌`, `✗`, fatal log line.
pub fn error_red() -> Style {
    Style::new().red()
}

/// Success green. `✓`, success log line, `[FREE]` tag, `[x]` checkbox.
pub fn success_green() -> Style {
    Style::new().green()
}

/// Warning yellow. `⚠`, warn log line, tool-call line `🔧`, spinner.
pub fn warning_yellow() -> Style {
    Style::new().yellow()
}

/// Info blue. Doctor progress.
pub fn info_blue() -> Style {
    Style::new().blue()
}

/// Action / accent cyan. Action items, "Add variant", relay bullet `●`.
pub fn action_cyan() -> Style {
    Style::new().cyan()
}

/// Muted gray. Debug log line, secondary metadata, hints.
pub fn muted_gray() -> Style {
    Style::new().color256(244)
}

/// `chalk.gray` visual match. TS chalk emits `\x1b[90m` (bright black).
/// console::Style's `.black().bright()` translates that to
/// `\x1b[38;5;8m` (xterm-256 palette index 8) — different bytes but
/// the same on-screen colour in any reasonable terminal (palette index
/// 8 is bright black). Use [`crate::tui::theme::CHALK_GRAY_OPEN`] +
/// [`CHALK_GRAY_CLOSE`] for the byte-exact ANSI-90 form when emitting
/// raw escapes by hand.
///
/// Distinct from [`muted_gray`] (`\x1b[38;5;244m`), the darker palette
/// gray used for log lines and metadata.
pub fn chalk_gray() -> Style {
    Style::new().black().bright()
}

/// Raw `\x1b[90m` — chalk.gray's exact open code. Use this when you
/// need byte-for-byte match with TS output (e.g. golden-file tests
/// against TS recordings); the [`chalk_gray`] helper produces an
/// xterm-256 form that's visually identical but byte-different.
pub const CHALK_GRAY_OPEN: &str = "\x1b[90m";

/// Raw chalk.gray close code — `\x1b[39m` (default foreground).
pub const CHALK_GRAY_CLOSE: &str = "\x1b[39m";

/// Dim modifier (no color, just dimmed). Background instructions, `Back`
/// labels, separators (`──`), hints, `[ ]`, `(default)`.
pub fn dim() -> Style {
    Style::new().dim()
}

/// Bold modifier (default fg). Emphasis on default-color text.
pub fn bold() -> Style {
    Style::new().bold()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// console::Style.black().bright() actually emits xterm-256 index 8
    /// (`\x1b[38;5;8m`), NOT raw ANSI 90 — visually identical bright
    /// black, byte-different from chalk's wire form. Pin both forms so
    /// callers know which to reach for.
    #[test]
    fn chalk_gray_emits_xterm_256_index_8_visual_match() {
        let styled = chalk_gray()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        assert!(
            styled.starts_with("\x1b[38;5;8m"),
            "got: {styled:?}"
        );
    }

    #[test]
    fn chalk_gray_open_close_match_chalk_wire_bytes() {
        // For golden-file byte parity with TS, use CHALK_GRAY_OPEN and
        // CHALK_GRAY_CLOSE directly. chalk emits `\x1b[90m...\x1b[39m`.
        assert_eq!(CHALK_GRAY_OPEN, "\x1b[90m");
        assert_eq!(CHALK_GRAY_CLOSE, "\x1b[39m");
    }

    /// muted_gray is the xterm-256 #244 palette gray — distinct from
    /// chalk_gray's ANSI 90. Pin the divergence so the two never get
    /// silently unified.
    #[test]
    fn muted_gray_emits_xterm_256_244() {
        let styled = muted_gray()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        assert!(
            styled.starts_with("\x1b[38;5;244m"),
            "got: {styled:?}"
        );
    }

    #[test]
    fn chalk_gray_and_muted_gray_emit_distinct_ansi_sequences() {
        let cg = chalk_gray()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        let mg = muted_gray()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        assert_ne!(cg, mg);
    }
}

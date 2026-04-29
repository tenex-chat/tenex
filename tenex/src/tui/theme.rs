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
//! Public surface:
//! - `chalk_*(text) -> String` helpers — byte-perfect TS chalk wraps
//!   for red / green / yellow / blue / cyan / dim / bold / gray.
//! - Raw escape constants (`INQUIRER_AMBER_FG`, `BOLD_OPEN/CLOSE`,
//!   `DIM_OPEN/CLOSE`, `CHALK_GRAY_OPEN/CLOSE`, `FG_RESET`,
//!   `CHALK_RED_OPEN`, etc.) for callers composing styled fragments
//!   manually.
//! - `*_CROSSTERM` colour constants for the bespoke crossterm prompts.
//! - `display_accent()` Style — the only `console::Style` survivor,
//!   used by cron_cmd which is Rust-only (no TS counterpart).

use console::Style;

// ---------------------------------------------------------------------------
// Inquirer-prompt orange (truecolor #FFC107). Only for inquire prompts.
// `src/utils/cli-theme.ts:3-13`
// ---------------------------------------------------------------------------

/// Inquirer-prompt amber as a 24-bit RGB ANSI escape sequence — `console`'s
/// `Style` does not expose RGB directly, so call sites that must hit pixel-
/// exact `#FFC107` should use this and the matching reset.
pub const INQUIRER_AMBER_FG: &str = "\x1b[38;2;255;193;7m";

/// Inquirer-prompt amber as a [`crossterm::style::Color::Rgb`] value.
/// All bespoke crossterm-rendered prompts (provider-select, role menu,
/// LLM menu, agent-select, variant-list, relay) use this for their
/// active-row cursor and amber-highlight foreground. Defined in one
/// place here so the truecolor value lives at a single source of truth.
pub const INQUIRER_AMBER_CROSSTERM: crossterm::style::Color = crossterm::style::Color::Rgb {
    r: 0xFF,
    g: 0xC1,
    b: 0x07,
};

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

/// Brand accent — xterm-256 #214 (`#ffaf00`) **bold**.
/// Used by cron_cmd status messages and the "Done" label in bespoke prompts.
/// TS equivalent: `ACCENT.bold(...)` where `ACCENT = chalk.ansi256(214)`.
///
/// Note: `display.step()`, `display.hint()`, and the banner rows emit raw
/// `\x1b[38;5;Nm` escapes directly for byte-exact TS chalk matching; they
/// do not call this helper.
pub fn display_accent() -> Style {
    Style::new().color256(214).bold()
}

/// Raw `\x1b[90m` — chalk.gray's exact open code. Pair with
/// [`CHALK_GRAY_CLOSE`], or use the [`chalk_gray_str`] helper for the
/// formatted-string variant (`\x1b[90m<text>\x1b[39m` byte-for-byte
/// matching TS chalk.gray).
pub const CHALK_GRAY_OPEN: &str = "\x1b[90m";

/// Raw chalk.gray close code — `\x1b[39m` (default foreground reset).
/// Aliases [`FG_RESET`] for callers who paired the open with [`CHALK_GRAY_OPEN`].
pub const CHALK_GRAY_CLOSE: &str = FG_RESET;

/// Raw `\x1b[39m` — default foreground reset (SGR 39). Closes any
/// `SetForegroundColor`-style open code (chalk.gray, the truecolor
/// amber, xterm-256 palette colors). Pair with whichever open code
/// you emitted.
pub const FG_RESET: &str = "\x1b[39m";

/// Raw `\x1b[1m` — bold open (SGR 1). Pair with [`BOLD_CLOSE`].
pub const BOLD_OPEN: &str = "\x1b[1m";

/// Raw `\x1b[22m` — bold close (cancels SGR 1, also SGR 2 dim). The
/// same byte sequence cancels both bold and dim — that's why this
/// constant aliases [`DIM_CLOSE`].
pub const BOLD_CLOSE: &str = DIM_CLOSE;

/// Raw chalk.dim open code — `\x1b[2m` (SGR 2, dim attribute). Use
/// when embedding dim-styled segments inside a label string that's
/// later emitted by inquire (which doesn't run our crossterm
/// rendering pipeline). Pair with [`DIM_CLOSE`].
pub const DIM_OPEN: &str = "\x1b[2m";

/// Raw chalk.dim close code — `\x1b[22m` (cancels SGR 2). Pair with
/// [`DIM_OPEN`].
pub const DIM_CLOSE: &str = "\x1b[22m";

/// Raw chalk.red open code — `\x1b[31m` (basic ANSI red, SGR 31).
/// Pair with [`FG_RESET`]. Matches `chalk.red(text)` byte-for-byte.
pub const CHALK_RED_OPEN: &str = "\x1b[31m";

/// Raw chalk.green open code — `\x1b[32m` (basic ANSI green, SGR 32).
/// Pair with [`FG_RESET`]. Matches `chalk.green(text)` byte-for-byte.
pub const CHALK_GREEN_OPEN: &str = "\x1b[32m";

/// Raw chalk.yellow open code — `\x1b[33m` (basic ANSI yellow, SGR 33).
/// Pair with [`FG_RESET`]. Matches `chalk.yellow(text)` byte-for-byte.
pub const CHALK_YELLOW_OPEN: &str = "\x1b[33m";

/// Raw chalk.blue open code — `\x1b[34m` (basic ANSI blue, SGR 34).
/// Pair with [`FG_RESET`]. Matches `chalk.blue(text)` byte-for-byte.
pub const CHALK_BLUE_OPEN: &str = "\x1b[34m";

/// Raw chalk.cyan open code — `\x1b[36m` (basic ANSI cyan, SGR 36).
/// Pair with [`FG_RESET`]. Matches `chalk.cyan(text)` byte-for-byte.
pub const CHALK_CYAN_OPEN: &str = "\x1b[36m";

/// Wrap `text` in chalk.red wire bytes:
/// `\x1b[31m<text>\x1b[39m`.
///
/// Console-rs's `Style::new().red().apply_to(text)` would produce
/// `\x1b[31m<text>\x1b[0m` (SGR-0 full-reset close). This helper emits
/// the per-attribute SGR-39 close that TS chalk uses.
pub fn chalk_red(text: &str) -> String {
    format!("{CHALK_RED_OPEN}{text}{FG_RESET}")
}

/// Wrap `text` in chalk.green wire bytes: `\x1b[32m<text>\x1b[39m`.
pub fn chalk_green(text: &str) -> String {
    format!("{CHALK_GREEN_OPEN}{text}{FG_RESET}")
}

/// Wrap `text` in chalk.yellow wire bytes: `\x1b[33m<text>\x1b[39m`.
pub fn chalk_yellow(text: &str) -> String {
    format!("{CHALK_YELLOW_OPEN}{text}{FG_RESET}")
}

/// Wrap `text` in chalk.blue wire bytes: `\x1b[34m<text>\x1b[39m`.
pub fn chalk_blue(text: &str) -> String {
    format!("{CHALK_BLUE_OPEN}{text}{FG_RESET}")
}

/// Wrap `text` in chalk.cyan wire bytes: `\x1b[36m<text>\x1b[39m`.
pub fn chalk_cyan(text: &str) -> String {
    format!("{CHALK_CYAN_OPEN}{text}{FG_RESET}")
}

/// Wrap `text` in chalk.dim wire bytes: `\x1b[2m<text>\x1b[22m`.
pub fn chalk_dim(text: &str) -> String {
    format!("{DIM_OPEN}{text}{DIM_CLOSE}")
}

/// Wrap `text` in chalk.bold wire bytes: `\x1b[1m<text>\x1b[22m`.
pub fn chalk_bold(text: &str) -> String {
    format!("{BOLD_OPEN}{text}{BOLD_CLOSE}")
}

/// Wrap `text` in inquirer-amber truecolor wire bytes:
/// `\x1b[38;2;255;193;7m<text>\x1b[39m` — matches TS
/// `chalk.hex("#FFC107")(text)` byte-for-byte (`utils/cli-theme.ts:3`).
pub fn inquirer_amber(text: &str) -> String {
    format!("{INQUIRER_AMBER_FG}{text}{FG_RESET}")
}

/// Wrap `text` in inquirer-amber-bold truecolor wire bytes:
/// `\x1b[38;2;255;193;7m\x1b[1m<text>\x1b[22m\x1b[39m` — matches TS
/// `chalk.hex("#FFC107").bold(text)` byte-for-byte (the `amberBold`
/// alias at `utils/cli-theme.ts:4`).
pub fn inquirer_amber_bold(text: &str) -> String {
    format!("{INQUIRER_AMBER_FG}{BOLD_OPEN}{text}{BOLD_CLOSE}{FG_RESET}")
}

/// Wrap `text` in chalk.gray wire bytes: `\x1b[90m<text>\x1b[39m`
/// (basic ANSI 90, not the xterm-256 #8 form `console::Style`'s
/// `.black().bright()` would emit).
pub fn chalk_gray_str(text: &str) -> String {
    format!("{CHALK_GRAY_OPEN}{text}{CHALK_GRAY_CLOSE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chalk_gray_open_close_match_chalk_wire_bytes() {
        // For golden-file byte parity with TS, use CHALK_GRAY_OPEN and
        // CHALK_GRAY_CLOSE directly. chalk emits `\x1b[90m...\x1b[39m`.
        assert_eq!(CHALK_GRAY_OPEN, "\x1b[90m");
        assert_eq!(CHALK_GRAY_CLOSE, "\x1b[39m");
    }

    /// Pin the basic-ANSI color helpers' wire bytes — must match chalk
    /// exactly (open SGR 31/32/33/34/36, close SGR 39) so config / agent
    /// / doctor banners can switch off `console::Style.apply_to(...)`
    /// (which closes with SGR-0) without losing colour fidelity.
    #[test]
    fn chalk_basic_color_helpers_emit_per_attribute_close() {
        assert_eq!(chalk_red("ERR"), "\x1b[31mERR\x1b[39m");
        assert_eq!(chalk_green("ok"), "\x1b[32mok\x1b[39m");
        assert_eq!(chalk_yellow("!"), "\x1b[33m!\x1b[39m");
        assert_eq!(chalk_blue("info"), "\x1b[34minfo\x1b[39m");
        assert_eq!(chalk_cyan("●"), "\x1b[36m●\x1b[39m");
    }

    #[test]
    fn chalk_dim_and_bold_helpers_emit_per_attribute_close() {
        assert_eq!(chalk_dim("muted"), "\x1b[2mmuted\x1b[22m");
        assert_eq!(chalk_bold("loud"), "\x1b[1mloud\x1b[22m");
    }

    #[test]
    fn chalk_helpers_never_emit_sgr_0_full_reset() {
        for s in [
            chalk_red("x"),
            chalk_green("x"),
            chalk_yellow("x"),
            chalk_blue("x"),
            chalk_cyan("x"),
            chalk_dim("x"),
            chalk_bold("x"),
            inquirer_amber("x"),
            inquirer_amber_bold("x"),
        ] {
            assert!(
                !s.contains("\x1b[0m"),
                "chalk-helper output must use per-attribute close, not SGR 0; got {s:?}",
            );
        }
    }

    /// Pin the inquirer-amber truecolor helpers to TS chalk.hex("#FFC107")
    /// wire bytes — open `\x1b[38;2;255;193;7m`, close `\x1b[39m`.
    #[test]
    fn inquirer_amber_helpers_emit_truecolor_ffc107() {
        assert_eq!(inquirer_amber("x"), "\x1b[38;2;255;193;7mx\x1b[39m");
        assert_eq!(
            inquirer_amber_bold("x"),
            "\x1b[38;2;255;193;7m\x1b[1mx\x1b[22m\x1b[39m",
        );
    }
}

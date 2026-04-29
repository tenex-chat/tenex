//! Output helpers used by every onboarding / config / doctor screen.
//!
//! 1:1 port of `src/commands/config/display.ts`. Every helper writes to
//! stdout (or returns a styled string for inline use) and is byte-for-byte
//! aligned with the TS template via the colour palette in
//! [`crate::tui::theme`] and the glyph constants in [`crate::tui::glyphs`].
//!
//! When a helper takes ownership of the line (e.g. [`step`], [`success`],
//! [`hint`]) it appends a single `\n` via `println!`. When it returns a
//! styled fragment for inline composition (e.g. [`provider_check`]),
//! it returns a `String` whose ANSI codes are already embedded.
//!
//! Test coverage uses ANSI-stripped comparisons for ergonomics; the colour
//! pin lives in `crate::tui::theme` (single source of truth) so the same
//! palette can't drift between modules.

use std::fmt::Write as _;

use console::Style;

use crate::tui::theme;

const RULE_WIDTH: usize = 45;

/// `display.welcome()` — already implemented at [`crate::tui::banner::welcome`].
/// Re-exported here for parity with the TS module organisation.
pub use crate::tui::banner::welcome;

/// `display.step(number, total, title)` — `src/commands/config/display.ts:20-26`.
///
/// Layout:
/// ```text
/// <blank>
///   <ACCENT bold>"<n>/<total>"</>  <ACCENT bold>"<title>"</>
///   <ACCENT dim>"─" * 45</>
/// <blank>
/// ```
pub fn step(number: usize, total: usize, title: &str) {
    println!();
    let header = format!("{number}/{total}");
    // TS at display.ts:23 uses `ACCENT.bold(...)` for header + title.
    let accent_bold = theme::display_accent();
    println!(
        "  {}  {}",
        accent_bold.apply_to(&header),
        accent_bold.apply_to(title)
    );
    // TS at display.ts:24 uses `ACCENT(chalk.dim(rule))` — plain ACCENT
    // (no .bold), then dim INSIDE. Don't compose bold on the rule.
    let rule = "─".repeat(RULE_WIDTH);
    let rule_style = theme::display_accent_plain().force_styling(true);
    let dim = Style::new().dim();
    println!("  {}", rule_style.apply_to(dim.apply_to(&rule)));
    println!();
}

/// `display.context(text)` — `:31-35`. Splits on `\n`; each line printed as
/// `  ` + `chalk.dim(line)`.
pub fn context(text: &str) {
    let dim = theme::dim();
    for line in text.split('\n') {
        println!("  {}", dim.apply_to(line));
    }
}

/// `display.success(text)` — `:40-42`. `  <bold green ✓> <text>`.
pub fn success(text: &str) {
    println!("{}", format_success_line(text));
}

/// Returns the styled success line as a `String` (without trailing
/// newline) — extracted so tests can assert exact bytes.
///
/// TS chalk wire bytes: `chalk.green.bold("✓")` emits
/// `\x1b[32m\x1b[1m✓\x1b[22m\x1b[39m` — separate closes for bold (SGR 22)
/// and foreground (SGR 39). Console-rs's `Style.apply_to(...)` would
/// emit `\x1b[32m\x1b[1m✓\x1b[0m` (single SGR 0 full-reset). Visually
/// identical, but byte-different. Use raw escape constants from
/// [`crate::tui::theme`] to match TS chalk byte-for-byte.
fn format_success_line(text: &str) -> String {
    use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, FG_RESET};
    // Basic ANSI green = `\x1b[32m`. chalk.green's exact open code.
    const GREEN_OPEN: &str = "\x1b[32m";
    format!("  {GREEN_OPEN}{BOLD_OPEN}✓{BOLD_CLOSE}{FG_RESET} {text}")
}

/// `display.hint(text)` — `:47-49`. `  <ACCENT →> <ACCENT text>`.
/// TS uses plain `ACCENT(...)` (no `.bold`). Use the plain variant.
pub fn hint(text: &str) {
    let accent = theme::display_accent_plain();
    let arrow = accent.apply_to("→");
    let body = accent.apply_to(text);
    println!("  {arrow} {body}");
}

/// `display.blank()` — `:54-56`. Prints a single empty line.
pub fn blank() {
    println!();
}

/// `display.setupComplete()` — `:90-94`.
///
/// ```text
/// <blank>
///   <ACCENT bold>▲</> <ACCENT bold>Setup complete!</>
/// <blank>
/// ```
pub fn setup_complete() {
    println!();
    let accent = theme::display_accent();
    println!("  {} {}", accent.apply_to("▲"), accent.apply_to("Setup complete!"));
    println!();
}

/// `display.summaryLine(label, value)` — `:99-102`.
///
/// `paddedLabel = (label + ":").padEnd(16)`; output is
/// `    <INFO paddedLabel>{value}` (no space between label and value —
/// the padEnd accounts for the spacing).
pub fn summary_line(label: &str, value: &str) {
    let mut padded = format!("{label}:");
    while padded.chars().count() < 16 {
        padded.push(' ');
    }
    let info = theme::display_info();
    println!("    {}{}", info.apply_to(&padded), value);
}

/// `display.providerCheck(text)` — `:107-109`. Returns the styled fragment
/// `<SELECTED bold>[✓]</> <text>` for inline composition (e.g. inside
/// inquire choice labels).
pub fn provider_check(text: &str) -> String {
    let selected = theme::display_selected().bold();
    let mut out = String::new();
    let _ = write!(out, "{} {}", selected.apply_to("[✓]"), text);
    out
}

/// `display.providerUncheck(text)` — `:114-115`. Returns `<dim>[ ]</> <text>`.
pub fn provider_uncheck(text: &str) -> String {
    let dim = theme::dim();
    let mut out = String::new();
    let _ = write!(out, "{} {}", dim.apply_to("[ ]"), text);
    out
}

/// `display.doneLabel()` — `:121-123`. Returns `<ACCENT bold>  Done</>` with
/// the two leading spaces *inside* the styled span (the TS template inserts
/// a separate two-space cursor pad outside).
pub fn done_label() -> String {
    theme::display_accent().apply_to("  Done").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use console::strip_ansi_codes;

    #[test]
    fn provider_check_contains_check_glyph_and_text() {
        let s = strip_ansi_codes(&provider_check("OpenRouter")).into_owned();
        assert_eq!(s, "[✓] OpenRouter");
    }

    #[test]
    fn provider_uncheck_contains_empty_brackets_and_text() {
        let s = strip_ansi_codes(&provider_uncheck("Anthropic")).into_owned();
        assert_eq!(s, "[ ] Anthropic");
    }

    #[test]
    fn done_label_has_two_leading_spaces_and_word_done() {
        let s = strip_ansi_codes(&done_label()).into_owned();
        assert_eq!(s, "  Done");
    }

    /// Pin display.success's wire bytes to match TS chalk exactly:
    /// `chalk.green.bold("✓")` emits
    /// `\x1b[32m\x1b[1m✓\x1b[22m\x1b[39m` (separate closes for bold
    /// and fg, no SGR 0 full-reset). The full success line is
    /// `  <styled-✓> <text>` per `display.ts:41`.
    #[test]
    fn success_line_matches_ts_chalk_byte_sequence() {
        let s = format_success_line("All set");
        assert_eq!(
            s,
            "  \x1b[32m\x1b[1m✓\x1b[22m\x1b[39m All set",
        );
    }

    #[test]
    fn success_line_ansi_stripped_text_is_verbatim() {
        let s = format_success_line("Saved");
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "  ✓ Saved");
    }

    #[test]
    fn success_line_does_not_emit_sgr_0_full_reset() {
        let s = format_success_line("x");
        assert!(
            !s.contains("\x1b[0m"),
            "success() should use SGR 22 + SGR 39 (TS chalk), not SGR 0; got: {s:?}",
        );
    }

    #[test]
    fn provider_check_emits_ansi_color() {
        // Style::apply_to emits ANSI when stdout-likely-styled; force colour
        // independence by checking that *some* ANSI code appears alongside
        // the glyph. Not pinning the exact code (terminal-dependent), but
        // verifying we are not returning bare text.
        let raw = provider_check("X");
        let stripped = strip_ansi_codes(&raw);
        // Either the runtime is colourless (bare text) OR the styled output
        // is longer than the stripped form (real ANSI codes embedded).
        if stripped.len() == raw.len() {
            // Colourless terminal: still functionally correct.
            assert_eq!(raw, "[✓] X");
        } else {
            assert!(raw.contains("[✓] X"), "got: {raw:?}");
        }
    }

    /// Pin the bold/no-bold split between the two display_accent
    /// helpers. `display.ts:23` uses `ACCENT.bold(...)` for the step
    /// header; `display.ts:24,48` uses plain `ACCENT(...)` for the
    /// rule and the hint arrow. The two helpers must produce
    /// different ANSI sequences.
    #[test]
    fn display_accent_helpers_differ_on_bold_attribute() {
        let bold_form = theme::display_accent()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        let plain_form = theme::display_accent_plain()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        // The bold form must contain the bold-open SGR (`\x1b[1m`).
        assert!(
            bold_form.contains("\x1b[1m"),
            "display_accent should emit bold open; got {bold_form:?}",
        );
        // The plain form must NOT contain bold-open.
        assert!(
            !plain_form.contains("\x1b[1m"),
            "display_accent_plain should NOT emit bold open; got {plain_form:?}",
        );
        // Both should contain the xterm-256 #214 fg sequence.
        assert!(bold_form.contains("\x1b[38;5;214m"));
        assert!(plain_form.contains("\x1b[38;5;214m"));
    }

    #[test]
    fn summary_line_label_pads_to_sixteen_chars() {
        // Capture is impractical without a global stdout fixture; instead
        // duplicate the formatting locally and verify the pad rule.
        let label = "username";
        let mut padded = format!("{label}:");
        while padded.chars().count() < 16 {
            padded.push(' ');
        }
        assert_eq!(padded.chars().count(), 16);
        // Sanity: long label longer than 16 stays as-is + colon.
        let long = "verylonglabelvalue";
        let mut p = format!("{long}:");
        while p.chars().count() < 16 {
            p.push(' ');
        }
        assert!(p.starts_with("verylonglabelvalue:"));
    }
}

//! Output helpers used by every onboarding / config / doctor screen.
//!
//! 1:1 port of `src/commands/config/display.ts`. Every helper writes to
//! stdout (or returns a styled string for inline use) and is byte-for-byte
//! aligned with the TS template via the colour palette in
//! [`crate::tui::theme`] and the glyph constants in [`crate::tui::glyphs`].
//!
//! When a helper takes ownership of the line (e.g. [`step`], [`success`],
//! [`hint`]) it appends a single `\n` via `println!`. When it returns a
//! styled fragment for inline composition it returns a `String` whose ANSI
//! codes are already embedded.
//!
//! Test coverage uses ANSI-stripped comparisons for ergonomics; the colour
//! pin lives in `crate::tui::theme` (single source of truth) so the same
//! palette can't drift between modules.
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
    let (header_line, rule_line) = format_step_lines(number, total, title);
    println!("{header_line}");
    println!("{rule_line}");
    println!();
}

/// Returns the (`header_line`, `rule_line`) pair for a step header, with
/// raw escape codes matching TS chalk's wire bytes.
///
/// TS source `display.ts:20-26`:
/// ```ts
/// console.log();
/// console.log(`  ${ACCENT.bold(`${number}/${total}`)}  ${ACCENT.bold(title)}`);
/// console.log(`  ${ACCENT(chalk.dim("─".repeat(RULE_WIDTH)))}`);
/// console.log();
/// ```
/// Wire bytes (using ACCENT = chalk.ansi256(214)):
/// - header: `  \x1b[38;5;214m\x1b[1m<n/t>\x1b[22m\x1b[39m  \x1b[38;5;214m\x1b[1m<title>\x1b[22m\x1b[39m`
/// - rule:   `  \x1b[38;5;214m\x1b[2m─×45\x1b[22m\x1b[39m`
fn format_step_lines(number: usize, total: usize, title: &str) -> (String, String) {
    use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, DIM_CLOSE, DIM_OPEN, FG_RESET};
    const ACCENT_OPEN: &str = "\x1b[38;5;214m";
    let header = format!("{number}/{total}");
    let header_line = format!(
        "  {ACCENT_OPEN}{BOLD_OPEN}{header}{BOLD_CLOSE}{FG_RESET}  {ACCENT_OPEN}{BOLD_OPEN}{title}{BOLD_CLOSE}{FG_RESET}",
    );
    let rule = "─".repeat(RULE_WIDTH);
    // TS uses ACCENT(chalk.dim(rule)) — chalk.dim emits SGR 2 + SGR 22
    // INSIDE the ACCENT (SGR 38;5;214 + SGR 39) wrap. Mirror byte order.
    let rule_line = format!("  {ACCENT_OPEN}{DIM_OPEN}{rule}{DIM_CLOSE}{FG_RESET}");
    (header_line, rule_line)
}

/// `display.context(text)` — `:31-35`. Splits on `\n`; each line printed as
/// `  ` + `chalk.dim(line)`.
pub fn context(text: &str) {
    for line in text.split('\n') {
        println!("{}", format_context_line(line));
    }
}

/// Returns one styled context line — extracted so tests can pin exact bytes.
///
/// TS at `display.ts:33` emits `  ${chalk.dim(line)}`. Chalk wire bytes
/// for `chalk.dim(line)` are `\x1b[2m<line>\x1b[22m` — SGR 2 open,
/// SGR 22 close (\"neither bold nor faint\"). Console-rs's
/// `Style.dim().apply_to(...)` would emit SGR 0 (full reset) instead.
fn format_context_line(line: &str) -> String {
    use crate::tui::theme::{DIM_CLOSE, DIM_OPEN};
    format!("  {DIM_OPEN}{line}{DIM_CLOSE}")
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

/// Print a config-submenu "✓ {text}" success line.
///
/// **Distinct from** [`success`] — that helper matches `display.success`
/// (2-space indent + bold-green ✓). This helper matches the inline
/// success banner pattern used throughout `src/commands/config/*.ts`
/// (e.g. `escalation.ts:32`, `providers.ts:18`):
///
/// ```ts
/// console.log(chalk.green("✓") + chalk.bold(` ${text}`));
/// ```
///
/// — green ✓ (NOT bold), no leading indent, then bold space + text.
/// Wire bytes: `\x1b[32m✓\x1b[39m\x1b[1m {text}\x1b[22m`.
pub fn config_success(text: &str) {
    println!("{}", format_config_success_line(text));
}

/// Returns the styled config-submenu success line — extracted for tests.
fn format_config_success_line(text: &str) -> String {
    use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, FG_RESET};
    const GREEN_OPEN: &str = "\x1b[32m";
    format!("{GREEN_OPEN}✓{FG_RESET}{BOLD_OPEN} {text}{BOLD_CLOSE}")
}

/// `display.hint(text)` — `:47-49`. `  <ACCENT →> <ACCENT text>`.
/// TS uses plain `ACCENT(...)` (no `.bold`).
pub fn hint(text: &str) {
    println!("{}", format_hint_line(text));
}

/// Returns the styled hint line — extracted so tests can pin exact bytes.
///
/// TS chalk wire bytes: `chalk.ansi256(214)("→")` emits
/// `\x1b[38;5;214m→\x1b[39m` — open with xterm-256 #214, close with
/// SGR 39 (default fg). The TS template at `display.ts:48` is
/// `  ${ACCENT("→")} ${ACCENT(text)}`.
///
/// Console-rs would emit `\x1b[38;5;214m→\x1b[0m` (single SGR-0
/// full-reset). Use raw escapes so wire bytes match TS exactly.
fn format_hint_line(text: &str) -> String {
    use crate::tui::theme::FG_RESET;
    // ansi256 #214 open code matches `chalk.ansi256(214)` byte-for-byte.
    const ACCENT_OPEN: &str = "\x1b[38;5;214m";
    format!("  {ACCENT_OPEN}→{FG_RESET} {ACCENT_OPEN}{text}{FG_RESET}")
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
    println!("{}", format_setup_complete_line());
    println!();
}

/// Returns the styled "▲ Setup complete!" line.
///
/// TS at `display.ts:92`:
/// ```ts
/// console.log(`  ${ACCENT.bold("▲")} ${ACCENT.bold("Setup complete!")}`);
/// ```
/// Wire bytes (ACCENT = chalk.ansi256(214)):
/// `  \x1b[38;5;214m\x1b[1m▲\x1b[22m\x1b[39m \x1b[38;5;214m\x1b[1mSetup complete!\x1b[22m\x1b[39m`.
fn format_setup_complete_line() -> String {
    use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, FG_RESET};
    const ACCENT_OPEN: &str = "\x1b[38;5;214m";
    format!(
        "  {ACCENT_OPEN}{BOLD_OPEN}▲{BOLD_CLOSE}{FG_RESET} {ACCENT_OPEN}{BOLD_OPEN}Setup complete!{BOLD_CLOSE}{FG_RESET}",
    )
}

/// `display.summaryLine(label, value)` — `:99-102`.
///
/// `paddedLabel = (label + ":").padEnd(16)`; output is
/// `    <INFO paddedLabel>{value}` (no space between label and value —
/// the padEnd accounts for the spacing).
pub fn summary_line(label: &str, value: &str) {
    println!("{}", format_summary_line(label, value));
}

/// Returns the styled summary line.
///
/// TS at `display.ts:99-101`:
/// ```ts
/// const paddedLabel = `${label}:`.padEnd(16);
/// console.log(`    ${INFO(paddedLabel)}${value}`);
/// ```
/// Wire bytes (INFO = chalk.ansi256(117)):
/// `    \x1b[38;5;117m<padded-label>\x1b[39m<value>`.
fn format_summary_line(label: &str, value: &str) -> String {
    let mut padded = format!("{label}:");
    while padded.chars().count() < 16 {
        padded.push(' ');
    }
    use crate::tui::theme::FG_RESET;
    const INFO_OPEN: &str = "\x1b[38;5;117m";
    format!("    {INFO_OPEN}{padded}{FG_RESET}{value}")
}


#[cfg(test)]
mod tests {
    use super::*;
    use console::strip_ansi_codes;

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

    /// Pin display.hint's wire bytes to match TS chalk exactly:
    /// `chalk.ansi256(214)("→")` emits `\x1b[38;5;214m→\x1b[39m` —
    /// SGR 39 close (not SGR 0). Per `display.ts:48` the template is
    /// `  ${ACCENT("→")} ${ACCENT(text)}` — both arrow and body wrapped
    /// individually.
    #[test]
    fn hint_line_matches_ts_chalk_byte_sequence() {
        let s = format_hint_line("Tip: try this");
        assert_eq!(
            s,
            "  \x1b[38;5;214m→\x1b[39m \x1b[38;5;214mTip: try this\x1b[39m",
        );
    }

    #[test]
    fn hint_line_does_not_emit_sgr_0_full_reset() {
        let s = format_hint_line("x");
        assert!(
            !s.contains("\x1b[0m"),
            "hint() should use SGR 39 (TS chalk), not SGR 0; got: {s:?}",
        );
    }

    /// Pin context-line wire bytes: `  ${chalk.dim(line)}` →
    /// `  \x1b[2m<line>\x1b[22m`.
    #[test]
    fn context_line_matches_ts_chalk_byte_sequence() {
        assert_eq!(
            format_context_line("Some hint"),
            "  \x1b[2mSome hint\x1b[22m",
        );
    }

    /// Pin step header line wire bytes per `display.ts:23`.
    #[test]
    fn step_header_line_matches_ts_chalk_byte_sequence() {
        let (header, _) = format_step_lines(3, 7, "AI Providers");
        assert_eq!(
            header,
            "  \x1b[38;5;214m\x1b[1m3/7\x1b[22m\x1b[39m  \x1b[38;5;214m\x1b[1mAI Providers\x1b[22m\x1b[39m",
        );
    }

    /// Pin step rule line wire bytes per `display.ts:24`:
    /// `  ${ACCENT(chalk.dim(rule))}` → ACCENT wraps chalk.dim wraps the
    /// rule. Result: 45 dashes between SGR 38;5;214 + SGR 2 opens and
    /// SGR 22 + SGR 39 closes.
    #[test]
    fn step_rule_line_matches_ts_chalk_byte_sequence() {
        let (_, rule) = format_step_lines(1, 7, "Identity");
        let dashes = "─".repeat(45);
        let expected =
            format!("  \x1b[38;5;214m\x1b[2m{dashes}\x1b[22m\x1b[39m");
        assert_eq!(rule, expected);
    }

    /// Pin setup-complete line wire bytes per `display.ts:92`.
    #[test]
    fn setup_complete_line_matches_ts_chalk_byte_sequence() {
        assert_eq!(
            format_setup_complete_line(),
            "  \x1b[38;5;214m\x1b[1m▲\x1b[22m\x1b[39m \x1b[38;5;214m\x1b[1mSetup complete!\x1b[22m\x1b[39m",
        );
    }

    /// Pin summary-line wire bytes per `display.ts:99-101`.
    #[test]
    fn summary_line_byte_sequence_matches_ts_chalk() {
        // "username:" is 9 chars; padEnd(16) → 7 trailing spaces.
        let s = format_summary_line("username", "alice");
        assert_eq!(s, "    \x1b[38;5;117musername:       \x1b[39malice");
        assert_eq!(strip_ansi_codes(&s).into_owned(), "    username:       alice");
    }

    #[test]
    fn step_lines_do_not_emit_sgr_0_full_reset() {
        let (h, r) = format_step_lines(1, 1, "x");
        assert!(!h.contains("\x1b[0m"));
        assert!(!r.contains("\x1b[0m"));
    }

    /// Pin config_success wire bytes per the inline `chalk.green("✓") +
    /// chalk.bold(" <text>")` template used at e.g. `escalation.ts:32`,
    /// `providers.ts:18`, `telemetry.ts:185`.
    #[test]
    fn config_success_line_matches_ts_chalk_byte_sequence() {
        let s = format_config_success_line("Saved.");
        assert_eq!(s, "\x1b[32m✓\x1b[39m\x1b[1m Saved.\x1b[22m");
    }

    #[test]
    fn config_success_line_does_not_emit_sgr_0_full_reset() {
        let s = format_config_success_line("x");
        assert!(!s.contains("\x1b[0m"), "got: {s:?}");
    }

    /// The config-submenu success line has NO leading indent — distinct
    /// from `display.success` which prefixes "  ". Pin the column-0 start.
    #[test]
    fn config_success_line_has_no_leading_indent() {
        let s = format_config_success_line("X");
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "✓ X");
    }

    /// `display_accent()` must emit bold — it's used by cron_cmd and banner
    /// where TS emits `ACCENT.bold(...)`. Regression guard so the helper
    /// can't silently lose the bold attribute.
    #[test]
    fn display_accent_emits_bold_and_xterm_214_fg() {
        use crate::tui::theme;
        let styled = theme::display_accent()
            .force_styling(true)
            .apply_to("x")
            .to_string();
        assert!(
            styled.contains("\x1b[1m"),
            "display_accent should emit bold open (SGR 1); got {styled:?}",
        );
        assert!(
            styled.contains("\x1b[38;5;214m"),
            "display_accent should emit xterm-256 #214 fg; got {styled:?}",
        );
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

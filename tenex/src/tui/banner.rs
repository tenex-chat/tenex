//! TENEX welcome banner: 5-row stippled Sierpinski triangle with a four-shade
//! orange gradient and the `T E N E X` accent letters / tagline lines.
//!
//! Source of truth: `src/commands/config/display.ts:63-85` (function
//! `welcome()`). Reproduce byte-for-byte. See `docs/tui-port/12-visual-styling.md`
//! §3 for spacing notes.
//!
//! Wire bytes: each non-space dot is `<color-open><bold-open>{ch}<bold-close><fg-reset>`
//! matching TS chalk's `color.bold(ch)` exactly. The trailing letter row,
//! tagline, and setup-hint use the same `<open>...<close>` pattern.

use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, DIM_CLOSE, DIM_OPEN, FG_RESET};

// Raw open codes for each row's xterm-256 colour. Match TS chalk
// `chalk.ansi256(N)` byte-for-byte: `\x1b[38;5;{N}m`.
const GLOW_OPEN: &str = "\x1b[38;5;222m"; // banner row 0
const BRIGHT_OPEN: &str = "\x1b[38;5;220m"; // banner row 1
const ACCENT_OPEN: &str = "\x1b[38;5;214m"; // banner row 2 / brand accent
const MID_OPEN: &str = "\x1b[38;5;172m"; // banner row 3
const DARK_OPEN: &str = "\x1b[38;5;130m"; // banner row 4

/// Print the welcome banner to stdout. Called at the start of `tenex onboard`
/// and `tenex config` (interactive mode).
pub fn welcome() {
    let rows: [(&str, &str); 5] = [
        ("       •       ", GLOW_OPEN),
        ("      • •      ", BRIGHT_OPEN),
        ("    •     •    ", ACCENT_OPEN),
        ("   • • • • •   ", MID_OPEN),
        ("  • • • • • •  ", DARK_OPEN),
    ];

    println!();
    for (idx, (line, color_open)) in rows.iter().enumerate() {
        let mut row = String::from("  "); // 2-space left margin
        for ch in line.chars() {
            if ch == ' ' {
                row.push(' ');
            } else {
                // chalk's `color.bold(ch)` wire bytes:
                //   <color-open><bold-open><ch><bold-close><fg-reset>
                row.push_str(&format!(
                    "{color_open}{BOLD_OPEN}{ch}{BOLD_CLOSE}{FG_RESET}",
                ));
            }
        }
        match idx {
            // ACCENT.bold("T E N E X")
            2 => row.push_str(&format!(
                "  {ACCENT_OPEN}{BOLD_OPEN}T E N E X{BOLD_CLOSE}{FG_RESET}",
            )),
            // chalk.bold("Your AI agent team, powered by Nostr.") — no fg.
            3 => row.push_str(&format!(
                "  {BOLD_OPEN}Your AI agent team, powered by Nostr.{BOLD_CLOSE}",
            )),
            // chalk.dim("Let's get everything set up.") — no fg.
            4 => row.push_str(&format!(
                "  {DIM_OPEN}Let's get everything set up.{DIM_CLOSE}",
            )),
            _ => {}
        }
        println!("{row}");
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::theme;

    /// Pin the banner's per-dot wire bytes to chalk's
    /// `<color-open><bold-open>{ch}<bold-close><fg-reset>` template.
    /// Build the row-2 (ACCENT) sequence by hand and assert equality.
    #[test]
    fn each_dot_emits_color_bold_per_attribute_close_no_sgr_0() {
        // Row 2 is the ACCENT row with two dots — `\x1b[38;5;214m`.
        // Plain spaces between/around them stay unstyled.
        let one_dot = format!(
            "{ACCENT_OPEN}{BOLD_OPEN}•{BOLD_CLOSE}{FG_RESET}",
        );
        // Each chunk should contain SGR 22 + SGR 39 closes, never SGR 0.
        assert!(one_dot.contains("\x1b[38;5;214m"));
        assert!(one_dot.contains("\x1b[1m"));
        assert!(one_dot.contains("\x1b[22m"));
        assert!(one_dot.contains("\x1b[39m"));
        assert!(!one_dot.contains("\x1b[0m"));
    }

    /// Pin the five row-colour open codes to the xterm-256 indices in
    /// `display.ts:3-12`.
    #[test]
    fn row_color_open_codes_match_ts_chalk_ansi256() {
        assert_eq!(GLOW_OPEN, "\x1b[38;5;222m");
        assert_eq!(BRIGHT_OPEN, "\x1b[38;5;220m");
        assert_eq!(ACCENT_OPEN, "\x1b[38;5;214m");
        assert_eq!(MID_OPEN, "\x1b[38;5;172m");
        assert_eq!(DARK_OPEN, "\x1b[38;5;130m");
    }

    /// Pin the row-2 trailing chunk to TS `ACCENT.bold("T E N E X")`'s
    /// wire bytes.
    #[test]
    fn brand_letters_match_ts_accent_bold_byte_sequence() {
        let chunk = format!(
            "{ACCENT_OPEN}{BOLD_OPEN}T E N E X{BOLD_CLOSE}{FG_RESET}",
        );
        assert_eq!(chunk, "\x1b[38;5;214m\x1b[1mT E N E X\x1b[22m\x1b[39m");
        assert!(!chunk.contains("\x1b[0m"));
    }

    /// Pin the tagline to TS `chalk.bold(...)`'s wire bytes (no fg).
    #[test]
    fn tagline_matches_ts_chalk_bold_byte_sequence() {
        let chunk = theme::chalk_bold("Your AI agent team, powered by Nostr.");
        assert_eq!(
            chunk,
            "\x1b[1mYour AI agent team, powered by Nostr.\x1b[22m",
        );
    }

    /// Pin the setup-hint to TS `chalk.dim(...)`'s wire bytes (no fg).
    #[test]
    fn setup_hint_matches_ts_chalk_dim_byte_sequence() {
        let chunk = theme::chalk_dim("Let's get everything set up.");
        assert_eq!(chunk, "\x1b[2mLet's get everything set up.\x1b[22m");
    }
}

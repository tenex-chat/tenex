//! Shared helper for the bold-key / dim-label help row used by every
//! bespoke prompt that ports a `chalk.dim(`  ${parts.join(chalk.dim(" • "))}`)`
//! footer.
//!
//! The TS sources (`LLMConfigEditor.ts:164-170`,
//! `provider-select-prompt.ts:247-252` + `:279-285`,
//! `variant-list-prompt.ts:148-154`) all build help lines as
//!
//! ```ts
//! const parts = [`${chalk.bold(key)} ${chalk.dim(label)}`, …];
//! lines.push(chalk.dim(`  ${parts.join(chalk.dim(" • "))}`));
//! ```
//!
//! Chalk's `bold` and `dim` close-codes are both SGR-22 (the single
//! "neither bold nor faint" reset). Each `chalk.bold(key)` closes with
//! `\x1b[22m`, which resets bold *and* dim — so the visual is keys
//! plain-bold, labels dim, with the outer `chalk.dim(...)` wrap reduced
//! to a no-op once the per-part closes have fired.
//!
//! Mirror that exactly: print 2-space indent, then for each `(key, label)`
//! emit `<bold>key</> <dim>label</>` with `<dim> • </>` separators between
//! parts, terminated by `\r\n`. The whole row consumes one terminal row.

use std::io::{self, Write};

use crossterm::queue;
use crossterm::style::{Attribute, Print, SetAttribute};

/// Render `  <bold key₀> <dim label₀> • <bold key₁> <dim label₁> • …\r\n`.
///
/// Caller is responsible for flushing.
pub fn render_help_row<W: Write>(stdout: &mut W, parts: &[(&str, &str)]) -> io::Result<()> {
    queue!(stdout, Print("  "))?;
    for (i, (key, label)) in parts.iter().enumerate() {
        if i > 0 {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(" • "),
                SetAttribute(Attribute::Reset),
            )?;
        }
        queue!(
            stdout,
            SetAttribute(Attribute::Bold),
            Print(*key),
            SetAttribute(Attribute::Reset),
            Print(" "),
            SetAttribute(Attribute::Dim),
            Print(*label),
            SetAttribute(Attribute::Reset),
        )?;
    }
    queue!(stdout, Print("\r\n"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use console::strip_ansi_codes;

    #[test]
    fn ansi_stripped_text_matches_ts_help_string_for_llm_menu() {
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(
            &mut buf,
            &[
                ("↑↓", "navigate"),
                ("⏎", "select"),
                ("t", "test"),
                ("d", "delete"),
            ],
        )
        .unwrap();
        let s = String::from_utf8(buf).unwrap();
        let plain = strip_ansi_codes(&s).into_owned();
        // Note: rendered row terminates with `\r\n` (CRLF) — keep the
        // `\r\n` in the assertion so trailing whitespace doesn't drift.
        assert_eq!(
            plain,
            "  ↑↓ navigate • ⏎ select • t test • d delete\r\n"
        );
    }

    #[test]
    fn embeds_ansi_bold_and_dim_codes() {
        // SGR 1 = bold (chalk.bold opens), SGR 2 = dim (chalk.dim opens).
        // After each bold/dim we close with crossterm's Attribute::Reset
        // which emits SGR 0 (full reset). The TS source uses SGR 22
        // ("neither bold nor faint"); SGR 0 is a strict superset and
        // produces visually identical output for this pure-text row.
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(&mut buf, &[("↑↓", "navigate")]).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\x1b[1m"), "bold open missing: {s:?}");
        assert!(s.contains("\x1b[2m"), "dim open missing: {s:?}");
    }

    #[test]
    fn empty_parts_emits_just_indent_and_crlf() {
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(&mut buf, &[]).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "  \r\n");
    }
}

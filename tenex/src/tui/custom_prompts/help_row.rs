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

/// Render `<indent><bold key₀> <dim label₀> • <bold key₁> <dim label₁> • …\r\n`.
///
/// `indent` is emitted as plain text (no styling) before the first part.
/// Bespoke-prompt callers ported from `chalk.dim(\`  ${helpParts.join(...)}\`)`
/// pass `"  "` (two-space indent matching the TS template). Callers
/// porting `@inquirer/select`'s auto-helpLine — which starts at column 0
/// per `@inquirer/select/dist/index.js:148-151` — pass `""`.
///
/// Caller is responsible for flushing.
pub fn render_help_row<W: Write>(
    stdout: &mut W,
    indent: &str,
    parts: &[(&str, &str)],
) -> io::Result<()> {
    if !indent.is_empty() {
        queue!(stdout, Print(indent.to_owned()))?;
    }
    for (i, (key, label)) in parts.iter().enumerate() {
        if i > 0 {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(" • "),
                SetAttribute(Attribute::NormalIntensity),
            )?;
        }
        queue!(
            stdout,
            SetAttribute(Attribute::Bold),
            Print(*key),
            SetAttribute(Attribute::NormalIntensity),
            Print(" "),
            SetAttribute(Attribute::Dim),
            Print(*label),
            SetAttribute(Attribute::NormalIntensity),
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
            "  ",
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
        assert_eq!(plain, "  ↑↓ navigate • ⏎ select • t test • d delete\r\n");
    }

    #[test]
    fn embeds_ansi_bold_and_dim_codes_with_normal_intensity_close() {
        // SGR 1 = bold (chalk.bold opens), SGR 2 = dim (chalk.dim opens).
        // Close codes use crossterm's `Attribute::NormalIntensity` which
        // emits SGR 22 ("neither bold nor faint") — byte-for-byte
        // matching TS chalk's bold/dim close. (Earlier port emitted
        // SGR 0 via `Attribute::Reset`; that produced visually identical
        // output but byte-different from chalk.)
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(&mut buf, "  ", &[("↑↓", "navigate")]).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\x1b[1m"), "bold open missing: {s:?}");
        assert!(s.contains("\x1b[2m"), "dim open missing: {s:?}");
        assert!(s.contains("\x1b[22m"), "SGR 22 close missing: {s:?}");
        assert!(
            !s.contains("\x1b[0m"),
            "SGR 0 (full reset) leaked — should be SGR 22 to match chalk: {s:?}",
        );
    }

    /// `@inquirer/select` auto-helpLine starts at column 0 — no indent.
    #[test]
    fn no_indent_variant_starts_at_column_zero() {
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(&mut buf, "", &[("↑↓", "navigate"), ("⏎", "select")]).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "↑↓ navigate • ⏎ select\r\n");
    }

    #[test]
    fn empty_parts_emits_just_indent_and_crlf() {
        let mut buf: Vec<u8> = Vec::new();
        render_help_row(&mut buf, "  ", &[]).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "  \r\n");
    }
}

//! TENEX welcome banner: 5-row stippled Sierpinski triangle with a four-shade
//! orange gradient and the `T E N E X` accent letters / tagline lines.
//!
//! Source of truth: `src/commands/config/display.ts:63-85` (function
//! `welcome()`). Reproduce byte-for-byte. See `docs/tui-port/12-visual-styling.md`
//! §3 for spacing notes.

use crate::tui::theme;

/// Print the welcome banner to stdout. Called at the start of `tenex onboard`
/// and `tenex config` (interactive mode).
pub fn welcome() {
    // Each tuple is (row chars, row color) where row chars are stippled with
    // U+2022 dots interleaved with spaces. Spaces remain plain; dots get the
    // row colour applied (bold) per character.
    let rows: [(&str, fn() -> console::Style); 5] = [
        ("       •       ", theme::banner_glow),
        ("      • •      ", theme::banner_bright),
        ("    •     •    ", theme::display_accent),
        ("   • • • • •   ", theme::banner_mid),
        ("  • • • • • •  ", theme::banner_dark),
    ];

    println!();
    for (idx, (line, style_fn)) in rows.iter().enumerate() {
        let style = style_fn();
        let mut row = String::from("  "); // 2-space left margin
        for ch in line.chars() {
            if ch == ' ' {
                row.push(' ');
            } else {
                row.push_str(&style.apply_to(ch).to_string());
            }
        }
        match idx {
            2 => row.push_str(&format!(
                "  {}",
                theme::display_accent().apply_to("T E N E X")
            )),
            3 => row.push_str(&format!(
                "  {}",
                theme::bold().apply_to("Your AI agent team, powered by Nostr.")
            )),
            4 => row.push_str(&format!(
                "  {}",
                theme::dim().apply_to("Let's get everything set up.")
            )),
            _ => {}
        }
        println!("{row}");
    }
    println!();
}

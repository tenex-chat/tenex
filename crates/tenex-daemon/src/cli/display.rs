use dialoguer::console::{Style, style};
use dialoguer::theme::ColorfulTheme;

// Match TypeScript display.ts xterm-256 palette exactly
fn accent() -> Style {
    Style::new().color256(214).bold()
} // amber
fn info() -> Style {
    Style::new().color256(117)
} // sky blue
fn glow() -> Style {
    Style::new().color256(222).bold()
} // brightest
fn bright() -> Style {
    Style::new().color256(220).bold()
} // bright amber
fn mid() -> Style {
    Style::new().color256(172).bold()
} // mid amber
fn dark() -> Style {
    Style::new().color256(130).bold()
} // dark amber

pub fn welcome() {
    // Sierpinski triangle matching TypeScript display.ts exactly
    struct Row {
        chars: &'static str,
        style_fn: fn() -> Style,
    }
    let rows: &[Row] = &[
        Row {
            chars: "       •       ",
            style_fn: glow,
        },
        Row {
            chars: "      • •      ",
            style_fn: bright,
        },
        Row {
            chars: "    •     •    ",
            style_fn: accent,
        },
        Row {
            chars: "   • • • • •   ",
            style_fn: mid,
        },
        Row {
            chars: "  • • • • • •  ",
            style_fn: dark,
        },
    ];

    println!();
    for (i, row) in rows.iter().enumerate() {
        let s = (row.style_fn)();
        let colored: String = row
            .chars
            .chars()
            .map(|c| {
                if c == ' ' {
                    " ".to_string()
                } else {
                    s.apply_to(c).to_string()
                }
            })
            .collect();
        let suffix = match i {
            2 => format!("  {}", accent().apply_to("T E N E X")),
            3 => format!(
                "  {}",
                style("Your AI agent team, powered by Nostr.").bold()
            ),
            4 => format!("  {}", style("Let's get everything set up.").dim()),
            _ => String::new(),
        };
        println!("  {colored}{suffix}");
    }
    println!();
}

pub fn step(n: usize, total: usize, label: &str) {
    let rule = "─".repeat(45);
    println!();
    println!(
        "  {}  {}",
        accent().apply_to(format!("{n}/{total}")),
        accent().apply_to(label)
    );
    println!("  {}", style(&rule).color256(214).dim());
    println!();
}

pub fn success(msg: &str) {
    println!("  {}  {}", style("✓").green().bold(), msg);
}

pub fn hint(msg: &str) {
    println!("  {}  {}", accent().apply_to("→"), accent().apply_to(msg));
}

pub fn context(msg: &str) {
    for line in msg.lines() {
        println!("  {}", style(line).dim());
    }
}

pub fn blank() {
    println!();
}

pub fn summary_line(label: &str, value: &str) {
    let padded = format!("{label}:").to_string();
    let padded = format!("{padded:<16}");
    println!("    {}  {}", info().apply_to(padded), style(value).bold());
}

pub fn setup_complete() {
    println!();
    println!(
        "  {}  {}",
        accent().apply_to("▲"),
        accent().apply_to("Setup complete!")
    );
    println!();
}

pub fn done_label() -> String {
    accent().apply_to("  Done").to_string()
}

pub fn amber_theme() -> ColorfulTheme {
    ColorfulTheme {
        defaults_style: Style::new().for_stderr().color256(214).dim(),
        prompt_style: Style::new().for_stderr().bold(),
        prompt_prefix: style("?".to_string()).for_stderr().color256(214).bold(),
        prompt_suffix: style("›".to_string()).for_stderr().color256(214).dim(),
        success_prefix: style("✔".to_string()).for_stderr().green().bold(),
        success_suffix: style("·".to_string()).for_stderr().dim(),
        error_prefix: style("✘".to_string()).for_stderr().red().bold(),
        error_style: Style::new().for_stderr().red(),
        hint_style: Style::new().for_stderr().color256(214).dim(),
        values_style: Style::new().for_stderr().color256(214).bold(),
        active_item_style: Style::new().for_stderr().color256(214).bold(),
        inactive_item_style: Style::new().for_stderr(),
        active_item_prefix: style("❯".to_string()).for_stderr().color256(214).bold(),
        inactive_item_prefix: style(" ".to_string()).for_stderr(),
        checked_item_prefix: style("✔".to_string()).for_stderr().color256(114).bold(),
        unchecked_item_prefix: style("⬚".to_string()).for_stderr().dim(),
        picked_item_prefix: style("❯".to_string()).for_stderr().color256(214).bold(),
        unpicked_item_prefix: style(" ".to_string()).for_stderr(),
        fuzzy_cursor_style: Style::new().for_stderr().color256(214).bold(),
        fuzzy_match_highlight_style: Style::new().for_stderr().color256(214).bold(),
    }
}

pub fn error(msg: &str) {
    eprintln!("  {}  {}", style("✗").red().bold(), style(msg).red());
}

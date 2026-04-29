//! Section menu — a flat list of selectable entries grouped by dim
//! "── <Header> ──" section dividers, with a final blank separator and
//! a `Back` entry. Used by `tenex config` and any other menu that
//! benefits from visual grouping.
//!
//! Source: `src/commands/config/index.ts:77-125` (`runConfigMenu`),
//! choice-array construction at `:85-100`, theme and glyphs at
//! `:102-110`. Section header rendering matches `:86`:
//! `new inquirer.Separator(chalk.dim("── " + section.header + " ──"))`.
//!
//! Behaviours:
//!
//! - Up/Down skip section-header rows (and the trailing blank separator)
//!   so the cursor only ever lands on selectable items or the `Back` row.
//! - Enter emits `Selected { value }` for entries, or `Back` for the
//!   sentinel last row.
//! - Esc / Ctrl-C → `Cancel` (TS `runConfigMenu` swallows SIGINT silently
//!   per `:131-138`; the Rust caller maps this back to that behaviour).
//! - First render: cursor on the first selectable item — matches inquire's
//!   default behaviour of skipping the leading `Separator`.
//!
//! Cursor is the stock-inquire heavy `❯` in `INQUIRER_AMBER`, so the
//! visual matches `tenex config` exactly even though the Rust render
//! goes through crossterm directly.

use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};

use super::raw_mode::RawMode;
use crate::tui::glyphs;

// Truecolor `#FFC107` — sourced from the canonical
// `crate::tui::theme::INQUIRER_AMBER_CROSSTERM` constant so all bespoke
// prompts share a single source of truth. Local `const` re-export keeps
// existing call sites short.
const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;

/// One selectable menu entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuEntry {
    /// Pre-rendered display label (e.g. `Providers       — API keys and connections`
    /// after the spec's `padEnd(16)` + `"— "` formatting).
    pub label: String,
    /// Returned in `Selected { value }` when activated.
    pub value: String,
}

/// One section with a header and ordered entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuSection {
    pub header: String,
    pub entries: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionMenuOutcome {
    Continue,
    Cancel,
    Back,
    Selected { value: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionMenuInput {
    Up,
    Down,
    Enter,
    Escape,
    CtrlC,
    Other,
}

impl SectionMenuInput {
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL) && matches!(ev.code, KeyCode::Char('c')) {
            return SectionMenuInput::CtrlC;
        }
        match ev.code {
            KeyCode::Up => SectionMenuInput::Up,
            KeyCode::Down => SectionMenuInput::Down,
            KeyCode::Enter => SectionMenuInput::Enter,
            KeyCode::Esc => SectionMenuInput::Escape,
            _ => SectionMenuInput::Other,
        }
    }
}

/// Flattened layout: each row is either a non-selectable header or a
/// selectable entry. The order is
/// `[header_0, entries_0..., header_1, entries_1..., …, BlankSeparator, Back]`.
/// The blank separator before `Back` mirrors `new inquirer.Separator()`
/// (no arg) at `commands/config/index.ts:97` — `@inquirer/core`'s
/// default separator content is
/// `Array.from({ length: 15 }).join(figures.line)` (= 14 `─` chars,
/// wrapped in `chalk.dim`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row<'a> {
    Header(&'a str),
    Entry(&'a MenuEntry),
    /// Non-selectable horizontal-line divider — renders as 14 dim `─`
    /// chars matching `@inquirer/core/Separator.js:8`. Inserted just
    /// before the trailing `Back` row.
    BlankSeparator,
    /// Final selectable row.
    Back,
}

/// Width of the trailing blank separator's dash run, matching
/// `@inquirer/core/Separator.js:8`'s
/// `Array.from({ length: 15 }).join(figures.line)` — a 15-element array
/// joined by 14 separators yields 14 dashes.
pub const BLANK_SEPARATOR_DASHES: usize = 14;

pub fn flatten<'a>(sections: &'a [MenuSection]) -> Vec<Row<'a>> {
    let mut rows = Vec::new();
    for section in sections {
        rows.push(Row::Header(&section.header));
        for entry in &section.entries {
            rows.push(Row::Entry(entry));
        }
    }
    rows.push(Row::BlankSeparator);
    rows.push(Row::Back);
    rows
}

fn is_selectable(row: &Row<'_>) -> bool {
    matches!(row, Row::Entry(_) | Row::Back)
}

/// First selectable index (matches inquire's default cursor placement
/// when the leading row is a non-selectable Separator).
fn first_selectable(rows: &[Row<'_>]) -> usize {
    rows.iter().position(is_selectable).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionMenuState {
    pub active: usize,
}

impl SectionMenuState {
    pub fn new(rows: &[Row<'_>]) -> Self {
        Self {
            active: first_selectable(rows),
        }
    }
}

/// Drive the state machine with one input. Caller has already flattened.
pub fn handle_key(
    state: &mut SectionMenuState,
    rows: &[Row<'_>],
    key: SectionMenuInput,
) -> SectionMenuOutcome {
    if matches!(key, SectionMenuInput::CtrlC | SectionMenuInput::Escape) {
        return SectionMenuOutcome::Cancel;
    }
    if rows.is_empty() {
        return SectionMenuOutcome::Continue;
    }

    match key {
        SectionMenuInput::Up => {
            if let Some(prev) = previous_selectable(rows, state.active) {
                state.active = prev;
            }
            SectionMenuOutcome::Continue
        }
        SectionMenuInput::Down => {
            if let Some(next) = next_selectable(rows, state.active) {
                state.active = next;
            }
            SectionMenuOutcome::Continue
        }
        SectionMenuInput::Enter => match rows.get(state.active) {
            Some(Row::Back) => SectionMenuOutcome::Back,
            Some(Row::Entry(entry)) => SectionMenuOutcome::Selected {
                value: entry.value.clone(),
            },
            _ => SectionMenuOutcome::Continue,
        },
        SectionMenuInput::Other | SectionMenuInput::Escape | SectionMenuInput::CtrlC => {
            SectionMenuOutcome::Continue
        }
    }
}

fn next_selectable(rows: &[Row<'_>], from: usize) -> Option<usize> {
    rows.iter()
        .enumerate()
        .skip(from + 1)
        .find(|(_, r)| is_selectable(r))
        .map(|(i, _)| i)
}

fn previous_selectable(rows: &[Row<'_>], from: usize) -> Option<usize> {
    rows.iter()
        .enumerate()
        .take(from)
        .rev()
        .find(|(_, r)| is_selectable(r))
        .map(|(i, _)| i)
}

/// Compose the rendered lines (unstyled). Section header rendering
/// matches `:86`: `── <header> ──`. Selectable rows are rendered with a
/// cursor `❯` when active, or 2 spaces otherwise. The `Back` row is
/// dimmed with `Back` text per `:100`.
pub fn compose_lines(rows: &[Row<'_>], message: &str, active: usize) -> Vec<String> {
    let cursor_active = format!("{} ", glyphs::CURSOR_HEAVY);

    let mut out = Vec::with_capacity(rows.len() + 2);
    out.push(format!("? {message}"));

    for (i, row) in rows.iter().enumerate() {
        match row {
            // `@inquirer/select/dist/index.js:159` prepends a single space
            // before every separator's content (`return \` ${item.separator}\``)
            // — that's the `separatorCount`'d render path and applies to
            // BOTH custom-content separators (section headers) and the
            // default blank separator. Mirror that single-space prefix.
            Row::Header(h) => out.push(format!(" ── {h} ──")),
            Row::Entry(entry) => {
                let pfx = if i == active {
                    cursor_active.as_str()
                } else {
                    "  "
                };
                out.push(format!("{pfx}{}", entry.label));
            }
            Row::BlankSeparator => {
                out.push(format!(" {}", "─".repeat(BLANK_SEPARATOR_DASHES)));
            }
            Row::Back => {
                let pfx = if i == active {
                    cursor_active.as_str()
                } else {
                    "  "
                };
                out.push(format!("{pfx}Back"));
            }
        }
    }
    out
}

// =========================================================================
// I/O loop
// =========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionMenuResult {
    Selected(String),
    Back,
    Cancelled,
}

/// Run the bespoke prompt to completion.
pub fn section_menu_prompt(
    message: &str,
    sections: &[MenuSection],
) -> io::Result<SectionMenuResult> {
    let _guard = RawMode::enter()?;
    let rows = flatten(sections);
    let mut state = SectionMenuState::new(&rows);
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, message, &rows, state.active, prev_height)?;
        let key = match event::read()? {
            Event::Key(k) => k,
            _ => continue,
        };
        let input = SectionMenuInput::from_key_event(key);
        match handle_key(&mut state, &rows, input) {
            SectionMenuOutcome::Continue => continue,
            SectionMenuOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(SectionMenuResult::Cancelled);
            }
            SectionMenuOutcome::Back => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(SectionMenuResult::Back);
            }
            SectionMenuOutcome::Selected { value } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(SectionMenuResult::Selected(value));
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    rows: &[Row<'_>],
    active: usize,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    // TS at config/index.ts:101-108 calls inquirer.prompt({type:"select", message, ...})
    // which renders the message via @inquirer/core's default
    // `theme.style.message` (`@inquirer/core/dist/lib/theme.js:14` —
    // `styleText('bold', text)`). The TENEX inquirerTheme doesn't
    // override `style.message`, so the message stays bold. Mirror that.
    // TS `inquirerTheme.prefix.idle = chalk.hex("#FFC107")("?")` —
    // closes with SGR 39 (FG default), not SGR 0 (full reset). Use the
    // raw FG_RESET constant for byte-perfect chalk-prefix match.
    queue!(
        stdout,
        SetForegroundColor(AMBER),
        Print("?"),
        Print(crate::tui::theme::FG_RESET)
    )?;
    queue!(
        stdout,
        Print(" "),
        SetAttribute(Attribute::Bold),
        Print(message),
        SetAttribute(Attribute::NormalIntensity),
        Print("\r\n"),
    )?;
    let mut height: u16 = 1;

    let cursor_active = format!("{} ", glyphs::CURSOR_HEAVY);

    for (i, row) in rows.iter().enumerate() {
        match row {
            Row::Header(h) => {
                // `@inquirer/select/dist/index.js:159` prepends a single
                // space before the separator content. The space itself is
                // OUTSIDE the dim wrap (the wrap covers only the
                // chalk.dim'd separator text, not the leading space the
                // select prompt prepends). Mirror byte-for-byte.
                queue!(
                    stdout,
                    Print(" "),
                    SetAttribute(Attribute::Dim),
                    Print(format!("── {h} ──")),
                    SetAttribute(Attribute::NormalIntensity),
                    Print("\r\n"),
                )?;
            }
            Row::Entry(entry) => {
                let is_active = i == active;
                let pfx = if is_active {
                    cursor_active.as_str()
                } else {
                    "  "
                };
                if is_active {
                    // Outer amber wrap is FG-only (no inner bold/dim).
                    // Close with raw SGR 39 so the wire bytes match TS
                    // chalk's `theme.style.highlight(`${cursor} ${name}`)`
                    // foreground close.
                    queue!(
                        stdout,
                        SetForegroundColor(AMBER),
                        Print(pfx),
                        Print(&entry.label),
                        Print(crate::tui::theme::FG_RESET),
                        Print("\r\n"),
                    )?;
                } else {
                    queue!(stdout, Print(pfx), Print(&entry.label), Print("\r\n"))?;
                }
            }
            Row::BlankSeparator => {
                // `@inquirer/core/Separator.js:8` — default content is
                // 14 `─` chars wrapped in `chalk.dim`. Plus the single
                // leading space the select prompt prepends to every
                // separator at `@inquirer/select/dist/index.js:159`.
                let dashes = "─".repeat(BLANK_SEPARATOR_DASHES);
                queue!(
                    stdout,
                    Print(" "),
                    SetAttribute(Attribute::Dim),
                    Print(dashes),
                    SetAttribute(Attribute::NormalIntensity),
                    Print("\r\n"),
                )?;
            }
            Row::Back => {
                // TS at config/index.ts:98 — `chalk.dim("  Back")` with
                // TWO leading spaces INSIDE the dim wrap. Inquirer
                // prepends another 2-char cursor slot, so the visible
                // indent is 4 spaces (or `❯ ` + 2 spaces).
                //
                // When the row is active, @inquirer/select wraps the
                // entire `${cursor} ${item.name}` template in
                // `theme.style.highlight` (= amber). chalk's nesting
                // re-emits the inner amber after the cursor's
                // `\x1b[39m` close so the colour flows through, and the
                // inner `chalk.dim("  Back")` wrap stays intact (chalk
                // only re-emits its OWN close, not other styles' closes).
                // Net visual: amber `❯ ` + amber+dim `  Back`.
                //
                // The Rust port emits a single amber span around the
                // whole row and an inner dim span around `  Back` —
                // visually equivalent (amber-tinted dim), byte-shorter
                // than TS's chalk-nested double-wrap. The chalk-nesting
                // byte exactness is documented as out-of-scope in
                // `docs/tui-port/QUESTIONS.md`.
                let is_active = i == active;
                let pfx = if is_active {
                    cursor_active.as_str()
                } else {
                    "  "
                };
                if is_active {
                    // The inner dim span is already closed by
                    // `NormalIntensity` (SGR 22) before the outer
                    // foreground close. Close FG with raw SGR 39 to
                    // match chalk byte-for-byte.
                    queue!(
                        stdout,
                        SetForegroundColor(AMBER),
                        Print(pfx),
                        SetAttribute(Attribute::Dim),
                        Print("  Back"),
                        SetAttribute(Attribute::NormalIntensity),
                        Print(crate::tui::theme::FG_RESET),
                        Print("\r\n"),
                    )?;
                } else {
                    queue!(
                        stdout,
                        Print(pfx),
                        SetAttribute(Attribute::Dim),
                        Print("  Back"),
                        SetAttribute(Attribute::NormalIntensity),
                        Print("\r\n"),
                    )?;
                }
            }
        }
        height += 1;
    }

    // `@inquirer/select/dist/index.js:180-189` composes the prompt as
    //   [prefix+message, page, ' ', description?, errorMsg?, helpLine]
    //     .filter(Boolean).join('\n').trimEnd()
    // The literal ` ` (single space) row creates a 1-char-wide blank
    // separator between the page and the auto-emitted helpLine; the
    // helpLine itself (`@inquirer/select:148-151`) is
    //   keysHelpTip([['↑↓','navigate'],['⏎','select']])
    // and the default `keysHelpTip` (`@inquirer/select:10-12`) renders
    // each pair as `<bold>key</> <dim>label</>` joined by `<dim> • </>`
    // — starting at column 0, no leading indent. Mirror byte-for-byte.
    queue!(stdout, Print(" \r\n"))?;
    height += 1;
    crate::tui::custom_prompts::help_row::render_help_row(
        stdout,
        "",
        &[("↑↓", "navigate"), ("⏎", "select")],
    )?;
    height += 1;

    stdout.flush()?;
    Ok(height)
}

fn clear_frame<W: Write>(stdout: &mut W, height: u16) -> io::Result<()> {
    if height == 0 {
        return Ok(());
    }
    if height > 1 {
        stdout.queue(MoveUp(height - 1))?;
    }
    stdout.queue(MoveToColumn(0))?;
    stdout.queue(Clear(ClearType::FromCursorDown))?;
    stdout.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, value: &str) -> MenuEntry {
        MenuEntry {
            label: label.to_owned(),
            value: value.to_owned(),
        }
    }

    fn sample_sections() -> Vec<MenuSection> {
        vec![
            MenuSection {
                header: "AI".to_owned(),
                entries: vec![entry("Providers", "providers"), entry("LLMs", "llm")],
            },
            MenuSection {
                header: "Network".to_owned(),
                entries: vec![entry("Relays", "relays")],
            },
        ]
    }

    #[test]
    fn flatten_yields_headers_entries_blank_separator_then_back() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        // [Header(AI), Entry(Providers), Entry(LLMs), Header(Network),
        //  Entry(Relays), BlankSeparator, Back] — the BlankSeparator
        // mirrors `new inquirer.Separator()` at config/index.ts:97.
        assert_eq!(rows.len(), 7);
        assert!(matches!(rows[0], Row::Header("AI")));
        assert!(matches!(rows[1], Row::Entry(_)));
        assert!(matches!(rows[2], Row::Entry(_)));
        assert!(matches!(rows[3], Row::Header("Network")));
        assert!(matches!(rows[4], Row::Entry(_)));
        assert!(matches!(rows[5], Row::BlankSeparator));
        assert!(matches!(rows[6], Row::Back));
    }

    #[test]
    fn first_selectable_skips_leading_header() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let initial = first_selectable(&rows);
        assert_eq!(initial, 1); // first entry under "AI"
    }

    #[test]
    fn down_skips_section_headers_and_blank_separator() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        // active = 1 (Providers). Down should jump to LLMs (idx 2).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 2);
        // Down again — must skip the Network header at idx 3 → idx 4 (Relays).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 4);
        // Down once more — must skip BlankSeparator at idx 5 → land on Back at idx 6.
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 6);
        // Down at the last row clamps (no further selectable).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 6);
    }

    #[test]
    fn up_skips_section_headers_and_blank_separator_and_clamps_at_first() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        state.active = 6; // Back
        handle_key(&mut state, &rows, SectionMenuInput::Up);
        assert_eq!(state.active, 4); // Relays (skipped BlankSeparator at 5)
        handle_key(&mut state, &rows, SectionMenuInput::Up);
        assert_eq!(state.active, 2); // LLMs (skipped Network header at 3)
        handle_key(&mut state, &rows, SectionMenuInput::Up);
        assert_eq!(state.active, 1); // Providers
        handle_key(&mut state, &rows, SectionMenuInput::Up);
        assert_eq!(state.active, 1); // clamps — header above isn't selectable
    }

    #[test]
    fn enter_on_entry_emits_selected_value() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        state.active = 4; // Relays
        let outcome = handle_key(&mut state, &rows, SectionMenuInput::Enter);
        assert_eq!(
            outcome,
            SectionMenuOutcome::Selected {
                value: "relays".to_owned()
            }
        );
    }

    #[test]
    fn enter_on_back_emits_back() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        state.active = 6; // Back (after BlankSeparator at 5)
        assert_eq!(
            handle_key(&mut state, &rows, SectionMenuInput::Enter),
            SectionMenuOutcome::Back
        );
    }

    #[test]
    fn esc_cancels() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        assert_eq!(
            handle_key(&mut state, &rows, SectionMenuInput::Escape),
            SectionMenuOutcome::Cancel
        );
    }

    #[test]
    fn ctrl_c_cancels() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        assert_eq!(
            handle_key(&mut state, &rows, SectionMenuInput::CtrlC),
            SectionMenuOutcome::Cancel
        );
    }

    #[test]
    fn other_input_continues() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        let outcome = handle_key(&mut state, &rows, SectionMenuInput::Other);
        assert_eq!(outcome, SectionMenuOutcome::Continue);
    }

    #[test]
    fn compose_lines_render_section_dividers_with_em_dash_format_and_leading_space() {
        // `@inquirer/select/dist/index.js:159` prepends one space to every
        // separator's rendered content — pin that leading space too.
        let sections = sample_sections();
        let rows = flatten(&sections);
        let lines = compose_lines(&rows, "Settings", 1);
        assert!(lines.iter().any(|l| l == " ── AI ──"));
        assert!(lines.iter().any(|l| l == " ── Network ──"));
    }

    #[test]
    fn compose_lines_active_entry_starts_with_cursor() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let lines = compose_lines(&rows, "Settings", 1);
        // active=1 → Providers row should start with the heavy chevron.
        let providers_row = lines.iter().find(|l| l.contains("Providers")).unwrap();
        assert!(providers_row.starts_with(glyphs::CURSOR_HEAVY));
    }

    #[test]
    fn compose_lines_back_row_renders_word_back() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let lines = compose_lines(&rows, "Settings", 6);
        assert!(lines.iter().any(|l| l.contains("Back")));
    }

    /// Pin the BlankSeparator's rendered content to 14 `─` dashes —
    /// matching `@inquirer/core/Separator.js:8`'s default
    /// `Array.from({ length: 15 }).join(figures.line)` — plus the
    /// single leading space `@inquirer/select/dist/index.js:159`
    /// prepends to every separator.
    #[test]
    fn compose_lines_blank_separator_renders_14_em_dashes_with_leading_space() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let lines = compose_lines(&rows, "Settings", 1);
        let expected = format!(" {}", "─".repeat(14));
        assert!(
            lines.iter().any(|l| l == &expected),
            "missing leading-space + 14-dash blank separator; got lines: {lines:?}"
        );
    }

    #[test]
    fn blank_separator_constant_matches_inquirer_default() {
        // 15-element array joined by 14 separators yields 14 dashes.
        assert_eq!(BLANK_SEPARATOR_DASHES, 14);
    }

    #[test]
    fn from_key_event_maps_arrows_enter_esc_ctrl_c() {
        fn ke(c: KeyCode) -> KeyEvent {
            KeyEvent::new(c, KeyModifiers::NONE)
        }
        fn ke_ctrl(c: KeyCode) -> KeyEvent {
            KeyEvent::new(c, KeyModifiers::CONTROL)
        }
        assert_eq!(
            SectionMenuInput::from_key_event(ke(KeyCode::Up)),
            SectionMenuInput::Up
        );
        assert_eq!(
            SectionMenuInput::from_key_event(ke(KeyCode::Down)),
            SectionMenuInput::Down
        );
        assert_eq!(
            SectionMenuInput::from_key_event(ke(KeyCode::Enter)),
            SectionMenuInput::Enter
        );
        assert_eq!(
            SectionMenuInput::from_key_event(ke(KeyCode::Esc)),
            SectionMenuInput::Escape
        );
        assert_eq!(
            SectionMenuInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            SectionMenuInput::CtrlC
        );
        assert_eq!(
            SectionMenuInput::from_key_event(ke(KeyCode::Tab)),
            SectionMenuInput::Other
        );
    }

    /// Pin: the active Back row preserves the dim styling on "  Back".
    ///
    /// TS at `config/index.ts:98`: the Back item's `name` is
    /// `chalk.dim("  Back")`. When @inquirer/select renders the active
    /// row it wraps `${cursor} ${item.name}` in
    /// `theme.style.highlight` (= amber) — the dim wrap on the inner
    /// "  Back" stays intact, so visually the active Back row reads as
    /// amber-tinted dim text.
    ///
    /// The previous Rust impl wrapped the whole `❯   Back` in one amber
    /// span with no inner dim, dropping the dim styling — visible
    /// difference. This test pins the dim wrap stays in the active path.
    #[test]
    fn render_frame_active_back_preserves_dim_styling() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let active = 6; // Back (per the surrounding navigation tests)
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Settings", &rows, active, 0).unwrap();
        let s = String::from_utf8(buf).expect("render output must be UTF-8");
        // Active Back row must have a dim span (`\x1b[2m`) between the
        // amber open and close — i.e. the `  Back` text is dim AND
        // amber-tinted.
        assert!(
            s.contains("\x1b[2m  Back\x1b[22m"),
            "active Back row must keep the dim wrap on the label; got {s:?}",
        );
        // The outer amber wrap must close with SGR 39 (FG default),
        // not SGR 0. The inner dim is closed by SGR 22 just before.
        assert!(
            s.contains("\x1b[2m  Back\x1b[22m\x1b[39m"),
            "active Back row must close FG with SGR 39 (chalk-perfect); got {s:?}",
        );
    }

    /// Pin: the inactive Back row still renders dim "  Back" without
    /// any amber span.
    #[test]
    fn render_frame_inactive_back_renders_dim_no_amber() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        // Active is the first entry (1) — Back at 6 is inactive.
        let active = 1;
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Settings", &rows, active, 0).unwrap();
        let s = String::from_utf8(buf).expect("render output must be UTF-8");
        assert!(
            s.contains("\x1b[2m  Back\x1b[22m"),
            "inactive Back row must still wrap label in dim; got {s:?}",
        );
        // The inactive row's own line shouldn't start with the amber
        // cursor span — verify no amber-wrap immediately precedes the
        // inactive `  Back`.
        assert!(
            !s.contains("\x1b[38;2;255;193;7m  \x1b[2m  Back"),
            "inactive Back row must not be amber-wrapped; got {s:?}",
        );
    }
}

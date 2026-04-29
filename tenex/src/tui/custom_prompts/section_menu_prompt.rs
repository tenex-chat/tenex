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
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
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
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
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
/// selectable entry. The order is `[header_0, entries_0..., header_1,
/// entries_1..., header_n, entries_n..., Back]` where each `header_*` is
/// the section header and the trailing `Back` row is the only sentinel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row<'a> {
    Header(&'a str),
    Entry(&'a MenuEntry),
    /// Final selectable row.
    Back,
}

pub fn flatten<'a>(sections: &'a [MenuSection]) -> Vec<Row<'a>> {
    let mut rows = Vec::new();
    for section in sections {
        rows.push(Row::Header(&section.header));
        for entry in &section.entries {
            rows.push(Row::Entry(entry));
        }
    }
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
        SectionMenuInput::Other
        | SectionMenuInput::Escape
        | SectionMenuInput::CtrlC => SectionMenuOutcome::Continue,
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
            Row::Header(h) => out.push(format!("── {h} ──")),
            Row::Entry(entry) => {
                let pfx = if i == active { cursor_active.as_str() } else { "  " };
                out.push(format!("{pfx}{}", entry.label));
            }
            Row::Back => {
                let pfx = if i == active { cursor_active.as_str() } else { "  " };
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

    queue!(stdout, SetForegroundColor(AMBER), Print("?"), ResetColor)?;
    queue!(stdout, Print(format!(" {message}\r\n")))?;
    let mut height: u16 = 1;

    let cursor_active = format!("{} ", glyphs::CURSOR_HEAVY);

    for (i, row) in rows.iter().enumerate() {
        match row {
            Row::Header(h) => {
                queue!(
                    stdout,
                    SetAttribute(Attribute::Dim),
                    Print(format!("── {h} ──")),
                    SetAttribute(Attribute::Reset),
                    Print("\r\n"),
                )?;
            }
            Row::Entry(entry) => {
                let is_active = i == active;
                let pfx = if is_active { cursor_active.as_str() } else { "  " };
                if is_active {
                    queue!(
                        stdout,
                        SetForegroundColor(AMBER),
                        Print(pfx),
                        Print(&entry.label),
                        ResetColor,
                        Print("\r\n"),
                    )?;
                } else {
                    queue!(stdout, Print(pfx), Print(&entry.label), Print("\r\n"))?;
                }
            }
            Row::Back => {
                // TS at config/index.ts:98 — `chalk.dim("  Back")` with
                // TWO leading spaces INSIDE the dim wrap. Inquirer
                // prepends another 2-char cursor slot, so the visible
                // indent is 4 spaces (or `❯ ` + 2 spaces). Mirror by
                // emitting "  Back" inside the dim wrap.
                let is_active = i == active;
                let pfx = if is_active { cursor_active.as_str() } else { "  " };
                if is_active {
                    queue!(
                        stdout,
                        SetForegroundColor(AMBER),
                        Print(pfx),
                        Print("  Back"),
                        ResetColor,
                        Print("\r\n"),
                    )?;
                } else {
                    queue!(
                        stdout,
                        Print(pfx),
                        SetAttribute(Attribute::Dim),
                        Print("  Back"),
                        SetAttribute(Attribute::Reset),
                        Print("\r\n"),
                    )?;
                }
            }
        }
        height += 1;
    }

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
                entries: vec![
                    entry("Providers", "providers"),
                    entry("LLMs", "llm"),
                ],
            },
            MenuSection {
                header: "Network".to_owned(),
                entries: vec![entry("Relays", "relays")],
            },
        ]
    }

    #[test]
    fn flatten_yields_headers_then_entries_then_back() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        // [Header(AI), Entry(Providers), Entry(LLMs), Header(Network), Entry(Relays), Back]
        assert_eq!(rows.len(), 6);
        assert!(matches!(rows[0], Row::Header("AI")));
        assert!(matches!(rows[1], Row::Entry(_)));
        assert!(matches!(rows[2], Row::Entry(_)));
        assert!(matches!(rows[3], Row::Header("Network")));
        assert!(matches!(rows[4], Row::Entry(_)));
        assert!(matches!(rows[5], Row::Back));
    }

    #[test]
    fn first_selectable_skips_leading_header() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let initial = first_selectable(&rows);
        assert_eq!(initial, 1); // first entry under "AI"
    }

    #[test]
    fn down_skips_section_headers() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        // active = 1 (Providers). Down should jump to LLMs (idx 2).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 2);
        // Down again — must skip the Network header at idx 3 → idx 4 (Relays).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 4);
        // Down once more lands on Back at idx 5.
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 5);
        // Down at the last row clamps (no further selectable).
        handle_key(&mut state, &rows, SectionMenuInput::Down);
        assert_eq!(state.active, 5);
    }

    #[test]
    fn up_skips_section_headers_and_clamps_at_first() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        state.active = 5; // Back
        handle_key(&mut state, &rows, SectionMenuInput::Up);
        assert_eq!(state.active, 4); // Relays
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
            SectionMenuOutcome::Selected { value: "relays".to_owned() }
        );
    }

    #[test]
    fn enter_on_back_emits_back() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let mut state = SectionMenuState::new(&rows);
        state.active = 5; // Back
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
    fn compose_lines_render_section_dividers_with_em_dash_format() {
        let sections = sample_sections();
        let rows = flatten(&sections);
        let lines = compose_lines(&rows, "Settings", 1);
        assert!(lines.iter().any(|l| l == "── AI ──"));
        assert!(lines.iter().any(|l| l == "── Network ──"));
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
        let lines = compose_lines(&rows, "Settings", 5);
        assert!(lines.iter().any(|l| l.contains("Back")));
    }

    #[test]
    fn from_key_event_maps_arrows_enter_esc_ctrl_c() {
        fn ke(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::NONE) }
        fn ke_ctrl(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::CONTROL) }
        assert_eq!(SectionMenuInput::from_key_event(ke(KeyCode::Up)), SectionMenuInput::Up);
        assert_eq!(SectionMenuInput::from_key_event(ke(KeyCode::Down)), SectionMenuInput::Down);
        assert_eq!(SectionMenuInput::from_key_event(ke(KeyCode::Enter)), SectionMenuInput::Enter);
        assert_eq!(SectionMenuInput::from_key_event(ke(KeyCode::Esc)), SectionMenuInput::Escape);
        assert_eq!(
            SectionMenuInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            SectionMenuInput::CtrlC
        );
        assert_eq!(SectionMenuInput::from_key_event(ke(KeyCode::Tab)), SectionMenuInput::Other);
    }
}

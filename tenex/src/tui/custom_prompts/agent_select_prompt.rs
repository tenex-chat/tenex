//! Agent-select prompt — bespoke list with action rows, a Done row, and a
//! scrollable viewport of installed agents (with multi-select checkboxes
//! and single-key shortcuts on the action rows).
//!
//! Source: `src/commands/agent/AgentManager.ts:43-177`. The TS prompt is
//! built on `@inquirer/core` `createPrompt`; the Rust port preserves the
//! full behaviour via a pure state machine, a reusable [`get_visible_window`]
//! viewport helper, and a crossterm I/O loop.
//!
//! Index layout (sequential when navigating):
//!
//! - `[0 .. actions.len)`             — action rows
//! - `actions.len`                    — Done row
//! - `(actions.len + 1) ..`           — agent items
//!
//! Behaviours (TS lines cited in tests):
//!
//! - Up/Down wrap-around (`% totalNavigable` per `:108`).
//! - Enter emits the action at the active row, or `"done"` for the Done row,
//!   or the item's `value` for an item row (`:97-104`).
//! - Space (only when on an item row) toggles `selected_pubkeys` for that
//!   item's pubkey if any (`:109-119`).
//! - Single-letter `Char(c)` matches an action's `key` (`:120-125`); on hit,
//!   the action's `value` is emitted regardless of cursor position.
//! - Ctrl-C / Esc cancel (TS lets `@inquirer/core` handle this; we surface
//!   it explicitly).

use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{self, Clear, ClearType};
use crossterm::{queue, QueueableCommand};

use super::raw_mode::RawMode;
use crate::tui::glyphs;

// Palette aliases sourced from the shared theme module.
const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;
const ANSI214_ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;

/// Width of the rule rendered between the Done row and the agent list.
/// Source: `AgentManager.ts:142` (52 `─` chars).
pub const RULE_WIDTH: usize = 52;

const FALLBACK_VISIBLE_ITEMS: usize = 24;
const MIN_VISIBLE_ITEMS: usize = 8;

/// One action button — its display name, the single-key shortcut, and the
/// `value` returned when activated.
#[derive(Debug, Clone)]
pub struct ActionItem {
    pub name: String,
    pub key: char,
    pub value: String,
}

/// One agent row.
#[derive(Debug, Clone)]
pub struct AgentItem {
    /// Pre-formatted display label (the screen layer applies any
    /// `chalk.dim` styling for `[inactive]`, `role:`, `projects:` etc.).
    pub name: String,
    /// Returned in the result when this row is activated.
    pub value: String,
    /// Hex pubkey if multi-select on this row should be allowed.
    pub pubkey: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSelectState {
    pub active: usize,
    pub selected_pubkeys: Vec<String>,
}

impl Default for AgentSelectState {
    fn default() -> Self {
        Self {
            active: 0,
            selected_pubkeys: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentInput {
    Up,
    Down,
    Enter,
    Space,
    Escape,
    CtrlC,
    Char(char),
    Other,
}

impl AgentInput {
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
            return AgentInput::CtrlC;
        }
        match ev.code {
            KeyCode::Up => AgentInput::Up,
            KeyCode::Down => AgentInput::Down,
            KeyCode::Enter => AgentInput::Enter,
            KeyCode::Char(' ') => AgentInput::Space,
            KeyCode::Esc => AgentInput::Escape,
            KeyCode::Char(c) => AgentInput::Char(c),
            _ => AgentInput::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentOutcome {
    Continue,
    Cancel,
    Selected {
        action: String,
        selected_pubkeys: Vec<String>,
    },
}

pub fn handle_key(
    state: &mut AgentSelectState,
    actions: &[ActionItem],
    items: &[AgentItem],
    key: AgentInput,
) -> AgentOutcome {
    if matches!(key, AgentInput::CtrlC | AgentInput::Escape) {
        return AgentOutcome::Cancel;
    }

    let done_index = actions.len();
    let total_navigable = actions.len() + 1 + items.len();
    if total_navigable == 0 {
        return AgentOutcome::Continue;
    }

    match key {
        AgentInput::Up => {
            // Wrap-around per `AgentManager.ts:108`.
            state.active = (state.active + total_navigable - 1) % total_navigable;
            AgentOutcome::Continue
        }
        AgentInput::Down => {
            state.active = (state.active + 1) % total_navigable;
            AgentOutcome::Continue
        }
        AgentInput::Enter => {
            if state.active < done_index {
                let action = actions[state.active].value.clone();
                AgentOutcome::Selected {
                    action,
                    selected_pubkeys: std::mem::take(&mut state.selected_pubkeys),
                }
            } else if state.active == done_index {
                AgentOutcome::Selected {
                    action: "done".to_owned(),
                    selected_pubkeys: std::mem::take(&mut state.selected_pubkeys),
                }
            } else {
                let idx = state.active - done_index - 1;
                let action = items
                    .get(idx)
                    .map(|i| i.value.clone())
                    .unwrap_or_else(|| "done".to_owned());
                AgentOutcome::Selected {
                    action,
                    selected_pubkeys: std::mem::take(&mut state.selected_pubkeys),
                }
            }
        }
        AgentInput::Space => {
            if state.active > done_index {
                let idx = state.active - done_index - 1;
                if let Some(item) = items.get(idx) {
                    if let Some(pk) = item.pubkey.as_ref() {
                        if let Some(pos) = state.selected_pubkeys.iter().position(|x| x == pk) {
                            state.selected_pubkeys.remove(pos);
                        } else {
                            state.selected_pubkeys.push(pk.clone());
                        }
                    }
                }
            }
            AgentOutcome::Continue
        }
        AgentInput::Char(c) => {
            // Single-key shortcuts trigger their action regardless of cursor.
            if let Some(action) = actions.iter().find(|a| a.key == c) {
                AgentOutcome::Selected {
                    action: action.value.clone(),
                    selected_pubkeys: std::mem::take(&mut state.selected_pubkeys),
                }
            } else {
                AgentOutcome::Continue
            }
        }
        AgentInput::Other => AgentOutcome::Continue,
        AgentInput::Escape | AgentInput::CtrlC => AgentOutcome::Cancel,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisibleWindow {
    pub start: usize,
    pub end: usize,
}

/// Compute the visible item-row window. Source: `AgentManager.ts:58-76`.
/// Centres the active item where possible; clamps to the list edges.
pub fn get_visible_window(
    active_item_index: usize,
    total_items: usize,
    max_visible_items: usize,
) -> VisibleWindow {
    if total_items <= max_visible_items {
        return VisibleWindow {
            start: 0,
            end: total_items,
        };
    }

    let half = max_visible_items / 2;
    let mut start = active_item_index.saturating_sub(half);
    let end = total_items.min(start + max_visible_items);

    if end - start < max_visible_items {
        start = end.saturating_sub(max_visible_items);
    }

    VisibleWindow { start, end }
}

/// Compute the visible-item count from the terminal height. Source:
/// `AgentManager.ts:78-85`. Uses the `crossterm::terminal::size` query.
pub fn get_agent_list_height() -> usize {
    match terminal::size() {
        Ok((_cols, rows)) if rows > 0 => {
            let estimated = (rows as f64 * 0.6).floor() as usize;
            estimated.max(MIN_VISIBLE_ITEMS)
        }
        _ => FALLBACK_VISIBLE_ITEMS,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSelectResult {
    pub action: String,
    pub selected_pubkeys: Vec<String>,
}

pub fn agent_select_prompt(
    message: &str,
    actions: &[ActionItem],
    items: &[AgentItem],
) -> io::Result<Option<AgentSelectResult>> {
    let _guard = RawMode::enter()?;
    let mut state = AgentSelectState::default();
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, message, &state, actions, items, prev_height)?;
        let key = match event::read()? {
            Event::Key(k) => k,
            _ => continue,
        };
        let input = AgentInput::from_key_event(key);
        match handle_key(&mut state, actions, items, input) {
            AgentOutcome::Continue => continue,
            AgentOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(None);
            }
            AgentOutcome::Selected {
                action,
                selected_pubkeys,
            } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(Some(AgentSelectResult {
                    action,
                    selected_pubkeys,
                }));
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    state: &AgentSelectState,
    actions: &[ActionItem],
    items: &[AgentItem],
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    // TS at AgentManager.ts:129-133 wraps message in
    //   theme.style.message(config.message, "idle")
    // → `styleText('bold', text)`. Mirror byte-for-byte: bold.
    queue!(stdout, SetForegroundColor(AMBER), Print("?"), ResetColor)?;
    queue!(
        stdout,
        Print(" "),
        SetAttribute(Attribute::Bold),
        Print(message),
        SetAttribute(Attribute::NormalIntensity),
        Print("\r\n"),
    )?;
    let mut height: u16 = 1;

    let done_index = actions.len();

    // Action rows (cyan).
    for (i, action) in actions.iter().enumerate() {
        let is_active = state.active == i;
        // TS at `AgentManager.ts:130,137`:
        //   const cursor = theme.icon.cursor;  // chalk.hex("#FFC107")("❯")
        //   const pfx = isActive ? `${cursor} ` : "  ";
        // The trailing space is OUTSIDE the chalk wrap. Print the cursor
        // glyph inside the amber span and the literal space after
        // ResetColor. (See `role_menu_prompt` / `variant_list_prompt` for
        // identical fixes; `docs/tui-port/QUESTIONS.md` notes the
        // crossterm-vs-chalk reset-code divergence the colour-closer
        // pertains to.)
        if is_active {
            queue!(
                stdout,
                SetForegroundColor(AMBER),
                Print(glyphs::CURSOR_HEAVY),
                ResetColor,
                Print(" "),
            )?;
        } else {
            queue!(stdout, Print("  "))?;
        }
        // TS at `AgentManager.ts:138` wraps action.name in
        // `chalk.cyan(...)` — basic 16-colour SGR-36 foreground.
        // crossterm's `Color::DarkCyan` would emit `\x1b[38;5;6m`
        // (256-colour palette index 6) — a *different* shade.
        // Emit the raw `\x1b[36m...\x1b[39m` constants for byte-perfect
        // chalk.cyan match.
        queue!(
            stdout,
            Print(crate::tui::theme::CHALK_CYAN_OPEN),
            Print(&action.name),
            Print(crate::tui::theme::FG_RESET),
            Print("\r\n"),
        )?;
        height += 1;
    }

    // Done row (ansi214 bold, 2-space pad). Same `${cursor} ` byte rule.
    let done_active = state.active == done_index;
    if done_active {
        queue!(
            stdout,
            SetForegroundColor(AMBER),
            Print(glyphs::CURSOR_HEAVY),
            ResetColor,
            Print(" "),
        )?;
    } else {
        queue!(stdout, Print("  "))?;
    }
    queue!(
        stdout,
        SetForegroundColor(ANSI214_ACCENT),
        SetAttribute(Attribute::Bold),
        Print("  Done"),
        SetAttribute(Attribute::NormalIntensity),
        ResetColor,
        Print("\r\n"),
    )?;
    height += 1;

    // Rule. TS at AgentManager.ts:143 emits the rule WITHOUT any
    // styling: `lines.push(\`  ${"─".repeat(52)}\`)`. Don't wrap in
    // dim — match TS's plain-foreground render.
    queue!(
        stdout,
        Print("  "),
        Print("─".repeat(RULE_WIDTH)),
        Print("\r\n"),
    )?;
    height += 1;

    if items.is_empty() {
        queue!(
            stdout,
            SetAttribute(Attribute::Dim),
            Print("  No installed agents"),
            SetAttribute(Attribute::NormalIntensity),
            Print("\r\n"),
        )?;
        height += 1;
    } else {
        let active_item_index = state.active.saturating_sub(done_index + 1);
        let window = get_visible_window(active_item_index, items.len(), get_agent_list_height());
        if window.start > 0 {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(format!("  ↑ {} more", window.start)),
                SetAttribute(Attribute::NormalIntensity),
                Print("\r\n"),
            )?;
            height += 1;
        }
        for (offset, item) in items[window.start..window.end].iter().enumerate() {
            let row_index = done_index + 1 + window.start + offset;
            let is_active = row_index == state.active;
            // Same `${cursor} ` byte rule as the action rows above.
            if is_active {
                queue!(
                    stdout,
                    SetForegroundColor(AMBER),
                    Print(glyphs::CURSOR_HEAVY),
                    ResetColor,
                    Print(" "),
                )?;
            } else {
                queue!(stdout, Print("  "))?;
            }
            let selected = item
                .pubkey
                .as_ref()
                .map(|pk| state.selected_pubkeys.iter().any(|x| x == pk))
                .unwrap_or(false);
            if selected {
                queue!(
                    stdout,
                    SetForegroundColor(Color::DarkGreen),
                    Print("[x]"),
                    ResetColor,
                )?;
            } else {
                queue!(
                    stdout,
                    SetAttribute(Attribute::Dim),
                    Print("[ ]"),
                    SetAttribute(Attribute::NormalIntensity),
                )?;
            }
            queue!(stdout, Print(" "))?;
            if is_active {
                queue!(stdout, SetForegroundColor(AMBER), Print(&item.name), ResetColor)?;
            } else {
                queue!(stdout, Print(&item.name))?;
            }
            queue!(stdout, Print("\r\n"))?;
            height += 1;
        }
        if window.end < items.len() {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(format!("  ↓ {} more", items.len() - window.end)),
                SetAttribute(Attribute::NormalIntensity),
                Print("\r\n"),
            )?;
            height += 1;
        }
    }

    // TS at AgentManager.ts:170-175 — bold-key / dim-label help row.
    // 2-space indent matches the TS template
    // `chalk.dim(\`  ${helpParts.join(...)}\`)` (`:175`).
    // Note: TS line 172 ("space") and line 173 ("⏎") both map to the
    // dim label "select" — preserve that intentional repetition.
    crate::tui::custom_prompts::help_row::render_help_row(
        stdout,
        "  ",
        &[
            ("↑↓", "navigate"),
            ("space", "select"),
            ("⏎", "select"),
        ],
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

    fn actions_sample() -> Vec<ActionItem> {
        vec![
            ActionItem {
                name: "Install agent".into(),
                key: 'a',
                value: "install".into(),
            },
            ActionItem {
                name: "Bulk delete".into(),
                key: 'x',
                value: "bulk_delete".into(),
            },
            ActionItem {
                name: "Merge duplicates".into(),
                key: 'm',
                value: "merge".into(),
            },
        ]
    }

    fn items_sample(n: usize) -> Vec<AgentItem> {
        (0..n)
            .map(|i| AgentItem {
                name: format!("agent-{i:02}"),
                value: format!("agent_value_{i}"),
                pubkey: Some(format!("pk{i}")),
            })
            .collect()
    }

    fn empty_state() -> AgentSelectState {
        AgentSelectState::default()
    }

    // ---- viewport math --------------------------------------------------

    #[test]
    fn viewport_returns_full_range_when_total_fits() {
        let w = get_visible_window(2, 5, 24);
        assert_eq!(w, VisibleWindow { start: 0, end: 5 });
    }

    #[test]
    fn viewport_centres_on_active_when_overflowing() {
        // 100 items, max 10 visible; active in the middle.
        let w = get_visible_window(50, 100, 10);
        assert_eq!(w, VisibleWindow { start: 45, end: 55 });
    }

    #[test]
    fn viewport_clamps_to_start_when_near_top() {
        let w = get_visible_window(2, 100, 10);
        assert_eq!(w, VisibleWindow { start: 0, end: 10 });
    }

    #[test]
    fn viewport_clamps_to_end_when_near_bottom() {
        let w = get_visible_window(98, 100, 10);
        assert_eq!(w, VisibleWindow { start: 90, end: 100 });
    }

    #[test]
    fn viewport_handles_zero_items() {
        let w = get_visible_window(0, 0, 10);
        assert_eq!(w, VisibleWindow { start: 0, end: 0 });
    }

    // ---- navigation -----------------------------------------------------

    #[test]
    fn down_at_last_wraps_to_first() {
        let actions = actions_sample();
        let items = items_sample(2);
        let mut state = empty_state();
        state.active = actions.len() + 1 + items.len() - 1; // last item
        handle_key(&mut state, &actions, &items, AgentInput::Down);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn up_at_first_wraps_to_last() {
        let actions = actions_sample();
        let items = items_sample(2);
        let mut state = empty_state();
        let mut last = actions.len() + 1 + items.len() - 1;
        handle_key(&mut state, &actions, &items, AgentInput::Up);
        assert_eq!(state.active, last);
        let _ = last;
    }

    // ---- enter ----------------------------------------------------------

    #[test]
    fn enter_on_action_row_emits_action_value() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        state.active = 1; // Bulk delete
        match handle_key(&mut state, &actions, &items, AgentInput::Enter) {
            AgentOutcome::Selected { action, .. } => assert_eq!(action, "bulk_delete"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_done_row_emits_done() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        state.active = actions.len();
        match handle_key(&mut state, &actions, &items, AgentInput::Enter) {
            AgentOutcome::Selected { action, .. } => assert_eq!(action, "done"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_item_row_emits_item_value_and_passes_selection() {
        let actions = actions_sample();
        let items = items_sample(3);
        let mut state = empty_state();
        // Pre-select two items via Space.
        state.active = actions.len() + 1; // first item
        handle_key(&mut state, &actions, &items, AgentInput::Space);
        state.active = actions.len() + 2; // second item
        handle_key(&mut state, &actions, &items, AgentInput::Space);
        // Now activate the third item.
        state.active = actions.len() + 3;
        match handle_key(&mut state, &actions, &items, AgentInput::Enter) {
            AgentOutcome::Selected { action, selected_pubkeys } => {
                assert_eq!(action, "agent_value_2");
                assert_eq!(selected_pubkeys, vec!["pk0".to_owned(), "pk1".to_owned()]);
            }
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    // ---- space toggle --------------------------------------------------

    #[test]
    fn space_on_action_row_is_noop() {
        let actions = actions_sample();
        let items = items_sample(2);
        let mut state = empty_state();
        state.active = 0;
        handle_key(&mut state, &actions, &items, AgentInput::Space);
        assert!(state.selected_pubkeys.is_empty());
    }

    #[test]
    fn space_on_item_row_toggles_selection() {
        let actions = actions_sample();
        let items = items_sample(3);
        let mut state = empty_state();
        state.active = actions.len() + 1; // first item
        handle_key(&mut state, &actions, &items, AgentInput::Space);
        assert_eq!(state.selected_pubkeys, vec!["pk0".to_owned()]);
        handle_key(&mut state, &actions, &items, AgentInput::Space);
        assert!(state.selected_pubkeys.is_empty());
    }

    // ---- shortcuts ------------------------------------------------------

    #[test]
    fn single_key_shortcut_emits_action_regardless_of_cursor() {
        let actions = actions_sample();
        let items = items_sample(5);
        let mut state = empty_state();
        state.active = 4; // somewhere in items
        match handle_key(&mut state, &actions, &items, AgentInput::Char('m')) {
            AgentOutcome::Selected { action, .. } => assert_eq!(action, "merge"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn unknown_char_is_continue() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        let outcome = handle_key(&mut state, &actions, &items, AgentInput::Char('z'));
        assert_eq!(outcome, AgentOutcome::Continue);
    }

    // ---- cancel ---------------------------------------------------------

    #[test]
    fn ctrl_c_cancels() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        assert_eq!(
            handle_key(&mut state, &actions, &items, AgentInput::CtrlC),
            AgentOutcome::Cancel
        );
    }

    #[test]
    fn esc_cancels() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        assert_eq!(
            handle_key(&mut state, &actions, &items, AgentInput::Escape),
            AgentOutcome::Cancel
        );
    }

    // ---- key event mapping ---------------------------------------------

    #[test]
    fn from_key_event_maps_arrows_and_special_keys() {
        fn ke(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::NONE) }
        fn ke_ctrl(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::CONTROL) }
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Up)), AgentInput::Up);
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Down)), AgentInput::Down);
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Enter)), AgentInput::Enter);
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Char(' '))), AgentInput::Space);
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Esc)), AgentInput::Escape);
        assert_eq!(
            AgentInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            AgentInput::CtrlC,
        );
        assert_eq!(
            AgentInput::from_key_event(ke(KeyCode::Char('x'))),
            AgentInput::Char('x'),
        );
        assert_eq!(AgentInput::from_key_event(ke(KeyCode::Tab)), AgentInput::Other);
    }

    /// Pin: the active-row cursor's trailing space lands OUTSIDE the
    /// amber colour span, AND that the action-row label is wrapped in
    /// chalk.cyan wire bytes (`\x1b[36m...\x1b[39m`).
    ///
    /// TS at `AgentManager.ts:130,137,138`:
    ///   const cursor = theme.icon.cursor;  // chalk.hex("#FFC107")("❯")
    ///   const pfx = isActive ? `${cursor} ` : "  ";
    ///   lines.push(`${pfx}${chalk.cyan(action.name)}`);
    /// Wire bytes: `\x1b[38;2;255;193;7m❯\x1b[<reset>m \x1b[36m<name>\x1b[39m`.
    /// Tolerates either FG closer for the cursor wrap (systemic
    /// crossterm-vs-chalk divergence in `docs/tui-port/QUESTIONS.md`).
    #[test]
    fn render_frame_active_action_cursor_has_space_outside_amber_wrap() {
        let actions = actions_sample();
        let items = items_sample(0); // empty list — exercises only the action+done rows
        let mut state = empty_state();
        state.active = 0; // first action row
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Manage agents", &state, &actions, &items, 0).unwrap();
        let s = String::from_utf8(buf).expect("render output must be UTF-8");
        let space_outside_full_reset = s.contains("\x1b[38;2;255;193;7m❯\x1b[0m ");
        let space_outside_fg_reset = s.contains("\x1b[38;2;255;193;7m❯\x1b[39m ");
        assert!(
            space_outside_full_reset || space_outside_fg_reset,
            "active action cursor must emit `❯` + colour-closer + literal space; got {s:?}",
        );
        assert!(
            !s.contains("\x1b[38;2;255;193;7m❯ \x1b[0m")
                && !s.contains("\x1b[38;2;255;193;7m❯ \x1b[39m"),
            "must not wrap the cursor's trailing space inside the amber span; got {s:?}",
        );
        // The action label must use chalk.cyan SGR-36, not crossterm
        // DarkCyan's 256-colour `\x1b[38;5;6m`.
        assert!(
            s.contains("\x1b[36mInstall agent\x1b[39m"),
            "action label must be wrapped in chalk.cyan SGR-36; got {s:?}",
        );
        assert!(
            !s.contains("\x1b[38;5;6m"),
            "must not emit 256-colour DarkCyan; got {s:?}",
        );
    }

    /// Pin same `${cursor} ` rule for the active Done row, plus that
    /// the ansi256-#214 + bold "  Done" label opens immediately after
    /// the cursor's trailing space.
    #[test]
    fn render_frame_active_done_cursor_has_space_outside_amber_wrap() {
        let actions = actions_sample();
        let items = items_sample(0);
        let mut state = empty_state();
        // Done row sits at index `actions.len()`.
        state.active = actions.len();
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Manage agents", &state, &actions, &items, 0).unwrap();
        let s = String::from_utf8(buf).expect("render output must be UTF-8");
        let with_full_reset = s.contains(
            "\x1b[38;2;255;193;7m❯\x1b[0m \x1b[38;5;214m\x1b[1m  Done",
        );
        let with_fg_reset = s.contains(
            "\x1b[38;2;255;193;7m❯\x1b[39m \x1b[38;5;214m\x1b[1m  Done",
        );
        assert!(
            with_full_reset || with_fg_reset,
            "Done row must emit cursor + close + literal space + ansi256(214)+bold for the label; got {s:?}",
        );
    }

    /// Pin same `${cursor} ` rule for the active item (agent) row.
    #[test]
    fn render_frame_active_item_cursor_has_space_outside_amber_wrap() {
        let actions = actions_sample();
        let items = items_sample(3);
        let mut state = empty_state();
        // Item rows sit at indices `actions.len() + 1 + offset`.
        state.active = actions.len() + 1; // first agent row
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Manage agents", &state, &actions, &items, 0).unwrap();
        let s = String::from_utf8(buf).expect("render output must be UTF-8");
        let space_outside_full_reset = s.contains("\x1b[38;2;255;193;7m❯\x1b[0m ");
        let space_outside_fg_reset = s.contains("\x1b[38;2;255;193;7m❯\x1b[39m ");
        assert!(
            space_outside_full_reset || space_outside_fg_reset,
            "active agent-row cursor must emit `❯` + colour-closer + literal space; got {s:?}",
        );
        assert!(
            !s.contains("\x1b[38;2;255;193;7m❯ \x1b[0m")
                && !s.contains("\x1b[38;2;255;193;7m❯ \x1b[39m"),
            "must not wrap the cursor's trailing space inside the amber span; got {s:?}",
        );
    }
}

//! LLM-config-editor menu — the bespoke prompt that drives
//! `LLMConfigEditor.showMainMenu` (`src/llm/LLMConfigEditor.ts:48-173`,
//! the `selectWithFooter` `createPrompt`). Pure state machine + render
//! composition — the I/O layer wires the spinner timer and test-runner
//! callback in a separate file.
//!
//! Index layout (sequential when navigating):
//!
//! - `[0 .. actions.len)`             — action rows (cyan)
//! - `actions.len`                    — Done row (ansi214 bold)
//! - `(actions.len + 1) ..`           — config rows
//!
//! Behaviours (TS lines cited in tests):
//!
//! - **Up/Down** wrap-around `% totalNavigable` (`:95`).
//! - **Enter** on action → emit `Selected { value: action.value }`;
//!   on Done → emit `Selected { value: "done" }`; on a config row →
//!   emit `Selected { value: items[idx].value }`.
//! - **`t` shortcut** on a config row → emit `RequestTest { config_name }`,
//!   gated on absence of an existing result (`:100` re-press is a no-op).
//! - **`d` shortcut** on a config row whose value starts with `config:` →
//!   emit `Selected { value: "delete:<configName>" }` (`:107-112`).
//! - Single-letter shortcut matching an action's `key` → emit
//!   `Selected { value: action.value }` regardless of cursor (`:113-118`).
//! - **Spinner**: 10-frame Braille (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80 ms intervals.
//!   The state machine just exposes `spinner_frame: usize` for the
//!   I/O layer to advance.
//!
//! Cursor: `❯` in `INQUIRER_AMBER` (per `:42-46` reusing `inquirerTheme`).

use std::collections::HashMap;
use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};

use super::raw_mode::RawMode;
use crate::tui::glyphs;

// Palette aliases sourced from the shared theme module.
const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;
const ANSI214_ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;

/// Width of the rule rendered between Done and the config rows.
/// Source: `LLMConfigEditor.ts:136` (40 `─`).
pub const RULE_WIDTH: usize = 40;

/// Spinner frames. Source: `:39` `SPINNER_FRAMES`.
pub const SPINNER_FRAMES: &[&str] = &[
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

/// Action button. `key` is the single-letter shortcut.
#[derive(Debug, Clone)]
pub struct ActionItem {
    pub name: String,
    pub key: char,
    pub value: String,
}

/// Configuration row. `config_name` (when `Some`) marks the row as a
/// real configuration that supports `t` (test) and `d` (delete) shortcuts.
/// Rows with `config_name: None` (e.g. a synthetic separator) are still
/// navigable but ignore those shortcuts.
#[derive(Debug, Clone)]
pub struct ConfigItem {
    pub name: String,
    pub value: String,
    pub config_name: Option<String>,
}

/// Result of one in-flight test. `error` is one of the four hint strings
/// per spec doc 06 §5 when `success == false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestResult {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmMenuState {
    pub active: usize,
    pub testing: Option<String>,
    pub spinner_frame: usize,
    pub results: HashMap<String, TestResult>,
}

impl Default for LlmMenuState {
    fn default() -> Self {
        Self {
            active: 0,
            testing: None,
            spinner_frame: 0,
            results: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmMenuInput {
    Up,
    Down,
    Enter,
    Escape,
    CtrlC,
    Char(char),
    /// Spinner tick — advance `spinner_frame`. The I/O layer fires this
    /// every 80 ms while a test is in flight.
    SpinnerTick,
    /// Test completed — record the result and clear the in-flight marker.
    TestCompleted {
        // Note: the actual config name and result are passed via a
        // sibling event (see [`finish_test`]); this variant only signals
        // arrival. Kept here so the I/O layer's match is exhaustive.
    },
    Other,
}

impl LlmMenuInput {
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
            return LlmMenuInput::CtrlC;
        }
        match ev.code {
            KeyCode::Up => LlmMenuInput::Up,
            KeyCode::Down => LlmMenuInput::Down,
            KeyCode::Enter => LlmMenuInput::Enter,
            KeyCode::Esc => LlmMenuInput::Escape,
            KeyCode::Char(c) => LlmMenuInput::Char(c),
            _ => LlmMenuInput::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmMenuOutcome {
    Continue,
    Cancel,
    /// Caller routes on the value: action values for action rows; `"done"`
    /// for Done; `"delete:<name>"` for `d` on a config row; the item's own
    /// `value` for Enter on a config row.
    Selected { value: String },
    /// `t` pressed on a config row that has no existing result.
    /// Caller spawns the test, then later calls [`finish_test`] with the
    /// outcome.
    RequestTest { config_name: String },
}

/// Drive the state machine with one input.
pub fn handle_key(
    state: &mut LlmMenuState,
    actions: &[ActionItem],
    items: &[ConfigItem],
    key: LlmMenuInput,
) -> LlmMenuOutcome {
    if matches!(key, LlmMenuInput::SpinnerTick) {
        if state.testing.is_some() {
            state.spinner_frame = state.spinner_frame.wrapping_add(1);
        }
        return LlmMenuOutcome::Continue;
    }
    if matches!(key, LlmMenuInput::TestCompleted { .. }) {
        // The actual completion data is delivered via `finish_test`; the
        // event arrival on its own is just a redraw trigger.
        return LlmMenuOutcome::Continue;
    }
    if matches!(key, LlmMenuInput::CtrlC | LlmMenuInput::Escape) {
        return LlmMenuOutcome::Cancel;
    }

    // While a test is in flight, swallow non-cancel input (`:82`).
    if state.testing.is_some() {
        return LlmMenuOutcome::Continue;
    }

    let done_index = actions.len();
    let total_navigable = actions.len() + 1 + items.len();
    if total_navigable == 0 {
        return LlmMenuOutcome::Continue;
    }

    match key {
        LlmMenuInput::Up => {
            state.active = (state.active + total_navigable - 1) % total_navigable;
            LlmMenuOutcome::Continue
        }
        LlmMenuInput::Down => {
            state.active = (state.active + 1) % total_navigable;
            LlmMenuOutcome::Continue
        }
        LlmMenuInput::Enter => {
            if state.active < done_index {
                LlmMenuOutcome::Selected {
                    value: actions[state.active].value.clone(),
                }
            } else if state.active == done_index {
                LlmMenuOutcome::Selected {
                    value: "done".to_owned(),
                }
            } else {
                let idx = state.active - done_index - 1;
                let value = items
                    .get(idx)
                    .map(|i| i.value.clone())
                    .unwrap_or_else(|| "done".to_owned());
                LlmMenuOutcome::Selected { value }
            }
        }
        LlmMenuInput::Char('t') => {
            if state.active > done_index {
                let idx = state.active - done_index - 1;
                if let Some(item) = items.get(idx) {
                    if let Some(name) = &item.config_name {
                        if state.results.contains_key(name) {
                            // Re-press is a no-op (`:100`).
                            return LlmMenuOutcome::Continue;
                        }
                        state.testing = Some(name.clone());
                        state.spinner_frame = 0;
                        return LlmMenuOutcome::RequestTest {
                            config_name: name.clone(),
                        };
                    }
                }
            }
            LlmMenuOutcome::Continue
        }
        LlmMenuInput::Char('d') => {
            if state.active > done_index {
                let idx = state.active - done_index - 1;
                if let Some(item) = items.get(idx) {
                    if let Some(stripped) = item.value.strip_prefix("config:") {
                        return LlmMenuOutcome::Selected {
                            value: format!("delete:{stripped}"),
                        };
                    }
                }
            }
            LlmMenuOutcome::Continue
        }
        LlmMenuInput::Char(c) => {
            if let Some(action) = actions.iter().find(|a| a.key == c) {
                LlmMenuOutcome::Selected {
                    value: action.value.clone(),
                }
            } else {
                LlmMenuOutcome::Continue
            }
        }
        LlmMenuInput::Other => LlmMenuOutcome::Continue,
        LlmMenuInput::SpinnerTick
        | LlmMenuInput::TestCompleted { .. }
        | LlmMenuInput::Escape
        | LlmMenuInput::CtrlC => unreachable!(),
    }
}

/// Record a test outcome and clear the in-flight marker. Called by the
/// I/O layer when `RequestTest`'s spawned future resolves.
pub fn finish_test(state: &mut LlmMenuState, config_name: &str, result: TestResult) {
    if state.testing.as_deref() == Some(config_name) {
        state.testing = None;
        state.spinner_frame = 0;
    }
    state.results.insert(config_name.to_owned(), result);
}

/// Render lines for the menu. The I/O layer adds colour and writes via
/// crossterm; tests inspect the unstyled strings.
pub fn compose_lines(
    state: &LlmMenuState,
    message: &str,
    actions: &[ActionItem],
    items: &[ConfigItem],
) -> Vec<String> {
    let done_index = actions.len();
    let cursor_active = format!("{} ", glyphs::CURSOR_HEAVY);

    let mut out = Vec::with_capacity(actions.len() + items.len() + 5);
    out.push(format!("? {message}"));

    for (i, action) in actions.iter().enumerate() {
        let pfx = if i == state.active { cursor_active.as_str() } else { "  " };
        out.push(format!("{pfx}{}", action.name));
    }

    let pfx = if state.active == done_index { cursor_active.as_str() } else { "  " };
    out.push(format!("{pfx}  Done"));

    out.push(format!("  {}", "─".repeat(RULE_WIDTH)));

    if items.is_empty() {
        out.push("  No configurations yet".to_owned());
    } else {
        for (i, item) in items.iter().enumerate() {
            let row_index = done_index + 1 + i;
            let is_active = row_index == state.active;
            let pfx = if is_active { cursor_active.as_str() } else { "  " };
            let prefix_glyph = render_status_glyph(state, item);
            out.push(format!("{pfx}{prefix_glyph} {}{}", item.name, render_error_suffix(state, item)));
        }
    }

    out.push(
        "  ↑↓ navigate • ⏎ select • t test • d delete".to_string(),
    );

    out
}

fn render_status_glyph(state: &LlmMenuState, item: &ConfigItem) -> &'static str {
    let name = match &item.config_name {
        Some(n) => n,
        None => return " ",
    };
    if state.testing.as_deref() == Some(name.as_str()) {
        SPINNER_FRAMES[state.spinner_frame % SPINNER_FRAMES.len()]
    } else if let Some(result) = state.results.get(name) {
        if result.success {
            glyphs::CHECK
        } else {
            glyphs::CROSS
        }
    } else {
        " "
    }
}

fn render_error_suffix(state: &LlmMenuState, item: &ConfigItem) -> String {
    let Some(name) = &item.config_name else { return String::new() };
    let Some(result) = state.results.get(name) else { return String::new() };
    if result.success {
        return String::new();
    }
    match &result.error {
        Some(msg) => format!(" {msg}"),
        None => String::new(),
    }
}

// =========================================================================
// I/O loop
// =========================================================================

/// What the screen returns to its caller. The TS `selectWithFooter` returns
/// a single string; we keep that shape so dispatch in the parent driver is
/// a string match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmMenuResult {
    Selected(String),
    Cancelled,
}

/// Execute one round of the bespoke prompt. The optional `on_test` callback
/// (when supplied) runs synchronously when the user presses `t` on a row
/// with `config_name`; the function blocks the prompt's redraw loop until
/// the callback returns. The TS source uses an async promise + spinner —
/// we serialize for now; if a long-running test needs the spinner, the
/// caller can wrap `on_test` to run on a worker thread and feed
/// `SpinnerTick` events. (Spinner-thread integration is its own iteration.)
pub fn llm_menu_prompt<F>(
    message: &str,
    actions: &[ActionItem],
    items: &[ConfigItem],
    mut on_test: Option<F>,
) -> io::Result<LlmMenuResult>
where
    F: FnMut(&str) -> TestResult,
{
    let _guard = RawMode::enter()?;
    let mut state = LlmMenuState::default();
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, message, &state, actions, items, prev_height)?;
        let key = match event::read()? {
            Event::Key(k) => k,
            _ => continue,
        };
        let input = LlmMenuInput::from_key_event(key);
        match handle_key(&mut state, actions, items, input) {
            LlmMenuOutcome::Continue => continue,
            LlmMenuOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(LlmMenuResult::Cancelled);
            }
            LlmMenuOutcome::Selected { value } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(LlmMenuResult::Selected(value));
            }
            LlmMenuOutcome::RequestTest { config_name } => {
                let result = match on_test.as_mut() {
                    Some(cb) => cb(&config_name),
                    None => TestResult {
                        success: false,
                        error: Some("test runner not configured".to_owned()),
                    },
                };
                finish_test(&mut state, &config_name, result);
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    state: &LlmMenuState,
    actions: &[ActionItem],
    items: &[ConfigItem],
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    // TS at LLMConfigEditor.ts:120 calls
    //   theme.style.message(config.message, "idle")
    // which is `styleText('bold', text)` per `@inquirer/core/dist/lib/theme.js:14`.
    // Mirror byte-for-byte: bold the message.
    // TS `inquirerTheme.prefix.idle = chalk.hex("#FFC107")("?")` —
    // closes with SGR 39 (FG default), not SGR 0 (full reset). Use the
    // raw FG_RESET constant for byte-perfect chalk-prefix match.
    queue!(stdout, SetForegroundColor(AMBER), Print("?"), Print(crate::tui::theme::FG_RESET))?;
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

    for (i, action) in actions.iter().enumerate() {
        let is_active = state.active == i;
        // TS at `LLMConfigEditor.ts:122,129`:
        //   const cursor = theme.icon.cursor;  // chalk.hex("#FFC107")("❯")
        //   const pfx = isActive ? `${cursor} ` : "  ";
        // The trailing space is OUTSIDE the chalk wrap. Print the cursor
        // glyph inside the amber span, the literal space after
        // `ResetColor`. (See `role_menu_prompt`, `variant_list_prompt`,
        // `agent_select_prompt`, `provider_select_prompt` for identical
        // fixes; `docs/tui-port/QUESTIONS.md` notes the systemic
        // crossterm-vs-chalk reset-code divergence.)
        if is_active {
            queue!(
                stdout,
                SetForegroundColor(AMBER),
                Print(glyphs::CURSOR_HEAVY),
                Print(crate::tui::theme::FG_RESET),
                Print(" "),
            )?;
        } else {
            queue!(stdout, Print("  "))?;
        }
        // TS at `LLMConfigEditor.ts:130` wraps action.name in
        // `chalk.cyan(...)` — the basic 16-colour SGR-36 foreground.
        // crossterm's `Color::DarkCyan` would emit
        // `\x1b[38;5;6m` (256-colour palette index 6) which is a
        // *different* shade in most terminals. Use the theme's raw
        // `\x1b[36m...\x1b[39m` constants for byte-perfect chalk.cyan
        // wrap (and SGR-39 close instead of SGR-0 full reset).
        queue!(
            stdout,
            Print(crate::tui::theme::CHALK_CYAN_OPEN),
            Print(&action.name),
            Print(crate::tui::theme::FG_RESET),
            Print("\r\n"),
        )?;
        height += 1;
    }

    let done_active = state.active == done_index;
    if done_active {
        queue!(
            stdout,
            SetForegroundColor(AMBER),
            Print(glyphs::CURSOR_HEAVY),
            Print(crate::tui::theme::FG_RESET),
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

    // TS LLMConfigEditor.ts:136 emits the rule WITHOUT any styling:
    //   lines.push(\`  ${"─".repeat(40)}\`);
    // Don't wrap in dim — match TS's plain-foreground render.
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
            Print("  No configurations yet"),
            SetAttribute(Attribute::NormalIntensity),
            Print("\r\n"),
        )?;
        height += 1;
    } else {
        for (i, item) in items.iter().enumerate() {
            let row_index = done_index + 1 + i;
            let is_active = row_index == state.active;
            if is_active {
                queue!(
                    stdout,
                    SetForegroundColor(AMBER),
                    Print(glyphs::CURSOR_HEAVY),
                    Print(crate::tui::theme::FG_RESET),
                    Print(" "),
                )?;
            } else {
                queue!(stdout, Print("  "))?;
            }
            // Status glyph: spinner / ✓ / ✗ / blank.
            // TS at `LLMConfigEditor.ts:150,154`:
            //   chalk.yellow(frame)            → \x1b[33m<frame>\x1b[39m
            //   chalk.green("✓") / chalk.red("✗")
            // Use the raw SGR-3* opens / SGR-39 close from theme so the
            // wire bytes match chalk's basic 16-colour foreground exactly
            // (crossterm's `Color::Dark{Yellow,Green,Red}` would emit
            // 256-colour palette indices instead, a *visible* shade
            // difference).
            let name = item.config_name.as_deref();
            if name.is_some() && state.testing.as_deref() == name {
                queue!(
                    stdout,
                    Print(crate::tui::theme::CHALK_YELLOW_OPEN),
                    Print(SPINNER_FRAMES[state.spinner_frame % SPINNER_FRAMES.len()]),
                    Print(crate::tui::theme::FG_RESET),
                    Print(" "),
                )?;
            } else if let Some(result) = name.and_then(|n| state.results.get(n)) {
                if result.success {
                    queue!(
                        stdout,
                        Print(crate::tui::theme::CHALK_GREEN_OPEN),
                        Print(glyphs::CHECK),
                        Print(crate::tui::theme::FG_RESET),
                        Print(" "),
                    )?;
                } else {
                    queue!(
                        stdout,
                        Print(crate::tui::theme::CHALK_RED_OPEN),
                        Print(glyphs::CROSS),
                        Print(crate::tui::theme::FG_RESET),
                        Print(" "),
                    )?;
                }
            } else {
                queue!(stdout, Print("  "))?;
            }
            if is_active {
                queue!(stdout, SetForegroundColor(AMBER), Print(&item.name), ResetColor)?;
            } else {
                queue!(stdout, Print(&item.name))?;
            }
            if let Some(name) = name {
                if let Some(result) = state.results.get(name) {
                    if !result.success {
                        if let Some(err) = &result.error {
                            queue!(
                                stdout,
                                Print(" "),
                                SetAttribute(Attribute::Dim),
                                Print(err),
                                SetAttribute(Attribute::NormalIntensity),
                            )?;
                        }
                    }
                }
            }
            queue!(stdout, Print("\r\n"))?;
            height += 1;
        }
    }

    // TS at LLMConfigEditor.ts:164-170 — bold-key / dim-label help row.
    // 2-space indent matches `chalk.dim(\`  ${helpParts.join(...)}\`)` at
    // `:170`. See `help_row` for the chalk-equivalence rationale.
    crate::tui::custom_prompts::help_row::render_help_row(
        stdout,
        "  ",
        &[
            ("↑↓", "navigate"),
            ("⏎", "select"),
            ("t", "test"),
            ("d", "delete"),
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

    fn actions() -> Vec<ActionItem> {
        vec![
            ActionItem {
                name: "Add config".into(),
                key: 'a',
                value: "add".into(),
            },
            ActionItem {
                name: "Add multi-modal".into(),
                key: 'm',
                value: "addMultiModal".into(),
            },
        ]
    }

    fn config_items(n: usize) -> Vec<ConfigItem> {
        (0..n)
            .map(|i| ConfigItem {
                name: format!("Config{i}"),
                value: format!("config:Config{i}"),
                config_name: Some(format!("Config{i}")),
            })
            .collect()
    }

    fn state() -> LlmMenuState {
        LlmMenuState::default()
    }

    // ---- navigation ---------------------------------------------------

    #[test]
    fn down_wraps_from_last_to_first() {
        let actions = actions();
        let items = config_items(2);
        let mut s = state();
        s.active = actions.len() + 1 + items.len() - 1; // last config row
        handle_key(&mut s, &actions, &items, LlmMenuInput::Down);
        assert_eq!(s.active, 0);
    }

    #[test]
    fn up_wraps_from_first_to_last() {
        let actions = actions();
        let items = config_items(2);
        let mut s = state();
        let last = actions.len() + 1 + items.len() - 1;
        handle_key(&mut s, &actions, &items, LlmMenuInput::Up);
        assert_eq!(s.active, last);
    }

    // ---- enter --------------------------------------------------------

    #[test]
    fn enter_on_action_emits_action_value() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        s.active = 0;
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Enter) {
            LlmMenuOutcome::Selected { value } => assert_eq!(value, "add"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_done_emits_done() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        s.active = actions.len();
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Enter) {
            LlmMenuOutcome::Selected { value } => assert_eq!(value, "done"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_config_row_emits_item_value() {
        let actions = actions();
        let items = config_items(2);
        let mut s = state();
        s.active = actions.len() + 1; // first config
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Enter) {
            LlmMenuOutcome::Selected { value } => assert_eq!(value, "config:Config0"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    // ---- t shortcut ---------------------------------------------------

    #[test]
    fn t_on_config_row_emits_request_test_and_marks_testing() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.active = actions.len() + 1;
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Char('t')) {
            LlmMenuOutcome::RequestTest { config_name } => {
                assert_eq!(config_name, "Config0");
            }
            other => panic!("expected RequestTest, got {other:?}"),
        }
        assert_eq!(s.testing.as_deref(), Some("Config0"));
        assert_eq!(s.spinner_frame, 0);
    }

    #[test]
    fn t_on_action_row_is_continue() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.active = 0; // action row
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Char('t'));
        assert_eq!(outcome, LlmMenuOutcome::Continue);
    }

    #[test]
    fn t_on_already_tested_row_is_continue() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.results.insert(
            "Config0".to_owned(),
            TestResult { success: true, error: None },
        );
        s.active = actions.len() + 1;
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Char('t'));
        assert_eq!(outcome, LlmMenuOutcome::Continue);
        assert!(s.testing.is_none()); // no in-flight marker set
    }

    // ---- d shortcut ---------------------------------------------------

    #[test]
    fn d_on_config_row_emits_delete_with_name() {
        let actions = actions();
        let items = config_items(2);
        let mut s = state();
        s.active = actions.len() + 1; // Config0
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Char('d')) {
            LlmMenuOutcome::Selected { value } => assert_eq!(value, "delete:Config0"),
            other => panic!("expected Selected(delete:...), got {other:?}"),
        }
    }

    #[test]
    fn d_on_action_row_is_continue() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.active = 0;
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Char('d'));
        assert_eq!(outcome, LlmMenuOutcome::Continue);
    }

    #[test]
    fn d_on_row_without_config_prefix_is_continue() {
        let actions = actions();
        let items = vec![ConfigItem {
            name: "Synthetic".into(),
            value: "noprefix".into(),
            config_name: None,
        }];
        let mut s = state();
        s.active = actions.len() + 1;
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Char('d'));
        assert_eq!(outcome, LlmMenuOutcome::Continue);
    }

    // ---- single-letter shortcut --------------------------------------

    #[test]
    fn action_shortcut_emits_action_value_regardless_of_cursor() {
        let actions = actions();
        let items = config_items(3);
        let mut s = state();
        s.active = actions.len() + 1 + 2; // somewhere in items
        match handle_key(&mut s, &actions, &items, LlmMenuInput::Char('m')) {
            LlmMenuOutcome::Selected { value } => assert_eq!(value, "addMultiModal"),
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn unknown_char_is_continue() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Char('z'));
        assert_eq!(outcome, LlmMenuOutcome::Continue);
    }

    // ---- testing-mode swallows other input ---------------------------

    #[test]
    fn input_during_test_is_swallowed() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.testing = Some("Config0".to_owned());
        let before = s.active;
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Down);
        assert_eq!(outcome, LlmMenuOutcome::Continue);
        assert_eq!(s.active, before);
    }

    // ---- spinner ------------------------------------------------------

    #[test]
    fn spinner_tick_advances_frame_only_when_testing() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.testing = Some("Config0".to_owned());
        handle_key(&mut s, &actions, &items, LlmMenuInput::SpinnerTick);
        assert_eq!(s.spinner_frame, 1);

        let mut s2 = state();
        handle_key(&mut s2, &actions, &items, LlmMenuInput::SpinnerTick);
        assert_eq!(s2.spinner_frame, 0);
    }

    #[test]
    fn spinner_tick_wraps_using_wrapping_add() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.testing = Some("Config0".to_owned());
        s.spinner_frame = usize::MAX;
        handle_key(&mut s, &actions, &items, LlmMenuInput::SpinnerTick);
        assert_eq!(s.spinner_frame, 0); // wrapped
    }

    // ---- finish_test ---------------------------------------------------

    #[test]
    fn finish_test_clears_testing_marker_and_records_result() {
        let mut s = state();
        s.testing = Some("Config0".into());
        s.spinner_frame = 7;
        finish_test(
            &mut s,
            "Config0",
            TestResult { success: true, error: None },
        );
        assert!(s.testing.is_none());
        assert_eq!(s.spinner_frame, 0);
        assert!(s.results.get("Config0").map(|r| r.success).unwrap_or(false));
    }

    #[test]
    fn finish_test_for_different_config_records_but_keeps_testing_marker() {
        // Defensive: if results arrive out of order, we don't accidentally
        // clear the marker for the in-flight test.
        let mut s = state();
        s.testing = Some("ConfigA".into());
        finish_test(
            &mut s,
            "ConfigB",
            TestResult { success: false, error: Some("e".into()) },
        );
        assert_eq!(s.testing.as_deref(), Some("ConfigA"));
        assert!(s.results.contains_key("ConfigB"));
    }

    // ---- cancel -------------------------------------------------------

    #[test]
    fn ctrl_c_cancels_even_during_test() {
        // Cancel must beat the test-mode swallow.
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.testing = Some("Config0".into());
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::CtrlC);
        assert_eq!(outcome, LlmMenuOutcome::Cancel);
    }

    #[test]
    fn esc_cancels() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        let outcome = handle_key(&mut s, &actions, &items, LlmMenuInput::Escape);
        assert_eq!(outcome, LlmMenuOutcome::Cancel);
    }

    // ---- compose lines ------------------------------------------------

    #[test]
    fn compose_lines_show_no_configs_message_when_empty() {
        let s = state();
        let lines = compose_lines(&s, "Configurations", &actions(), &[]);
        assert!(lines.iter().any(|l| l.contains("No configurations yet")));
    }

    #[test]
    fn compose_lines_render_help_row_verbatim() {
        let s = state();
        let lines = compose_lines(&s, "Configurations", &actions(), &config_items(1));
        assert_eq!(
            lines.last().unwrap(),
            "  ↑↓ navigate • ⏎ select • t test • d delete"
        );
    }

    #[test]
    fn compose_lines_render_test_result_check_for_success() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.results.insert(
            "Config0".to_owned(),
            TestResult { success: true, error: None },
        );
        let lines = compose_lines(&s, "Configurations", &actions, &items);
        let row = lines.iter().find(|l| l.contains("Config0")).unwrap();
        assert!(row.contains(glyphs::CHECK), "got: {row}");
    }

    #[test]
    fn compose_lines_render_failure_glyph_and_dim_error_hint() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.results.insert(
            "Config0".to_owned(),
            TestResult { success: false, error: Some("invalid or expired API key".into()) },
        );
        let lines = compose_lines(&s, "Configurations", &actions, &items);
        let row = lines.iter().find(|l| l.contains("Config0")).unwrap();
        assert!(row.contains(glyphs::CROSS));
        assert!(row.contains("invalid or expired API key"));
    }

    #[test]
    fn compose_lines_render_spinner_glyph_when_testing() {
        let actions = actions();
        let items = config_items(1);
        let mut s = state();
        s.testing = Some("Config0".to_owned());
        s.spinner_frame = 3;
        let lines = compose_lines(&s, "Configurations", &actions, &items);
        let row = lines.iter().find(|l| l.contains("Config0")).unwrap();
        assert!(row.contains(SPINNER_FRAMES[3]), "got: {row}");
    }

    // ---- key event mapping --------------------------------------------

    #[test]
    fn from_key_event_maps_arrows_enter_esc_chars_ctrl_c() {
        fn ke(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::NONE) }
        fn ke_ctrl(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::CONTROL) }
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Up)), LlmMenuInput::Up);
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Down)), LlmMenuInput::Down);
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Enter)), LlmMenuInput::Enter);
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Esc)), LlmMenuInput::Escape);
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Char('t'))), LlmMenuInput::Char('t'));
        assert_eq!(
            LlmMenuInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            LlmMenuInput::CtrlC
        );
        assert_eq!(LlmMenuInput::from_key_event(ke(KeyCode::Tab)), LlmMenuInput::Other);
    }

    /// Pin: the active-row cursor's trailing space lands OUTSIDE the
    /// amber colour span. TS at `LLMConfigEditor.ts:122,129`:
    ///   const cursor = theme.icon.cursor;  // chalk.hex("#FFC107")("❯")
    ///   const pfx = isActive ? `${cursor} ` : "  ";
    /// Wire bytes: `\x1b[38;2;255;193;7m❯\x1b[<reset>m ` — literal space
    /// AFTER the foreground reset. See `role_menu_prompt`,
    /// `variant_list_prompt`, `agent_select_prompt`,
    /// `provider_select_prompt` for identical fixes; the systemic
    /// crossterm-vs-chalk reset-code divergence is documented in
    /// `docs/tui-port/QUESTIONS.md`. Tolerates either FG closer.
    #[test]
    fn render_frame_active_action_cursor_has_space_outside_amber_wrap() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        s.active = 0; // first action row
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Configure LLM models", &s, &actions, &items, 0).unwrap();
        let bytes = String::from_utf8(buf).expect("render output must be UTF-8");
        let space_outside_full_reset = bytes.contains("\x1b[38;2;255;193;7m❯\x1b[0m ");
        let space_outside_fg_reset = bytes.contains("\x1b[38;2;255;193;7m❯\x1b[39m ");
        assert!(
            space_outside_full_reset || space_outside_fg_reset,
            "active action cursor must emit `❯` + colour-closer + literal space; got {bytes:?}",
        );
        assert!(
            !bytes.contains("\x1b[38;2;255;193;7m❯ \x1b[0m")
                && !bytes.contains("\x1b[38;2;255;193;7m❯ \x1b[39m"),
            "must not wrap the cursor's trailing space inside the amber span; got {bytes:?}",
        );
    }

    /// Pin same `${cursor} ` rule for the active Done row.
    #[test]
    fn render_frame_active_done_cursor_has_space_outside_amber_wrap() {
        let actions = actions();
        let items = config_items(0);
        let mut s = state();
        s.active = actions.len(); // Done row
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Configure LLM models", &s, &actions, &items, 0).unwrap();
        let bytes = String::from_utf8(buf).expect("render output must be UTF-8");
        let with_full_reset = bytes.contains(
            "\x1b[38;2;255;193;7m❯\x1b[0m \x1b[38;5;214m\x1b[1m  Done",
        );
        let with_fg_reset = bytes.contains(
            "\x1b[38;2;255;193;7m❯\x1b[39m \x1b[38;5;214m\x1b[1m  Done",
        );
        assert!(
            with_full_reset || with_fg_reset,
            "Done row must emit cursor + close + literal space + ansi256(214)+bold for the label; got {bytes:?}",
        );
    }

    /// Pin same `${cursor} ` rule for the active config-item row.
    #[test]
    fn render_frame_active_item_cursor_has_space_outside_amber_wrap() {
        let actions = actions();
        let items = config_items(3);
        let mut s = state();
        // Item rows sit at indices `actions.len() + 1 + offset`.
        s.active = actions.len() + 1; // first config row
        let mut buf: Vec<u8> = Vec::new();
        render_frame(&mut buf, "Configure LLM models", &s, &actions, &items, 0).unwrap();
        let bytes = String::from_utf8(buf).expect("render output must be UTF-8");
        let space_outside_full_reset = bytes.contains("\x1b[38;2;255;193;7m❯\x1b[0m ");
        let space_outside_fg_reset = bytes.contains("\x1b[38;2;255;193;7m❯\x1b[39m ");
        assert!(
            space_outside_full_reset || space_outside_fg_reset,
            "active config-row cursor must emit `❯` + colour-closer + literal space; got {bytes:?}",
        );
        assert!(
            !bytes.contains("\x1b[38;2;255;193;7m❯ \x1b[0m")
                && !bytes.contains("\x1b[38;2;255;193;7m❯ \x1b[39m"),
            "must not wrap the cursor's trailing space inside the amber span; got {bytes:?}",
        );
    }
}

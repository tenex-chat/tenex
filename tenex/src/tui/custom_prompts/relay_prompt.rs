//! Onboarding relay prompt — a list of preset relay choices plus a free-text
//! input row. Source: `src/commands/onboard.ts:37-118`.
//!
//! Behaviours faithfully reproduced (in `RelayState`):
//!
//! - Up/Down: move cursor; clears any pending error.
//! - Enter on a `Choice` row: returns `item.value`.
//! - Enter on the `Input` row: prepends `input_prefix` (default `wss://`),
//!   runs the optional validator, surfaces error inline (red) if any,
//!   otherwise returns the assembled URL.
//! - Backspace on the `Input` row: deletes one char from `input_value`.
//! - Printable ASCII (≥0x20, no Ctrl modifier) on the `Input` row: appended.
//! - Any other key on a non-`Input` row: ignored.
//!
//! The render layer mirrors the TS template at lines 100-117.

use std::io::{self, Write};

use crossterm::cursor::{MoveTo, MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Color, Print, ResetColor, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};

use super::raw_mode::RawMode;
use crate::tui::glyphs;

const DEFAULT_INPUT_PREFIX: &str = "wss://";
const DEFAULT_INPUT_PLACEHOLDER: &str = "Type a relay URL";

/// One row in the prompt: either a fixed choice with a `value`, or the
/// free-text `Input` row.
#[derive(Debug, Clone)]
pub enum RelayItem {
    Choice {
        name: String,
        value: String,
        description: String,
    },
    Input,
}

/// Builder-shape for `relay_prompt`. The defaults match the TS source.
pub struct RelayPromptConfig<'a> {
    pub message: &'a str,
    pub items: Vec<RelayItem>,
    pub input_prefix: &'a str,
    pub input_placeholder: &'a str,
    pub validate: Option<Box<dyn Fn(&str) -> Result<(), String>>>,
}

impl<'a> RelayPromptConfig<'a> {
    /// Construct with TS defaults: prefix `wss://`, placeholder
    /// `Type a relay URL`, no validator.
    pub fn new(message: &'a str, items: Vec<RelayItem>) -> Self {
        Self {
            message,
            items,
            input_prefix: DEFAULT_INPUT_PREFIX,
            input_placeholder: DEFAULT_INPUT_PLACEHOLDER,
            validate: None,
        }
    }

    pub fn with_validator<F>(mut self, validator: F) -> Self
    where
        F: Fn(&str) -> Result<(), String> + 'static,
    {
        self.validate = Some(Box::new(validator));
        self
    }
}

// ---- pure state machine ---------------------------------------------------

/// Pure model of the prompt — no terminal I/O. The I/O loop drives this via
/// [`RelayState::handle_key`] / [`RelayState::compose_lines`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayState {
    pub active: usize,
    pub input_value: String,
    pub error: Option<String>,
    pub status: RelayStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayStatus {
    Idle,
    Done(String),
}

/// Result of feeding a keypress into the state machine.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum KeyOutcome {
    /// The state mutated and should be re-rendered.
    Continue,
    /// The state mutated and `state.status` is now `Done(_)` — the I/O loop
    /// should print the answer line and return.
    Finish,
    /// The user pressed Ctrl-C / Esc; the I/O loop should abort.
    Cancel,
}

impl RelayState {
    pub fn new() -> Self {
        Self {
            active: 0,
            input_value: String::new(),
            error: None,
            status: RelayStatus::Idle,
        }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        items: &[RelayItem],
        cfg: &RelayPromptConfig<'_>,
    ) -> KeyOutcome {
        let last_idx = items.len().saturating_sub(1);

        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return KeyOutcome::Cancel;
            }
            KeyCode::Esc => return KeyOutcome::Cancel,
            KeyCode::Up => {
                self.error = None;
                if self.active > 0 {
                    self.active -= 1;
                }
                return KeyOutcome::Continue;
            }
            KeyCode::Down => {
                self.error = None;
                if self.active < last_idx {
                    self.active += 1;
                }
                return KeyOutcome::Continue;
            }
            KeyCode::Enter => return self.confirm(items, cfg),
            _ => {}
        }

        // From here on: treat keys as input only when the active row is the
        // free-text Input row. Anything else is ignored.
        if !matches!(items.get(self.active), Some(RelayItem::Input)) {
            return KeyOutcome::Continue;
        }

        self.error = None;
        match key.code {
            KeyCode::Backspace => {
                self.input_value.pop();
            }
            KeyCode::Char(ch) => {
                if !key.modifiers.contains(KeyModifiers::CONTROL) && (ch as u32) >= 32 {
                    self.input_value.push(ch);
                }
            }
            _ => {}
        }
        KeyOutcome::Continue
    }

    fn confirm(&mut self, items: &[RelayItem], cfg: &RelayPromptConfig<'_>) -> KeyOutcome {
        match items.get(self.active) {
            Some(RelayItem::Choice { value, .. }) => {
                self.status = RelayStatus::Done(value.clone());
                KeyOutcome::Finish
            }
            Some(RelayItem::Input) => {
                let full = format!("{}{}", cfg.input_prefix, self.input_value);
                if let Some(validate) = cfg.validate.as_ref() {
                    if let Err(msg) = validate(&full) {
                        self.error = Some(msg);
                        return KeyOutcome::Continue;
                    }
                }
                self.status = RelayStatus::Done(full);
                KeyOutcome::Finish
            }
            None => KeyOutcome::Continue,
        }
    }

    /// Compose the rendered lines (without ANSI styling) — used by the I/O
    /// layer for layout calculations and by tests for verification. The
    /// styled render lives in [`relay_prompt`].
    pub fn compose_lines(
        &self,
        items: &[RelayItem],
        cfg: &RelayPromptConfig<'_>,
    ) -> Vec<String> {
        let mut out = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let cursor = if i == self.active {
                glyphs::CURSOR_HEAVY
            } else {
                " "
            };
            match item {
                RelayItem::Choice { name, description, .. } => {
                    let mut line = format!("{cursor} {name}");
                    if !description.is_empty() {
                        line.push_str(&format!("  {description}"));
                    }
                    out.push(line);
                }
                RelayItem::Input => {
                    let mut line = format!("{cursor} {}", cfg.input_placeholder);
                    if i == self.active {
                        let typed = format!("{}{}", cfg.input_prefix, self.input_value);
                        line.push_str(&format!("  {typed}"));
                    }
                    out.push(line);
                }
            }
        }
        out
    }
}

impl Default for RelayState {
    fn default() -> Self {
        Self::new()
    }
}

// ---- I/O loop --------------------------------------------------------------

/// Run the relay prompt to completion. Blocks the thread until the user
/// confirms (Enter on a row) or cancels (Ctrl-C / Esc).
///
/// Returns:
/// - `Ok(Some(url))` on confirmation.
/// - `Ok(None)` on Ctrl-C / Esc cancellation.
/// - `Err(e)` on a terminal-I/O failure.
pub fn relay_prompt(cfg: RelayPromptConfig<'_>) -> io::Result<Option<String>> {
    if cfg.items.is_empty() {
        return Ok(None);
    }

    let _guard = RawMode::enter()?;
    let mut state = RelayState::new();
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, &state, &cfg, prev_height)?;

        let event = event::read()?;
        let key = match event {
            Event::Key(k) => k,
            _ => continue,
        };

        match state.handle_key(key, &cfg.items, &cfg) {
            KeyOutcome::Continue => continue,
            KeyOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(None);
            }
            KeyOutcome::Finish => {
                clear_frame(&mut stdout, prev_height)?;
                let answer = match &state.status {
                    RelayStatus::Done(s) => s.clone(),
                    RelayStatus::Idle => unreachable!("Finish implies Done"),
                };
                render_done(&mut stdout, cfg.message, &answer)?;
                return Ok(Some(answer));
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    state: &RelayState,
    cfg: &RelayPromptConfig<'_>,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;

    // Header: "<amber ?> <message>"
    queue!(stdout, MoveToColumn(0))?;
    style_amber(stdout, "?")?;
    queue!(stdout, Print(format!(" {}\r\n", cfg.message)))?;

    let lines = state.compose_lines(&cfg.items, cfg);
    let mut height: u16 = 1; // header
    for (i, line) in lines.iter().enumerate() {
        let is_active = i == state.active;
        if is_active {
            queue!(stdout, SetForegroundColor(Color::Rgb { r: 0xFF, g: 0xC1, b: 0x07 }))?;
            queue!(stdout, Print(line))?;
            queue!(stdout, ResetColor)?;
        } else {
            queue!(stdout, Print(line))?;
        }
        queue!(stdout, Print("\r\n"))?;
        height += 1;
    }

    if let Some(err) = &state.error {
        queue!(stdout, SetForegroundColor(Color::DarkRed))?;
        queue!(stdout, Print(err))?;
        queue!(stdout, ResetColor)?;
        queue!(stdout, Print("\r\n"))?;
        height += 1;
    }

    stdout.flush()?;
    Ok(height)
}

fn clear_frame<W: Write>(stdout: &mut W, height: u16) -> io::Result<()> {
    if height == 0 {
        return Ok(());
    }
    // Move up to the top of the previous render and clear from there down.
    if height > 1 {
        stdout.queue(MoveUp(height - 1))?;
    }
    stdout.queue(MoveToColumn(0))?;
    stdout.queue(Clear(ClearType::FromCursorDown))?;
    stdout.flush()
}

fn render_done<W: Write>(stdout: &mut W, message: &str, answer: &str) -> io::Result<()> {
    // Final line: "<green ✓> <message> <amber answer>"
    queue!(stdout, SetForegroundColor(Color::DarkGreen))?;
    queue!(stdout, Print("✓"))?;
    queue!(stdout, ResetColor)?;
    queue!(stdout, Print(format!(" {message} ")))?;
    queue!(stdout, SetForegroundColor(Color::Rgb { r: 0xFF, g: 0xC1, b: 0x07 }))?;
    queue!(stdout, Print(answer))?;
    queue!(stdout, ResetColor)?;
    queue!(stdout, Print("\r\n"))?;
    stdout.flush()
}

fn style_amber<W: Write>(stdout: &mut W, s: &str) -> io::Result<()> {
    queue!(stdout, SetForegroundColor(Color::Rgb { r: 0xFF, g: 0xC1, b: 0x07 }))?;
    queue!(stdout, Print(s))?;
    queue!(stdout, ResetColor)?;
    Ok(())
}

// `MoveTo` is currently unused but reserved for future absolute-positioning
// frames; suppress the dead-code warning while keeping it imported.
#[allow(dead_code)]
fn _force_used_imports(_: MoveTo) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    fn sample_items() -> Vec<RelayItem> {
        vec![
            RelayItem::Choice {
                name: "TENEX Community Relay".into(),
                value: "wss://tenex.chat".into(),
                description: "wss://tenex.chat".into(),
            },
            RelayItem::Input,
        ]
    }

    #[test]
    fn down_arrow_moves_cursor_to_input_row() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        let r = state.handle_key(ev(KeyCode::Down), &items, &cfg);
        assert_eq!(r, KeyOutcome::Continue);
        assert_eq!(state.active, 1);
    }

    #[test]
    fn down_arrow_clamps_at_last_row() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        assert_eq!(state.active, 1); // never goes past last
    }

    #[test]
    fn up_arrow_clamps_at_zero() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Up), &items, &cfg);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn enter_on_choice_finishes_with_value() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        let r = state.handle_key(ev(KeyCode::Enter), &items, &cfg);
        assert_eq!(r, KeyOutcome::Finish);
        assert_eq!(state.status, RelayStatus::Done("wss://tenex.chat".into()));
    }

    #[test]
    fn enter_on_input_with_validator_failure_stays_idle_and_records_error() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone())
            .with_validator(|_| Err("Enter a relay hostname".into()));
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg); // move to input row
        let r = state.handle_key(ev(KeyCode::Enter), &items, &cfg);
        assert_eq!(r, KeyOutcome::Continue);
        assert_eq!(state.status, RelayStatus::Idle);
        assert_eq!(state.error.as_deref(), Some("Enter a relay hostname"));
    }

    #[test]
    fn enter_on_input_with_validator_pass_finishes_with_prefixed_url() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone()).with_validator(|_| Ok(()));
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        for ch in "relay.example".chars() {
            state.handle_key(ev(KeyCode::Char(ch)), &items, &cfg);
        }
        let r = state.handle_key(ev(KeyCode::Enter), &items, &cfg);
        assert_eq!(r, KeyOutcome::Finish);
        assert_eq!(
            state.status,
            RelayStatus::Done("wss://relay.example".into())
        );
    }

    #[test]
    fn typing_on_input_row_appends_chars() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        for ch in "rel.io".chars() {
            state.handle_key(ev(KeyCode::Char(ch)), &items, &cfg);
        }
        assert_eq!(state.input_value, "rel.io");
    }

    #[test]
    fn typing_on_choice_row_is_ignored() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Char('a')), &items, &cfg);
        assert_eq!(state.input_value, "");
    }

    #[test]
    fn backspace_removes_one_char() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        for ch in "abc".chars() {
            state.handle_key(ev(KeyCode::Char(ch)), &items, &cfg);
        }
        state.handle_key(ev(KeyCode::Backspace), &items, &cfg);
        assert_eq!(state.input_value, "ab");
    }

    #[test]
    fn ctrl_modified_chars_do_not_append() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        state.handle_key(ctrl(KeyCode::Char('a')), &items, &cfg);
        assert_eq!(state.input_value, "");
    }

    #[test]
    fn ctrl_c_signals_cancel() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        let r = state.handle_key(ctrl(KeyCode::Char('c')), &items, &cfg);
        assert_eq!(r, KeyOutcome::Cancel);
    }

    #[test]
    fn esc_signals_cancel() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        let r = state.handle_key(ev(KeyCode::Esc), &items, &cfg);
        assert_eq!(r, KeyOutcome::Cancel);
    }

    #[test]
    fn arrow_keys_clear_pending_error() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone())
            .with_validator(|_| Err("invalid".into()));
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg); // input row
        state.handle_key(ev(KeyCode::Enter), &items, &cfg); // record error
        assert!(state.error.is_some());
        state.handle_key(ev(KeyCode::Up), &items, &cfg);
        assert!(state.error.is_none());
    }

    #[test]
    fn typing_clears_pending_error() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone())
            .with_validator(|_| Err("invalid".into()));
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        state.handle_key(ev(KeyCode::Enter), &items, &cfg);
        assert!(state.error.is_some());
        state.handle_key(ev(KeyCode::Char('a')), &items, &cfg);
        assert!(state.error.is_none());
    }

    #[test]
    fn compose_lines_renders_choice_with_description() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let state = RelayState::new();
        let lines = state.compose_lines(&items, &cfg);
        assert!(lines[0].contains("TENEX Community Relay"));
        assert!(lines[0].contains("wss://tenex.chat"));
        assert!(lines[0].starts_with(glyphs::CURSOR_HEAVY));
    }

    #[test]
    fn compose_lines_inactive_input_shows_placeholder_only() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let state = RelayState::new();
        let lines = state.compose_lines(&items, &cfg);
        // Active is row 0 (choice), so input row is inactive: only placeholder,
        // no `wss://` echo.
        assert_eq!(lines[1], format!("  {}", "Type a relay URL"));
    }

    #[test]
    fn compose_lines_active_input_shows_typed_url_with_prefix() {
        let items = sample_items();
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        state.handle_key(ev(KeyCode::Down), &items, &cfg);
        for ch in "x.io".chars() {
            state.handle_key(ev(KeyCode::Char(ch)), &items, &cfg);
        }
        let lines = state.compose_lines(&items, &cfg);
        assert!(lines[1].contains("Type a relay URL"));
        assert!(lines[1].contains("wss://x.io"));
        assert!(lines[1].starts_with(glyphs::CURSOR_HEAVY));
    }

    #[test]
    fn empty_items_returns_none_immediately() {
        // I/O loop: covered indirectly by the early-return check in
        // `relay_prompt`. Construct the state machine with no items and
        // verify a confirm at index 0 doesn't panic.
        let items: Vec<RelayItem> = vec![];
        let cfg = RelayPromptConfig::new("Relay", items.clone());
        let mut state = RelayState::new();
        let r = state.handle_key(ev(KeyCode::Enter), &items, &cfg);
        assert_eq!(r, KeyOutcome::Continue);
        assert_eq!(state.status, RelayStatus::Idle);
    }
}

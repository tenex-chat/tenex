//! Meta-model variant editor — bespoke list prompt.
//!
//! Source: `src/llm/utils/variant-list-prompt.ts:22-158`. The TS version is
//! built on `@inquirer/core` `createPrompt` and yields back to the screen
//! layer with one of three actions (edit / add / done); the screen then
//! invokes inquire-stock prompts to gather variant fields and re-enters
//! this prompt with the augmented state. The Rust port mirrors that split:
//! a pure state machine here, the screen-layer dispatch in `config_cmd`.
//!
//! Behaviours (TS lines cited inline in tests):
//!
//! - **Up/Down** clamp to `[0, itemCount - 1]` where
//!   `itemCount = variant_names.len + 2` (one row per variant + an "Add
//!   variant" row + a "Done" row).
//! - **Enter on variant row** → [`VariantOutcome::Edit`].
//! - **Enter on add row** → [`VariantOutcome::Add`].
//! - **Enter on done row** → [`VariantOutcome::Done`] *only* when
//!   `variant_names.len >= 2`; otherwise the keystroke is a no-op (matches
//!   `:79`).
//! - **`d` on variant row** sets `default_variant` to that row's name
//!   (`:86-88`).
//! - **Backspace / Delete on variant row** deletes the variant *only* when
//!   `variant_names.len > 2` (`:93`); reassigns `default_variant` to the
//!   first remaining when the deleted one was default (`:102-105`); clamps
//!   `active` to the new last index when the active row was removed.
//!
//! Cursor glyph: `›` (U+203A) in `#FFC107` — same `amber` truecolour the
//! TS prompt uses at `:115`.

use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};
use indexmap::IndexMap;

use super::raw_mode::RawMode;
use crate::tui::glyphs;

// Palette aliases sourced from the shared theme module.
const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;
const ANSI214_ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;

/// Width of the rule rendered between variant rows and the action rows.
/// Source: `variant-list-prompt.ts:133` (40 `─` chars).
pub const RULE_WIDTH: usize = 40;

/// Action emitted when the user confirms a row. The screen layer matches
/// on this and either opens the variant-detail editor (`Edit`), the
/// add-variant flow (`Add`), or persists and exits (`Done`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantOutcome {
    /// State mutated; redraw and keep looping.
    Continue,
    /// User pressed Ctrl-C / Esc; abort the whole flow.
    Cancel,
    /// User pressed Enter on a variant row.
    Edit { variant_name: String },
    /// User pressed Enter on the "Add variant" row.
    Add,
    /// User pressed Enter on "Done" with ≥2 variants.
    Done,
}

/// Lite mirror of `MetaModelVariant` (`src/services/config/types.ts:349-354`).
/// All fields are owned `String`s for simplicity at this layer; the store
/// layer ([`crate::store::llms::MetaVariant`]) is the canonical persistence
/// shape.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetaVariantData {
    pub model: String,
    pub keywords: Vec<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
}

/// Pure model — no terminal I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantListState {
    pub variants: IndexMap<String, MetaVariantData>,
    pub default_variant: String,
    pub active: usize,
}

impl VariantListState {
    pub fn new(variants: IndexMap<String, MetaVariantData>, default_variant: String) -> Self {
        Self {
            variants,
            default_variant,
            active: 0,
        }
    }
}

/// Compact key event abstraction (shared shape with the other custom prompts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariantInput {
    Up,
    Down,
    Enter,
    Backspace,
    Delete,
    SetDefault,
    Escape,
    CtrlC,
    Other,
}

impl VariantInput {
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
            return VariantInput::CtrlC;
        }
        match ev.code {
            KeyCode::Up => VariantInput::Up,
            KeyCode::Down => VariantInput::Down,
            KeyCode::Enter => VariantInput::Enter,
            KeyCode::Backspace => VariantInput::Backspace,
            KeyCode::Delete => VariantInput::Delete,
            KeyCode::Esc => VariantInput::Escape,
            KeyCode::Char('d') => VariantInput::SetDefault,
            _ => VariantInput::Other,
        }
    }
}

/// Drive the state machine with one keystroke.
pub fn handle_key(state: &mut VariantListState, key: VariantInput) -> VariantOutcome {
    if matches!(key, VariantInput::CtrlC | VariantInput::Escape) {
        return VariantOutcome::Cancel;
    }

    let names: Vec<String> = state.variants.keys().cloned().collect();
    let add_index = names.len();
    let done_index = names.len() + 1;
    let item_count = names.len() + 2;

    match key {
        VariantInput::Up => {
            if state.active > 0 {
                state.active -= 1;
            }
            VariantOutcome::Continue
        }
        VariantInput::Down => {
            if state.active + 1 < item_count {
                state.active += 1;
            }
            VariantOutcome::Continue
        }
        VariantInput::Enter => {
            if state.active < names.len() {
                let name = names[state.active].clone();
                VariantOutcome::Edit { variant_name: name }
            } else if state.active == add_index {
                VariantOutcome::Add
            } else if state.active == done_index {
                if names.len() >= 2 {
                    VariantOutcome::Done
                } else {
                    VariantOutcome::Continue
                }
            } else {
                VariantOutcome::Continue
            }
        }
        VariantInput::SetDefault => {
            if let Some(name) = names.get(state.active) {
                state.default_variant = name.clone();
            }
            VariantOutcome::Continue
        }
        VariantInput::Backspace | VariantInput::Delete => {
            if state.active < names.len() && names.len() > 2 {
                let to_delete = names[state.active].clone();
                state.variants.shift_remove(&to_delete);
                if state.default_variant == to_delete {
                    state.default_variant = state
                        .variants
                        .keys()
                        .next()
                        .cloned()
                        .unwrap_or_default();
                }
                let new_count = state.variants.len();
                if state.active >= new_count {
                    state.active = new_count.saturating_sub(1);
                }
            }
            VariantOutcome::Continue
        }
        VariantInput::Other => VariantOutcome::Continue,
        VariantInput::Escape | VariantInput::CtrlC => VariantOutcome::Cancel,
    }
}

/// Compose the rendered lines (unstyled — colour applied at render time by
/// the I/O layer). Lines map directly to the TS template at
/// `variant-list-prompt.ts:114-156`.
pub fn compose_lines(state: &VariantListState, message: &str) -> Vec<String> {
    let names: Vec<String> = state.variants.keys().cloned().collect();
    let add_index = names.len();
    let done_index = names.len() + 1;
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    let mut out = Vec::with_capacity(names.len() + 6);
    out.push(format!("? {message}"));
    out.push(String::new());
    out.push("  Variants:".to_owned());

    for (i, name) in names.iter().enumerate() {
        let pfx = if i == state.active {
            cursor_active.clone()
        } else {
            "  ".to_string()
        };
        let model = state
            .variants
            .get(name)
            .map(|v| v.model.as_str())
            .unwrap_or("");
        let default_tag = if *name == state.default_variant {
            " (default)"
        } else {
            ""
        };
        out.push(format!("{pfx}{name} [{model}]{default_tag}"));
    }

    out.push(format!("  {}", "─".repeat(RULE_WIDTH)));

    let add_pfx = if state.active == add_index {
        cursor_active.clone()
    } else {
        "  ".to_string()
    };
    out.push(format!("{add_pfx}Add variant"));

    let done_pfx = if state.active == done_index {
        cursor_active
    } else {
        "  ".to_string()
    };
    if names.len() < 2 {
        out.push(format!("{done_pfx}Done (need at least 2 variants)"));
    } else {
        // The Done label is rendered with its own ansi256-#214 bold style and
        // a leading two-space pad at the I/O layer (`display.doneLabel`).
        out.push(format!("{done_pfx}  Done"));
    }

    out.push(
        "  ↑↓ navigate • ⏎ edit • d set default • ⌫ remove".to_string(),
    );

    out
}

// =========================================================================
// I/O loop
// =========================================================================

/// Result of running [`variant_list_prompt`]. The screen layer matches the
/// emitted action and either opens the variant-detail editor (`Edit`),
/// the add-variant flow (`Add`), persists (`Done`), or aborts (`Cancelled`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantListResult {
    Edit {
        state: VariantListState,
        variant_name: String,
    },
    Add {
        state: VariantListState,
    },
    Done {
        state: VariantListState,
    },
    Cancelled,
}

/// Run the bespoke variant-list prompt to completion. Blocks until the user
/// confirms a row or cancels.
pub fn variant_list_prompt(
    message: &str,
    state: VariantListState,
) -> io::Result<VariantListResult> {
    let _guard = RawMode::enter()?;
    let mut state = state;
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, message, &state, prev_height)?;

        let key = match event::read()? {
            Event::Key(k) => k,
            _ => continue,
        };
        let input = VariantInput::from_key_event(key);

        match handle_key(&mut state, input) {
            VariantOutcome::Continue => continue,
            VariantOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(VariantListResult::Cancelled);
            }
            VariantOutcome::Edit { variant_name } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(VariantListResult::Edit {
                    state,
                    variant_name,
                });
            }
            VariantOutcome::Add => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(VariantListResult::Add { state });
            }
            VariantOutcome::Done => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(VariantListResult::Done { state });
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    state: &VariantListState,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    // Header: amber `?` + message
    queue!(stdout, SetForegroundColor(AMBER), Print("?"), ResetColor)?;
    queue!(stdout, Print(format!(" {message}\r\n")))?;
    queue!(stdout, Print("\r\n"))?;
    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("  Variants:"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    let mut height: u16 = 3;

    let names: Vec<String> = state.variants.keys().cloned().collect();
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    for (i, name) in names.iter().enumerate() {
        let is_active = i == state.active;
        let pfx = if is_active { cursor_active.as_str() } else { "  " };
        if is_active {
            queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
        } else {
            queue!(stdout, Print(pfx))?;
        }
        let model = state
            .variants
            .get(name)
            .map(|v| v.model.as_str())
            .unwrap_or("");
        queue!(stdout, Print(format!("{name} ")))?;
        // gray model
        queue!(
            stdout,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("[{model}]")),
            ResetColor,
        )?;
        if *name == state.default_variant {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(" (default)"),
                SetAttribute(Attribute::Reset),
            )?;
        }
        queue!(stdout, Print("\r\n"))?;
        height += 1;
    }

    // Rule. TS at variant-list-prompt.ts:133 emits the rule WITHOUT
    // any styling: `lines.push(\`  ${"─".repeat(40)}\`)`. Don't wrap
    // in dim — match TS's plain-foreground render.
    queue!(
        stdout,
        Print("  "),
        Print("─".repeat(RULE_WIDTH)),
        Print("\r\n"),
    )?;
    height += 1;

    // Add row.
    let add_index = names.len();
    let done_index = names.len() + 1;
    let pfx = if state.active == add_index {
        cursor_active.as_str()
    } else {
        "  "
    };
    if state.active == add_index {
        queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
    } else {
        queue!(stdout, Print(pfx))?;
    }
    queue!(
        stdout,
        SetForegroundColor(Color::DarkCyan),
        Print("Add variant"),
        ResetColor,
        Print("\r\n"),
    )?;
    height += 1;

    // Done row.
    let pfx = if state.active == done_index {
        cursor_active.as_str()
    } else {
        "  "
    };
    if state.active == done_index {
        queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
    } else {
        queue!(stdout, Print(pfx))?;
    }
    if names.len() < 2 {
        queue!(
            stdout,
            SetAttribute(Attribute::Dim),
            Print("Done (need at least 2 variants)"),
            SetAttribute(Attribute::Reset),
            Print("\r\n"),
        )?;
    } else {
        queue!(
            stdout,
            SetForegroundColor(ANSI214_ACCENT),
            SetAttribute(Attribute::Bold),
            Print("  Done"),
            SetAttribute(Attribute::Reset),
            ResetColor,
            Print("\r\n"),
        )?;
    }
    height += 1;

    // Help.
    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("  ↑↓ navigate • ⏎ edit • d set default • ⌫ remove"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
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

    fn variant(model: &str) -> MetaVariantData {
        MetaVariantData {
            model: model.into(),
            ..Default::default()
        }
    }

    fn three_variants() -> IndexMap<String, MetaVariantData> {
        let mut m = IndexMap::new();
        m.insert("fast".into(), variant("m-fast"));
        m.insert("smart".into(), variant("m-smart"));
        m.insert("deep".into(), variant("m-deep"));
        m
    }

    fn state_with(variants: IndexMap<String, MetaVariantData>, default: &str) -> VariantListState {
        VariantListState::new(variants, default.into())
    }

    // ---- navigation -----------------------------------------------------

    #[test]
    fn up_clamps_at_zero() {
        let mut state = state_with(three_variants(), "fast");
        handle_key(&mut state, VariantInput::Up);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn down_clamps_at_done_row() {
        let mut state = state_with(three_variants(), "fast");
        for _ in 0..20 {
            handle_key(&mut state, VariantInput::Down);
        }
        // 3 variants + Add + Done = 5 rows, last index = 4
        assert_eq!(state.active, 4);
    }

    // ---- enter actions --------------------------------------------------

    #[test]
    fn enter_on_variant_row_yields_edit() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 1;
        let outcome = handle_key(&mut state, VariantInput::Enter);
        assert_eq!(outcome, VariantOutcome::Edit { variant_name: "smart".into() });
    }

    #[test]
    fn enter_on_add_row_yields_add() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 3;
        assert_eq!(handle_key(&mut state, VariantInput::Enter), VariantOutcome::Add);
    }

    #[test]
    fn enter_on_done_with_two_or_more_variants_yields_done() {
        let mut variants = IndexMap::new();
        variants.insert("a".into(), variant("ma"));
        variants.insert("b".into(), variant("mb"));
        let mut state = state_with(variants, "a");
        state.active = 3; // 2 variants + Add + Done = 4 rows; done_index=3
        assert_eq!(handle_key(&mut state, VariantInput::Enter), VariantOutcome::Done);
    }

    #[test]
    fn enter_on_done_with_fewer_than_two_variants_is_noop() {
        let mut variants = IndexMap::new();
        variants.insert("only".into(), variant("m"));
        let mut state = state_with(variants, "only");
        state.active = 2; // 1 variant + Add + Done = 3 rows; done_index=2
        let outcome = handle_key(&mut state, VariantInput::Enter);
        assert_eq!(outcome, VariantOutcome::Continue);
    }

    // ---- set default ----------------------------------------------------

    #[test]
    fn d_on_variant_row_sets_default() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 2;
        handle_key(&mut state, VariantInput::SetDefault);
        assert_eq!(state.default_variant, "deep");
    }

    #[test]
    fn d_on_action_row_is_noop() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 3; // Add row
        handle_key(&mut state, VariantInput::SetDefault);
        assert_eq!(state.default_variant, "fast");
    }

    // ---- delete ---------------------------------------------------------

    #[test]
    fn delete_with_only_two_variants_is_noop() {
        let mut variants = IndexMap::new();
        variants.insert("a".into(), variant("ma"));
        variants.insert("b".into(), variant("mb"));
        let mut state = state_with(variants, "a");
        state.active = 0;
        handle_key(&mut state, VariantInput::Backspace);
        assert_eq!(state.variants.len(), 2);
    }

    #[test]
    fn delete_with_three_variants_removes_one() {
        let mut state = state_with(three_variants(), "smart");
        state.active = 0;
        handle_key(&mut state, VariantInput::Backspace);
        assert_eq!(state.variants.len(), 2);
        assert!(!state.variants.contains_key("fast"));
    }

    #[test]
    fn delete_default_variant_reassigns_to_first_remaining() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 0;
        handle_key(&mut state, VariantInput::Delete);
        // After deletion the first remaining is "smart" (insertion order).
        assert_eq!(state.default_variant, "smart");
    }

    #[test]
    fn delete_clamps_active_when_active_was_last() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 2; // last variant row
        handle_key(&mut state, VariantInput::Backspace);
        // 2 variants remain → max variant index = 1.
        assert_eq!(state.active, 1);
    }

    #[test]
    fn delete_keeps_active_in_bounds_when_active_was_middle() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 1;
        handle_key(&mut state, VariantInput::Backspace);
        assert_eq!(state.active, 1);
    }

    // ---- cancel ---------------------------------------------------------

    #[test]
    fn ctrl_c_cancels() {
        let mut state = state_with(three_variants(), "fast");
        assert_eq!(handle_key(&mut state, VariantInput::CtrlC), VariantOutcome::Cancel);
    }

    #[test]
    fn esc_cancels() {
        let mut state = state_with(three_variants(), "fast");
        assert_eq!(handle_key(&mut state, VariantInput::Escape), VariantOutcome::Cancel);
    }

    // ---- compose lines --------------------------------------------------

    #[test]
    fn compose_lines_marks_default_variant() {
        let state = state_with(three_variants(), "smart");
        let lines = compose_lines(&state, "Edit variants");
        let smart_line = lines.iter().find(|l| l.contains("smart")).unwrap();
        assert!(smart_line.contains("(default)"), "got: {smart_line}");
        let fast_line = lines.iter().find(|l| l.contains("fast")).unwrap();
        assert!(!fast_line.contains("(default)"));
    }

    #[test]
    fn compose_lines_renders_model_in_brackets() {
        let state = state_with(three_variants(), "fast");
        let lines = compose_lines(&state, "Edit variants");
        let fast_line = lines.iter().find(|l| l.contains("fast")).unwrap();
        assert!(fast_line.contains("[m-fast]"), "got: {fast_line}");
    }

    #[test]
    fn compose_lines_uses_thin_chevron_for_active_row() {
        let mut state = state_with(three_variants(), "fast");
        state.active = 0;
        let lines = compose_lines(&state, "Edit variants");
        // Find the active variant row (fast); it must start with `›`.
        let active_row = lines
            .iter()
            .find(|l| l.contains("fast") && l.contains("[m-fast]"))
            .unwrap();
        assert!(active_row.starts_with(glyphs::CURSOR_THIN), "got: {active_row}");
    }

    #[test]
    fn compose_lines_done_row_text_when_two_or_more() {
        let state = state_with(three_variants(), "fast");
        let lines = compose_lines(&state, "Edit variants");
        // The done row appears between rule and help; check verbatim text.
        assert!(lines.iter().any(|l| l.trim_start() == "Done" || l.contains("  Done")));
    }

    #[test]
    fn compose_lines_done_row_warns_when_fewer_than_two() {
        let mut variants = IndexMap::new();
        variants.insert("only".into(), variant("m"));
        let state = state_with(variants, "only");
        let lines = compose_lines(&state, "Edit variants");
        assert!(lines
            .iter()
            .any(|l| l.contains("Done (need at least 2 variants)")));
    }

    #[test]
    fn compose_lines_help_row_text_verbatim() {
        let state = state_with(three_variants(), "fast");
        let lines = compose_lines(&state, "Edit variants");
        assert_eq!(
            lines.last().unwrap(),
            "  ↑↓ navigate • ⏎ edit • d set default • ⌫ remove"
        );
    }

    #[test]
    fn compose_lines_rule_width_matches_spec() {
        let state = state_with(three_variants(), "fast");
        let lines = compose_lines(&state, "Edit variants");
        let rule = lines.iter().find(|l| l.contains('─')).unwrap();
        assert_eq!(rule.matches('─').count(), RULE_WIDTH);
    }

    // ---- VariantInput::from_key_event ----------------------------------

    fn ke(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ke_ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    #[test]
    fn from_key_event_maps_arrows_enter_and_d() {
        assert_eq!(VariantInput::from_key_event(ke(KeyCode::Up)), VariantInput::Up);
        assert_eq!(VariantInput::from_key_event(ke(KeyCode::Down)), VariantInput::Down);
        assert_eq!(VariantInput::from_key_event(ke(KeyCode::Enter)), VariantInput::Enter);
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Char('d'))),
            VariantInput::SetDefault,
        );
    }

    #[test]
    fn from_key_event_maps_backspace_and_delete_distinctly() {
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Backspace)),
            VariantInput::Backspace,
        );
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Delete)),
            VariantInput::Delete,
        );
    }

    #[test]
    fn from_key_event_maps_escape_and_ctrl_c() {
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Esc)),
            VariantInput::Escape,
        );
        assert_eq!(
            VariantInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            VariantInput::CtrlC,
        );
    }

    #[test]
    fn from_key_event_maps_unknown_to_other() {
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Tab)),
            VariantInput::Other,
        );
        assert_eq!(
            VariantInput::from_key_event(ke(KeyCode::Char('x'))),
            VariantInput::Other,
        );
    }
}

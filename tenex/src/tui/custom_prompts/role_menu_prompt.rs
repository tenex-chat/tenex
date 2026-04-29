//! Role-assignment menu — bespoke list prompt that maps the six TENEX
//! LLM roles to a named LLM configuration.
//!
//! Source: `src/commands/config/roles.ts:148-200`. The TS prompt yields
//! back to the screen layer with one of two actions (`edit` for a specific
//! role or `done`); the screen then opens an inquire-stock select to pick
//! a new configuration and re-enters this prompt with the augmented
//! assignments map. The Rust port mirrors that split.
//!
//! The six roles, their labels, and the recommendation strings are
//! reproduced **byte-for-byte** from `MODEL_ROLES` (`roles.ts:22-29`).
//!
//! Behaviours:
//! - Up/Down clamp to `[0, role_count]` (last index = Done row).
//! - Enter on a role row → [`RoleOutcome::Edit`].
//! - Enter on Done row → [`RoleOutcome::Done`].
//! - Esc / Ctrl-C → [`RoleOutcome::Cancel`].
//!
//! Cursor: `›` (U+203A) in `#FFC107` per `roles.ts:174`.
//! Active recommendation tint: `#FFC107` dim. Inactive: ansi256-#240
//! (`roles.ts:184-186`). Both are reproduced exactly in the I/O render.

use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};
use indexmap::IndexMap;

use super::raw_mode::RawMode;
use crate::tui::glyphs;

const AMBER: Color = Color::Rgb {
    r: 0xFF,
    g: 0xC1,
    b: 0x07,
};
const ANSI214_ACCENT: Color = Color::AnsiValue(214);
const ANSI240_MUTED: Color = Color::AnsiValue(240);

/// Width of the rule rendered between role rows and the Done row.
/// Source: `roles.ts:191`.
pub const RULE_WIDTH: usize = 40;

/// Logical role keys — match `LLMRoleKey` (`roles.ts:14-20`).
/// String form (via [`RoleKey::as_str`]) matches the JSON / TS field names
/// exactly so this type can be passed straight to
/// [`crate::store::llms::LlmsDoc::set_*`] role setters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RoleKey {
    Default,
    Summarization,
    Supervision,
    PromptCompilation,
    Categorization,
    ContextDiscovery,
}

impl RoleKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Summarization => "summarization",
            Self::Supervision => "supervision",
            Self::PromptCompilation => "promptCompilation",
            Self::Categorization => "categorization",
            Self::ContextDiscovery => "contextDiscovery",
        }
    }

    /// Display label shown in the prompt. Source: `roles.ts:22-29`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Default => "Default",
            Self::Summarization => "Summarization",
            Self::Supervision => "Supervision",
            Self::PromptCompilation => "Prompt Compilation",
            Self::Categorization => "Categorization",
            Self::ContextDiscovery => "Context Discovery",
        }
    }

    /// Recommendation string shown beneath each role. Reproduced verbatim
    /// from `roles.ts:22-29` — including the em-dash and casing.
    pub fn recommendation(self) -> &'static str {
        match self {
            Self::Default => {
                "The default model all agents get — pick your best all-rounder"
            }
            Self::Summarization => {
                "Used for conversation metadata (summaries, titles) — choose a cheap model with a large context window"
            }
            Self::Supervision => {
                "Evaluates agent work and decides next steps — choose a model with strong reasoning"
            }
            Self::PromptCompilation => {
                "Distills lessons into system prompts — choose a smart model with a large context window"
            }
            Self::Categorization => {
                "Classifies agent roles — choose a cheap, fast model"
            }
            Self::ContextDiscovery => {
                "Plans proactive memory searches — choose a cheap, fast model with reliable JSON output"
            }
        }
    }
}

/// Fixed display order — matches `MODEL_ROLES` (`roles.ts:22-29`).
pub const ROLES: [RoleKey; 6] = [
    RoleKey::Default,
    RoleKey::Summarization,
    RoleKey::Supervision,
    RoleKey::PromptCompilation,
    RoleKey::Categorization,
    RoleKey::ContextDiscovery,
];

/// Pure model — no terminal I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleMenuState {
    /// Per-role assignment to a named LLM configuration. The screen layer
    /// pre-fills missing roles with the `default` config (`roles.ts:111-115`)
    /// before constructing the state.
    pub assignments: IndexMap<RoleKey, String>,
    pub active: usize,
}

impl RoleMenuState {
    pub fn new(assignments: IndexMap<RoleKey, String>) -> Self {
        Self {
            assignments,
            active: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleInput {
    Up,
    Down,
    Enter,
    Escape,
    CtrlC,
    Other,
}

impl RoleInput {
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
            return RoleInput::CtrlC;
        }
        match ev.code {
            KeyCode::Up => RoleInput::Up,
            KeyCode::Down => RoleInput::Down,
            KeyCode::Enter => RoleInput::Enter,
            KeyCode::Esc => RoleInput::Escape,
            _ => RoleInput::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleOutcome {
    Continue,
    Cancel,
    Edit { role_key: RoleKey },
    Done,
}

pub fn handle_key(state: &mut RoleMenuState, key: RoleInput) -> RoleOutcome {
    if matches!(key, RoleInput::CtrlC | RoleInput::Escape) {
        return RoleOutcome::Cancel;
    }
    let role_count = ROLES.len();
    let item_count = role_count + 1; // + Done row

    match key {
        RoleInput::Up => {
            if state.active > 0 {
                state.active -= 1;
            }
            RoleOutcome::Continue
        }
        RoleInput::Down => {
            if state.active + 1 < item_count {
                state.active += 1;
            }
            RoleOutcome::Continue
        }
        RoleInput::Enter => {
            if state.active < role_count {
                RoleOutcome::Edit {
                    role_key: ROLES[state.active],
                }
            } else {
                RoleOutcome::Done
            }
        }
        _ => RoleOutcome::Continue,
    }
}

/// Compose the rendered lines (unstyled). Lines map to `roles.ts:175-200`.
pub fn compose_lines(state: &RoleMenuState, message: &str) -> Vec<String> {
    let label_width = ROLES.iter().map(|r| r.label().len()).max().unwrap_or(0);
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    let mut out = Vec::with_capacity(ROLES.len() * 2 + 5);
    out.push(format!("? {message}"));
    out.push(String::new());

    for (i, role) in ROLES.iter().enumerate() {
        let assigned = state
            .assignments
            .get(role)
            .cloned()
            .unwrap_or_default();
        let pfx = if i == state.active {
            cursor_active.clone()
        } else {
            "  ".to_string()
        };
        let padded_label = format!("{:width$}", role.label(), width = label_width);
        out.push(format!("{pfx}{padded_label}  {assigned}"));
        out.push(format!("  {}", role.recommendation()));
    }

    out.push(format!("  {}", "─".repeat(RULE_WIDTH)));

    let done_pfx = if state.active == ROLES.len() {
        cursor_active
    } else {
        "  ".to_string()
    };
    out.push(format!("{done_pfx}  Done"));

    out.push("  ↑↓ navigate • ⏎ change".to_string());

    out
}

// =========================================================================
// I/O loop
// =========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleMenuResult {
    Edit {
        state: RoleMenuState,
        role_key: RoleKey,
    },
    Done {
        state: RoleMenuState,
    },
    Cancelled,
}

pub fn role_menu_prompt(message: &str, state: RoleMenuState) -> io::Result<RoleMenuResult> {
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
        let input = RoleInput::from_key_event(key);
        match handle_key(&mut state, input) {
            RoleOutcome::Continue => continue,
            RoleOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(RoleMenuResult::Cancelled);
            }
            RoleOutcome::Edit { role_key } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(RoleMenuResult::Edit { state, role_key });
            }
            RoleOutcome::Done => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(RoleMenuResult::Done { state });
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    state: &RoleMenuState,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    queue!(stdout, SetForegroundColor(AMBER), Print("?"), ResetColor)?;
    queue!(stdout, Print(format!(" {message}\r\n")))?;
    queue!(stdout, Print("\r\n"))?;
    let mut height: u16 = 2;

    let label_width = ROLES.iter().map(|r| r.label().len()).max().unwrap_or(0);
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    for (i, role) in ROLES.iter().enumerate() {
        let is_active = i == state.active;
        let pfx = if is_active { cursor_active.as_str() } else { "  " };
        if is_active {
            queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
        } else {
            queue!(stdout, Print(pfx))?;
        }
        let padded_label = format!("{:width$}", role.label(), width = label_width);
        // Bold label, then dim assignment.
        queue!(
            stdout,
            SetAttribute(Attribute::Bold),
            Print(padded_label),
            SetAttribute(Attribute::Reset),
            Print("  "),
        )?;
        let assigned = state.assignments.get(role).cloned().unwrap_or_default();
        queue!(
            stdout,
            SetAttribute(Attribute::Dim),
            Print(assigned),
            SetAttribute(Attribute::Reset),
            Print("\r\n"),
        )?;
        height += 1;

        // Recommendation row: `#FFC107` dim if active, ansi256-#240 if not.
        if is_active {
            queue!(
                stdout,
                Print("  "),
                SetForegroundColor(AMBER),
                SetAttribute(Attribute::Dim),
                Print(role.recommendation()),
                SetAttribute(Attribute::Reset),
                ResetColor,
                Print("\r\n"),
            )?;
        } else {
            queue!(
                stdout,
                Print("  "),
                SetForegroundColor(ANSI240_MUTED),
                Print(role.recommendation()),
                ResetColor,
                Print("\r\n"),
            )?;
        }
        height += 1;
    }

    // Rule. TS at config/roles.ts:191 emits the rule WITHOUT any
    // styling: `lines.push(\`  ${"─".repeat(40)}\`)`. Don't wrap in
    // dim — matches TS plain-foreground render.
    queue!(
        stdout,
        Print("  "),
        Print("─".repeat(RULE_WIDTH)),
        Print("\r\n"),
    )?;
    height += 1;

    // Done row (always available — no minimum-count restriction here).
    let done_active = state.active == ROLES.len();
    let pfx = if done_active { cursor_active.as_str() } else { "  " };
    if done_active {
        queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
    } else {
        queue!(stdout, Print(pfx))?;
    }
    queue!(
        stdout,
        SetForegroundColor(ANSI214_ACCENT),
        SetAttribute(Attribute::Bold),
        Print("  Done"),
        SetAttribute(Attribute::Reset),
        ResetColor,
        Print("\r\n"),
    )?;
    height += 1;

    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("  ↑↓ navigate • ⏎ change"),
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

    fn assignments_all(value: &str) -> IndexMap<RoleKey, String> {
        let mut m = IndexMap::new();
        for r in ROLES {
            m.insert(r, value.to_owned());
        }
        m
    }

    #[test]
    fn role_key_strings_match_ts_field_names() {
        assert_eq!(RoleKey::Default.as_str(), "default");
        assert_eq!(RoleKey::Summarization.as_str(), "summarization");
        assert_eq!(RoleKey::Supervision.as_str(), "supervision");
        assert_eq!(RoleKey::PromptCompilation.as_str(), "promptCompilation");
        assert_eq!(RoleKey::Categorization.as_str(), "categorization");
        assert_eq!(RoleKey::ContextDiscovery.as_str(), "contextDiscovery");
    }

    #[test]
    fn role_labels_match_ts_verbatim() {
        // Source: roles.ts:22-29
        assert_eq!(RoleKey::Default.label(), "Default");
        assert_eq!(RoleKey::PromptCompilation.label(), "Prompt Compilation");
        assert_eq!(RoleKey::ContextDiscovery.label(), "Context Discovery");
    }

    #[test]
    fn role_recommendations_match_ts_verbatim() {
        // Spot-check a couple of the verbatim strings to guard against
        // accidental rewording.
        assert_eq!(
            RoleKey::Default.recommendation(),
            "The default model all agents get — pick your best all-rounder"
        );
        assert_eq!(
            RoleKey::ContextDiscovery.recommendation(),
            "Plans proactive memory searches — choose a cheap, fast model with reliable JSON output"
        );
    }

    #[test]
    fn roles_array_order_matches_ts_model_roles() {
        let order: Vec<&str> = ROLES.iter().map(|r| r.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "default",
                "summarization",
                "supervision",
                "promptCompilation",
                "categorization",
                "contextDiscovery",
            ]
        );
    }

    #[test]
    fn up_clamps_at_zero() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        handle_key(&mut state, RoleInput::Up);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn down_clamps_at_done_row() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        for _ in 0..20 {
            handle_key(&mut state, RoleInput::Down);
        }
        assert_eq!(state.active, ROLES.len());
    }

    #[test]
    fn enter_on_role_row_yields_edit_with_correct_key() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        state.active = 3; // promptCompilation
        let outcome = handle_key(&mut state, RoleInput::Enter);
        assert_eq!(
            outcome,
            RoleOutcome::Edit {
                role_key: RoleKey::PromptCompilation
            }
        );
    }

    #[test]
    fn enter_on_done_row_yields_done() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        state.active = ROLES.len();
        let outcome = handle_key(&mut state, RoleInput::Enter);
        assert_eq!(outcome, RoleOutcome::Done);
    }

    #[test]
    fn ctrl_c_cancels() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        assert_eq!(handle_key(&mut state, RoleInput::CtrlC), RoleOutcome::Cancel);
    }

    #[test]
    fn esc_cancels() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        assert_eq!(handle_key(&mut state, RoleInput::Escape), RoleOutcome::Cancel);
    }

    #[test]
    fn other_input_continues() {
        let mut state = RoleMenuState::new(assignments_all("cfg-x"));
        assert_eq!(handle_key(&mut state, RoleInput::Other), RoleOutcome::Continue);
    }

    #[test]
    fn compose_lines_render_role_label_padded_and_assignment() {
        let state = RoleMenuState::new(assignments_all("my-cfg"));
        let lines = compose_lines(&state, "Roles");
        // Each role row should contain the assignment.
        let prompt_compilation_row = lines
            .iter()
            .find(|l| l.contains("Prompt Compilation"))
            .unwrap();
        assert!(prompt_compilation_row.contains("my-cfg"), "got: {prompt_compilation_row}");
    }

    #[test]
    fn compose_lines_help_row_text_verbatim() {
        let state = RoleMenuState::new(assignments_all("x"));
        let lines = compose_lines(&state, "Roles");
        assert_eq!(lines.last().unwrap(), "  ↑↓ navigate • ⏎ change");
    }

    #[test]
    fn compose_lines_uses_thin_chevron_for_active_row() {
        let mut state = RoleMenuState::new(assignments_all("x"));
        state.active = 2; // Supervision
        let lines = compose_lines(&state, "Roles");
        let supervision_row = lines.iter().find(|l| l.contains("Supervision")).unwrap();
        assert!(supervision_row.starts_with(glyphs::CURSOR_THIN), "got: {supervision_row}");
    }

    #[test]
    fn compose_lines_recommendation_appears_below_each_role() {
        let state = RoleMenuState::new(assignments_all("x"));
        let lines = compose_lines(&state, "Roles");
        // Find the position of "Default" row, then verify the very next line
        // is the Default's recommendation (which contains "all-rounder").
        let pos = lines.iter().position(|l| l.contains("Default") && l.contains("x")).unwrap();
        assert!(lines[pos + 1].contains("all-rounder"), "got: {}", lines[pos + 1]);
    }

    #[test]
    fn from_key_event_maps_arrows_enter_esc_ctrl_c() {
        fn ke(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::NONE) }
        fn ke_ctrl(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::CONTROL) }
        assert_eq!(RoleInput::from_key_event(ke(KeyCode::Up)), RoleInput::Up);
        assert_eq!(RoleInput::from_key_event(ke(KeyCode::Down)), RoleInput::Down);
        assert_eq!(RoleInput::from_key_event(ke(KeyCode::Enter)), RoleInput::Enter);
        assert_eq!(RoleInput::from_key_event(ke(KeyCode::Esc)), RoleInput::Escape);
        assert_eq!(
            RoleInput::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            RoleInput::CtrlC,
        );
        assert_eq!(RoleInput::from_key_event(ke(KeyCode::Tab)), RoleInput::Other);
    }
}

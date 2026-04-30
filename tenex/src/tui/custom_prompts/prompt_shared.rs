//! Common crossterm types, colour aliases, and input helpers shared by all
//! bespoke prompts.
//!
//! Every bespoke crossterm-rendered prompt needs the same crossterm types
//! for key handling, cursor movement, colours, and terminal clearing. This
//! module collects them in one place so each prompt file replaces an 8-line
//! import block, 1–3 colour-const aliases, and a duplicate Ctrl+C check
//! with a single glob import.
//!
//! # Usage
//!
//! ```ignore
//! use super::prompt_shared::*;
//! ```
//!
//! This brings in all commonly-used crossterm types, the shared colour
//! constants, and the `is_ctrl_c` helper.

// -- Common crossterm re-exports ------------------------------------------

pub use crossterm::cursor::{MoveToColumn, MoveUp};
pub use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
pub use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
pub use crossterm::terminal::{self, Clear, ClearType};
pub use crossterm::{queue, QueueableCommand};

// -- Colour aliases --------------------------------------------------------
//
// Every bespoke prompt renders with the same inquirer-amber `#FFC107`
// cursor and many also use the display-palette ANSI 214 accent. Instead
// of each file defining its own `const AMBER: Color = …`, share them
// here so the truecolor lives at a single source of truth.

/// Inquirer-prompt amber `#FFC107` — used for active-row cursor and
/// amber-highlight foreground in all bespoke crossterm prompts.
pub const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;

/// Display-palette accent — xterm-256 #214 (`#ffaf00`). Used for the
/// "Done" label in bespoke prompts. **Distinct from** [`AMBER`] per
/// spec doc 12 §0.
pub const ANSI214_ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;

/// Display-palette muted — xterm-256 #240 (`#585858`). Used for the
/// inactive role-recommendation tint in the role-menu prompt.

/// Display-palette selected — xterm-256 #114 (`#87d787`). Used for the
/// bold `[✓]` glyph in the provider-select browse pane.
pub const ANSI114_SELECTED: Color = crate::tui::theme::DISPLAY_SELECTED_CROSSTERM;

pub const ANSI240_MUTED: Color = crate::tui::theme::DISPLAY_MUTED_CROSSTERM;

// -- Input helpers --------------------------------------------------------

/// Returns `true` when `ev` is Ctrl+C.
///
/// Every bespoke prompt checks for Ctrl+C the same way — centralise it
/// so the check is consistent and testable in one place.
#[inline]
pub fn is_ctrl_c(ev: &KeyEvent) -> bool {
    ev.modifiers.contains(KeyModifiers::CONTROL) && matches!(ev.code, KeyCode::Char('c'))
}

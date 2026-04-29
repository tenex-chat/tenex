//! Single-character glyphs used across the TUI. Centralised so the
//! ASCII vs emoji split (`docs/tui-port/12-visual-styling.md` §7) stays
//! deliberate.

// ---- ASCII / Box-drawing glyphs (used in TUI screen renders) ------------

pub const CHECK: &str = "✓"; // U+2713 success
pub const CROSS: &str = "✗"; // U+2717 failure
pub const CURSOR_THIN: &str = "›"; // U+203A custom-prompt cursor
pub const CURSOR_HEAVY: &str = "❯"; // U+276F stock-inquirer cursor

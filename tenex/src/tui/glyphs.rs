//! Single-character glyphs used across the TUI. Centralised so the
//! ASCII vs emoji split (`docs/tui-port/12-visual-styling.md` §7) stays
//! deliberate.

// ---- ASCII / Box-drawing glyphs (used in TUI screen renders) ------------

pub const CHECK: &str = "✓"; // U+2713 success
pub const CROSS: &str = "✗"; // U+2717 failure
pub const WARN: &str = "⚠"; // U+26A0 warning
pub const ARROW: &str = "→"; // U+2192 hint arrow
pub const CURSOR_THIN: &str = "›"; // U+203A custom-prompt cursor
pub const CURSOR_HEAVY: &str = "❯"; // U+276F stock-inquirer cursor
pub const BULLET: &str = "●"; // U+25CF relay/team bullet
pub const TRIANGLE: &str = "▲"; // U+25B2 summary banner
pub const STIPPLE: &str = "•"; // U+2022 banner dot
pub const RULE: &str = "─"; // U+2500 horizontal rule

// ---- Logger emoji (only used by the logger / project-runtime, never
// in interactive screens) `src/utils/logger.ts:27-31`. ------------------

pub const LOG_ERR: &str = "❌";
pub const LOG_WARN: &str = "⚠️";
pub const LOG_INFO: &str = "ℹ️";
pub const LOG_OK: &str = "✅";
pub const LOG_DEBUG: &str = "🔍";

// ---- Project runtime status (`ProjectRuntime.ts:603,408,...`) ----------

pub const PROJ_START: &str = "🚀";
pub const PROJ_STOP: &str = "🛑";

// ---- Cursor-hide ANSI sequence appended to custom-prompt renders -------

pub const CURSOR_HIDE: &str = "\x1b[?25l";
pub const CURSOR_SHOW: &str = "\x1b[?25h";

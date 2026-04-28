//! RAII guard for `crossterm` raw-mode entry/exit.
//!
//! Constructing [`RawMode`] enables raw mode and hides the cursor; dropping
//! it (including on panic) restores cooked mode and shows the cursor. Custom
//! prompts MUST hold one for the duration of their I/O loop and MUST NOT
//! return without dropping it — otherwise the user's terminal stays raw.
//!
//! Cursor-hide reproduces the `cursorHide` (`\x1b[?25l`) appended to every
//! TS custom-prompt render at the bottom of `provider-select-prompt.ts:76`,
//! `variant-list-prompt.ts:115`, etc.

use std::io;

use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};

/// Holds raw-mode lifetime. On drop: disables raw mode and re-shows the
/// cursor. Dropping is best-effort — a syscall failure during cleanup is
/// logged via `tracing::warn` but cannot panic (we may already be unwinding).
pub struct RawMode {
    /// Whether we successfully entered raw mode. If false, [`Drop`] is a
    /// no-op (we never altered terminal state, so we mustn't try to restore).
    armed: bool,
}

impl RawMode {
    /// Enable raw mode and hide the cursor. Returns the guard.
    pub fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(e) = execute!(stdout, Hide) {
            // Roll back the raw-mode change so we don't leak state.
            let _ = disable_raw_mode();
            return Err(e);
        }
        Ok(Self { armed: true })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut stdout = io::stdout();
        if let Err(e) = execute!(stdout, Show) {
            tracing::warn!(error = %e, "failed to restore cursor visibility");
        }
        if let Err(e) = disable_raw_mode() {
            tracing::warn!(error = %e, "failed to disable raw mode");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_is_safe_when_not_armed() {
        // Construct a non-armed guard and drop it; no terminal state was
        // touched, so this must not call disable_raw_mode (which can fail
        // when stdout isn't a TTY, e.g. cargo test's captured output).
        let guard = RawMode { armed: false };
        drop(guard);
    }
}

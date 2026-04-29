//! Provider-select prompt — two-pane (browse / keys) bespoke render.
//!
//! Source: `src/llm/utils/provider-select-prompt.ts`. The TS implementation
//! is split into a pure state machine plus an `@inquirer/core` view; this
//! Rust port preserves that split so the state transitions are testable
//! without a TTY.
//!
//! Behaviours (every transition cited):
//!
//! - **Browse mode** (`handle_browse`, `:118-149`):
//!   - Up/Down clamp to `[0, doneIndex]` where `doneIndex == providerIds.len`.
//!   - Space toggles the active provider (`toggleProvider`, `:140-161`).
//!     - If enabled → move to `stash`, remove.
//!     - If disabled and `!needsApiKey` (`codex` / `claude-code`) → enable
//!       with `apiKey: "none"` (the literal sentinel string per spec doc 04).
//!     - If disabled and a stash entry exists → restore.
//!     - Else → emit `RequestAddKey { return_to: Browse }`.
//!   - Enter on doneIndex → emit `Done(providers)`.
//!   - Enter on an enabled provider that needs a key → enter keys mode.
//!
//! - **Keys mode** (`handle_keys`, `:175-197`):
//!   - Up/Down clamp to `[0, backIndex]` where `backIndex == keys.len + 1`.
//!   - `d` on a key row (`keys_active < keys.len`) deletes that key
//!     (`deleteKey`, `:199-213`):
//!     - If 0 remain → drop provider entirely, exit keys mode.
//!     - If 1 remains → collapse `apiKey` array to a bare string.
//!     - Otherwise clamp `keys_active` to `remaining.len - 1`.
//!   - Enter on `addIndex` → emit `RequestAddKey { return_to: Keys }`.
//!   - Enter on `backIndex` → exit keys mode (back to browse).
//!   - Esc → exit keys mode.
//!
//! Cursor glyph for both modes: `›` (U+203A) in `INQUIRER_AMBER` — distinct
//! from the heavy `❯` used by stock inquire prompts (per spec doc 12 §2).
//!
//! Key masking:
//! - Ollama keys render verbatim (the field stores its base URL — spec doc 03 §1).
//! - Other providers: keys ≤ 4 chars render as all `*`; longer keys render
//!   as `*` × (len-4) + last4 (per spec doc 04 §4 `KeyManager.maskKey`).

use std::io::{self, Write};

use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};
use indexmap::IndexMap;

use super::raw_mode::RawMode;
use crate::store::api_keys::parse_api_key_entry;
use crate::tui::glyphs;

// Provider IDs that DO NOT require an API key — toggling them on stores the
// literal `"none"` sentinel per spec doc 04 §1 / `provider-ids.ts:8-9`.
const PID_CODEX: &str = "codex";
const PID_CLAUDE_CODE: &str = "claude-code";
const PID_OLLAMA: &str = "ollama";

/// Width (in `─` characters) of the rule rendered in keys-mode below the
/// provider name. Source: `provider-select-prompt.ts:69` `RULE_WIDTH = 30`.
pub const RULE_WIDTH: usize = 30;

/// Lite mirror of `ProviderCredentials` (`src/services/config/types.ts:414-419`)
/// — only the `apiKey` field is needed by the prompt; `baseUrl`/`timeout`/
/// `options` are preserved unchanged at the store layer
/// (`crate::store::providers`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCredentialsLite {
    pub api_key: ApiKeyValue,
}

/// Multi-key duality (per spec doc 04 §1): a single key persists as a bare
/// string; ≥2 keys persist as an array. The collapse rule is enforced in
/// `delete_key` and at the store boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiKeyValue {
    Single(String),
    Multiple(Vec<String>),
}

impl ApiKeyValue {
    /// Always-normalised list. `getKeys` (`provider-select-prompt.ts:53`)
    /// strips empty / `"none"` entries; we mirror that here.
    pub fn entries(&self) -> Vec<String> {
        let raw: &[String] = match self {
            Self::Single(s) => std::slice::from_ref(s),
            Self::Multiple(v) => v.as_slice(),
        };
        raw.iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| {
                let key = s.split_whitespace().next().unwrap_or("");
                !key.is_empty() && key != "none"
            })
            .collect()
    }
}

/// Cursor mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderMode {
    Browse,
    Keys,
}

/// Pure model — no terminal I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderState {
    pub providers: IndexMap<String, ProviderCredentialsLite>,
    pub stash: IndexMap<String, ProviderCredentialsLite>,
    pub active: usize,
    pub mode: ProviderMode,
    pub keys_target: Option<String>,
    pub keys_active: usize,
}

impl ProviderState {
    pub fn new(initial: IndexMap<String, ProviderCredentialsLite>) -> Self {
        Self {
            providers: initial,
            stash: IndexMap::new(),
            active: 0,
            mode: ProviderMode::Browse,
            keys_target: None,
            keys_active: 0,
        }
    }
}

/// Side-effect intents emitted by the state machine. The screen layer is
/// expected to act on `RequestAddKey` (open a password prompt, then re-enter
/// the provider prompt with the augmented state) and to terminate on `Done`
/// or `Cancel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderOutcome {
    /// State mutated; redraw and keep looping.
    Continue,
    /// User pressed Ctrl-C / Esc-in-browse-mode; the wrapper aborts.
    Cancel,
    /// User confirmed `Done`; the wrapper persists `providers`.
    Done,
    /// User chose an action that needs an API key; the wrapper opens a
    /// password prompt for `provider_id`, on success appends a key and
    /// re-enters the prompt with `mode == return_to`.
    RequestAddKey {
        provider_id: String,
        return_to: ProviderMode,
    },
}

/// Compact key event abstraction so tests (and any non-crossterm driver)
/// don't need to construct a full `KeyEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKey {
    Up,
    Down,
    Enter,
    Space,
    Escape,
    CtrlC,
    Char(char),
    Other,
}

impl InputKey {
    /// Translate a crossterm `KeyEvent` into the prompt's input vocabulary.
    /// Unknown keys map to [`InputKey::Other`] which the state machine ignores.
    pub fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(ev.code, KeyCode::Char('c'))
        {
            return InputKey::CtrlC;
        }
        match ev.code {
            KeyCode::Up => InputKey::Up,
            KeyCode::Down => InputKey::Down,
            KeyCode::Enter => InputKey::Enter,
            KeyCode::Char(' ') => InputKey::Space,
            KeyCode::Esc => InputKey::Escape,
            KeyCode::Char(c) => InputKey::Char(c),
            _ => InputKey::Other,
        }
    }
}

/// Drive the state machine with one keystroke. Returns the outcome.
pub fn handle_key(
    state: &mut ProviderState,
    provider_ids: &[String],
    key: InputKey,
) -> ProviderOutcome {
    if matches!(key, InputKey::CtrlC) {
        return ProviderOutcome::Cancel;
    }
    match state.mode {
        ProviderMode::Browse => handle_browse(state, provider_ids, key),
        ProviderMode::Keys => handle_keys(state, key),
    }
}

fn handle_browse(
    state: &mut ProviderState,
    provider_ids: &[String],
    key: InputKey,
) -> ProviderOutcome {
    let done_index = provider_ids.len();

    match key {
        InputKey::Escape => ProviderOutcome::Cancel,
        InputKey::Up => {
            if state.active > 0 {
                state.active -= 1;
            }
            ProviderOutcome::Continue
        }
        InputKey::Down => {
            if state.active < done_index {
                state.active += 1;
            }
            ProviderOutcome::Continue
        }
        InputKey::Space => {
            let Some(pid) = provider_ids.get(state.active).cloned() else {
                return ProviderOutcome::Continue;
            };
            toggle_provider(state, &pid)
        }
        InputKey::Enter => {
            if state.active == done_index {
                return ProviderOutcome::Done;
            }
            let Some(pid) = provider_ids.get(state.active).cloned() else {
                return ProviderOutcome::Continue;
            };
            if state.providers.contains_key(&pid) && needs_api_key(&pid) {
                enter_keys_mode(state, pid);
            }
            ProviderOutcome::Continue
        }
        _ => ProviderOutcome::Continue,
    }
}

fn handle_keys(state: &mut ProviderState, key: InputKey) -> ProviderOutcome {
    let Some(target) = state.keys_target.clone() else {
        return ProviderOutcome::Continue;
    };

    let keys: Vec<String> = state
        .providers
        .get(&target)
        .map(|c| c.api_key.entries())
        .unwrap_or_default();
    let add_index = keys.len();
    let back_index = keys.len() + 1;

    match key {
        InputKey::Up => {
            if state.keys_active > 0 {
                state.keys_active -= 1;
            }
            ProviderOutcome::Continue
        }
        InputKey::Down => {
            if state.keys_active < back_index {
                state.keys_active += 1;
            }
            ProviderOutcome::Continue
        }
        InputKey::Char('d') if state.keys_active < keys.len() => {
            delete_key(state, &target, state.keys_active, &keys);
            ProviderOutcome::Continue
        }
        InputKey::Enter if state.keys_active == add_index => ProviderOutcome::RequestAddKey {
            provider_id: target,
            return_to: ProviderMode::Keys,
        },
        InputKey::Enter if state.keys_active == back_index => {
            exit_keys_mode(state);
            ProviderOutcome::Continue
        }
        InputKey::Escape => {
            exit_keys_mode(state);
            ProviderOutcome::Continue
        }
        _ => ProviderOutcome::Continue,
    }
}

fn toggle_provider(state: &mut ProviderState, pid: &str) -> ProviderOutcome {
    if state.providers.shift_remove(pid).is_some_and(|prev| {
        state.stash.insert(pid.to_owned(), prev);
        true
    }) {
        return ProviderOutcome::Continue;
    }
    if !needs_api_key(pid) {
        state.providers.insert(
            pid.to_owned(),
            ProviderCredentialsLite {
                api_key: ApiKeyValue::Single("none".to_owned()),
            },
        );
        return ProviderOutcome::Continue;
    }
    if let Some(restored) = state.stash.shift_remove(pid) {
        state.providers.insert(pid.to_owned(), restored);
        return ProviderOutcome::Continue;
    }
    ProviderOutcome::RequestAddKey {
        provider_id: pid.to_owned(),
        return_to: ProviderMode::Browse,
    }
}

fn enter_keys_mode(state: &mut ProviderState, pid: String) {
    state.mode = ProviderMode::Keys;
    state.keys_target = Some(pid);
    state.keys_active = 0;
}

fn exit_keys_mode(state: &mut ProviderState) {
    state.mode = ProviderMode::Browse;
    state.keys_target = None;
    state.keys_active = 0;
}

fn delete_key(state: &mut ProviderState, pid: &str, index: usize, keys: &[String]) {
    let mut remaining: Vec<String> = keys.to_vec();
    if index < remaining.len() {
        remaining.remove(index);
    }
    if remaining.is_empty() {
        state.providers.shift_remove(pid);
        exit_keys_mode(state);
        return;
    }
    let new_value = if remaining.len() == 1 {
        ApiKeyValue::Single(remaining.into_iter().next().expect("len==1"))
    } else {
        ApiKeyValue::Multiple(remaining)
    };
    if let Some(entry) = state.providers.get_mut(pid) {
        entry.api_key = new_value;
    }
    let new_len = match state.providers.get(pid).map(|e| e.api_key.entries().len()) {
        Some(n) => n,
        None => 0,
    };
    if new_len == 0 {
        state.keys_active = 0;
    } else {
        state.keys_active = state.keys_active.min(new_len - 1);
    }
}

fn needs_api_key(pid: &str) -> bool {
    pid != PID_CODEX && pid != PID_CLAUDE_CODE
}

fn is_ollama(pid: &str) -> bool {
    pid == PID_OLLAMA
}

/// Mask one key for display. `provider-select-prompt.ts:65` `maskKey`.
pub fn mask_key(provider_id: &str, key: &str) -> String {
    if is_ollama(provider_id) {
        return key.to_owned();
    }
    if key.chars().count() <= 4 {
        return "*".repeat(key.chars().count());
    }
    let chars: Vec<char> = key.chars().collect();
    let masked = "*".repeat(chars.len() - 4);
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{masked}{tail}")
}

/// Composition for the Browse view. Returned strings are unstyled — colour
/// is applied at the I/O layer. Cited line numbers in comments map to the
/// TS template at `provider-select-prompt.ts:228-253`.
pub fn compose_browse_lines(
    state: &ProviderState,
    provider_ids: &[String],
    provider_hints: &IndexMap<String, String>,
) -> Vec<String> {
    let mut out = Vec::with_capacity(provider_ids.len() + 2);
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    for (i, pid) in provider_ids.iter().enumerate() {
        let pfx = if i == state.active {
            cursor_active.clone()
        } else {
            "  ".to_string()
        };
        let name = provider_display_name(pid);
        if let Some(creds) = state.providers.get(pid) {
            // Enabled: `[✓] Name [N keys]`. The `[✓]` and `[N keys]` are
            // styled at render time; here we just lay them out.
            let key_info = format_key_info(&creds.api_key);
            out.push(format!("{pfx}[✓] {name}{key_info}"));
        } else {
            // Disabled: `[ ] Name — hint`.
            let hint = provider_hints
                .get(pid)
                .map(|h| format!(" — {h}"))
                .unwrap_or_default();
            out.push(format!("{pfx}[ ] {name}{hint}"));
        }
    }

    let done_pfx = if state.active == provider_ids.len() {
        cursor_active.clone()
    } else {
        "  ".to_string()
    };
    // Two-space padding inside the Done label is part of the TS spec
    // (`display.ts:122` `ACCENT.bold("  Done")`).
    out.push(format!("{done_pfx}  Done"));

    // Help row — exact text per `provider-select-prompt.ts:247-252`.
    out.push(
        "  ↑↓ navigate • space toggle • ⏎ manage keys / done".to_string(),
    );

    out
}

/// Composition for the Keys view. `provider-select-prompt.ts:255-286`.
pub fn compose_keys_lines(state: &ProviderState) -> Vec<String> {
    let Some(target) = state.keys_target.as_deref() else {
        return Vec::new();
    };
    let keys = state
        .providers
        .get(target)
        .map(|c| c.api_key.entries())
        .unwrap_or_default();
    let add_index = keys.len();
    let back_index = keys.len() + 1;
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    let mut out = Vec::with_capacity(keys.len() + 5);
    out.push(format!("  {} — API Keys", provider_display_name(target)));
    out.push(format!("  {}", "─".repeat(RULE_WIDTH)));

    for (i, raw) in keys.iter().enumerate() {
        let pfx = if state.keys_active == i {
            cursor_active.clone()
        } else {
            "  ".to_string()
        };
        let parsed = parse_api_key_entry(raw);
        let masked = mask_key(target, &parsed.key);
        let label_part = parsed
            .label
            .as_ref()
            .map(|l| format!("  {l}"))
            .unwrap_or_default();
        let hint = if state.keys_active == i {
            "  d delete".to_string()
        } else {
            String::new()
        };
        out.push(format!("{pfx}{masked}{label_part}{hint}"));
    }

    let add_pfx = if state.keys_active == add_index {
        cursor_active.clone()
    } else {
        "  ".to_string()
    };
    out.push(format!("{add_pfx}+ Add another key"));

    let back_pfx = if state.keys_active == back_index {
        cursor_active.clone()
    } else {
        "  ".to_string()
    };
    out.push(format!("{back_pfx}← Back"));

    out.push("  ↑↓ navigate • d delete key • ⏎ select • esc back".to_string());

    out
}

/// Display-name lookup. Source: `getProviderDisplayName` at
/// `src/llm/utils/ProviderConfigUI.ts:14-24`.
pub fn provider_display_name(pid: &str) -> &'static str {
    match pid {
        "openrouter" => "OpenRouter (300+ models)",
        "anthropic" => "Anthropic (Claude)",
        "openai" => "OpenAI (GPT)",
        "ollama" => "Ollama (Local models)",
        "codex" => "Codex",
        "claude-code" => "Claude Code (Agents)",
        _ => provider_unknown_name(pid),
    }
}

fn provider_unknown_name(_pid: &str) -> &'static str {
    // The TS fallback is `names[provider] || provider` — we cannot return
    // an arbitrary borrowed string here without lifetimes leaking through
    // public API, so unknown providers render as a placeholder. Screens
    // call sites are aware of this constraint and only feed in IDs from
    // `provider-ids.ts`.
    "provider"
}

/// Format the key-count suffix shown beside an enabled provider's name.
/// `provider-select-prompt.ts:60-62`.
fn format_key_info(value: &ApiKeyValue) -> String {
    let count = value.entries().len();
    if count == 0 {
        return String::new();
    }
    let plural = if count == 1 { "key" } else { "keys" };
    format!(" [{count} {plural}]")
}

// `parse_api_key_entry` lives in `crate::store::api_keys` as the shared
// canonical helper (mirrors TS `parseApiKeyEntry` at
// `src/llm/providers/key-manager.ts:288-303`). This module's renderer
// imports it directly via `use crate::store::api_keys::parse_api_key_entry`.

// =========================================================================
// I/O loop
// =========================================================================

// Palette aliases sourced from the shared theme module.
const AMBER: Color = crate::tui::theme::INQUIRER_AMBER_CROSSTERM;
const ANSI214_ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;
const ANSI114_SELECTED: Color = crate::tui::theme::DISPLAY_SELECTED_CROSSTERM;

/// Result of running [`provider_select_prompt`]. The screen layer pattern-
/// matches: `Done` persists, `Cancelled` aborts, `NeedKey` opens a separate
/// password prompt, applies the entered key, then re-enters this prompt
/// with the augmented `state`.
#[derive(Debug, Clone)]
pub enum ProviderSelectResult {
    Done(IndexMap<String, ProviderCredentialsLite>),
    Cancelled,
    NeedKey {
        state: ProviderState,
        provider_id: String,
        return_to: ProviderMode,
    },
}

/// Run the prompt to completion (or until the state machine yields a
/// `RequestAddKey`). Blocks the thread on `crossterm::event::read`.
pub fn provider_select_prompt(
    message: &str,
    provider_ids: &[String],
    provider_hints: &IndexMap<String, String>,
    resume_state: Option<ProviderState>,
) -> io::Result<ProviderSelectResult> {
    if provider_ids.is_empty() {
        return Ok(ProviderSelectResult::Cancelled);
    }

    let _guard = RawMode::enter()?;
    let mut state = resume_state.unwrap_or_else(|| ProviderState::new(IndexMap::new()));
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        prev_height = render_frame(&mut stdout, message, &state, provider_ids, provider_hints, prev_height)?;

        let key = match event::read()? {
            Event::Key(k) => k,
            _ => continue,
        };
        let input = InputKey::from_key_event(key);

        match handle_key(&mut state, provider_ids, input) {
            ProviderOutcome::Continue => continue,
            ProviderOutcome::Cancel => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(ProviderSelectResult::Cancelled);
            }
            ProviderOutcome::Done => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(ProviderSelectResult::Done(state.providers));
            }
            ProviderOutcome::RequestAddKey {
                provider_id,
                return_to,
            } => {
                clear_frame(&mut stdout, prev_height)?;
                return Ok(ProviderSelectResult::NeedKey {
                    state,
                    provider_id,
                    return_to,
                });
            }
        }
    }
}

fn render_frame<W: Write>(
    stdout: &mut W,
    message: &str,
    state: &ProviderState,
    provider_ids: &[String],
    provider_hints: &IndexMap<String, String>,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(stdout, prev_height)?;
    queue!(stdout, MoveToColumn(0))?;

    // Header: amber `?` + message.
    queue!(stdout, SetForegroundColor(AMBER), Print("?"), ResetColor)?;
    queue!(stdout, Print(format!(" {message}\r\n")))?;
    let mut height: u16 = 1;

    height += match state.mode {
        ProviderMode::Browse => render_browse(stdout, state, provider_ids, provider_hints)?,
        ProviderMode::Keys => render_keys(stdout, state)?,
    };

    stdout.flush()?;
    Ok(height)
}

fn render_browse<W: Write>(
    stdout: &mut W,
    state: &ProviderState,
    provider_ids: &[String],
    provider_hints: &IndexMap<String, String>,
) -> io::Result<u16> {
    let mut height: u16 = 0;
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);

    for (i, pid) in provider_ids.iter().enumerate() {
        let is_active = i == state.active;
        let pfx = if is_active { cursor_active.as_str() } else { "  " };
        if is_active {
            queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
        } else {
            queue!(stdout, Print(pfx))?;
        }

        let name = provider_display_name(pid);
        if let Some(creds) = state.providers.get(pid) {
            // `[✓]` in xterm-256 #114 + bold (matches `display.providerCheck`
            // at `src/commands/config/display.ts:107-109`).
            queue!(
                stdout,
                SetForegroundColor(ANSI114_SELECTED),
                SetAttribute(Attribute::Bold),
                Print("[✓]"),
                SetAttribute(Attribute::Reset),
                ResetColor,
                Print(format!(" {name}")),
            )?;
            let count = creds.api_key.entries().len();
            if count > 0 {
                let plural = if count == 1 { "key" } else { "keys" };
                // TS provider-select-prompt.ts:67 uses chalk.gray (bright
                // black, ANSI 90 / xterm-256 index 8), NOT chalk.dim.
                // Use the shared theme constant so the badge renders
                // the same muted-grey as TS without an inline literal.
                queue!(
                    stdout,
                    SetForegroundColor(crate::tui::theme::CHALK_GRAY_CROSSTERM),
                    Print(format!(" [{count} {plural}]")),
                    ResetColor,
                )?;
            }
        } else {
            // Disabled: dim `[ ]` then provider name in default fg.
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print("[ ]"),
                SetAttribute(Attribute::Reset),
                Print(format!(" {name}")),
            )?;
            if let Some(hint) = provider_hints.get(pid) {
                queue!(
                    stdout,
                    SetAttribute(Attribute::Dim),
                    Print(format!(" — {hint}")),
                    SetAttribute(Attribute::Reset),
                )?;
            }
        }
        queue!(stdout, Print("\r\n"))?;
        height += 1;
    }

    // Done row: ansi256-#214 bold `  Done` (`display.doneLabel` at
    // `src/commands/config/display.ts:121-123`).
    let done_active = state.active == provider_ids.len();
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
        Print("  ↑↓ navigate • space toggle • ⏎ manage keys / done"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

    Ok(height)
}

fn render_keys<W: Write>(stdout: &mut W, state: &ProviderState) -> io::Result<u16> {
    let Some(target) = state.keys_target.as_deref() else {
        return Ok(0);
    };
    let keys = state
        .providers
        .get(target)
        .map(|c| c.api_key.entries())
        .unwrap_or_default();
    let add_index = keys.len();
    let back_index = keys.len() + 1;
    let cursor_active = format!("{} ", glyphs::CURSOR_THIN);
    let mut height: u16 = 0;

    // `  <bold name> <dim — API Keys>`
    queue!(
        stdout,
        Print("  "),
        SetAttribute(Attribute::Bold),
        Print(provider_display_name(target)),
        SetAttribute(Attribute::Reset),
        Print(" "),
        SetAttribute(Attribute::Dim),
        Print("— API Keys"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

    // Rule.
    let rule = "─".repeat(RULE_WIDTH);
    queue!(
        stdout,
        Print("  "),
        SetAttribute(Attribute::Dim),
        Print(rule),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

    for (i, raw) in keys.iter().enumerate() {
        let is_active = state.keys_active == i;
        let pfx = if is_active { cursor_active.as_str() } else { "  " };
        if is_active {
            queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
        } else {
            queue!(stdout, Print(pfx))?;
        }
        let parsed = parse_api_key_entry(raw);
        let masked = mask_key(target, &parsed.key);
        queue!(stdout, Print(masked))?;
        if let Some(label) = &parsed.label {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print(format!("  {label}")),
                SetAttribute(Attribute::Reset),
            )?;
        }
        if is_active {
            queue!(
                stdout,
                SetAttribute(Attribute::Dim),
                Print("  d delete"),
                SetAttribute(Attribute::Reset),
            )?;
        }
        queue!(stdout, Print("\r\n"))?;
        height += 1;
    }

    let add_active = state.keys_active == add_index;
    let pfx = if add_active { cursor_active.as_str() } else { "  " };
    if add_active {
        queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
    } else {
        queue!(stdout, Print(pfx))?;
    }
    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("+ Add another key"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

    let back_active = state.keys_active == back_index;
    let pfx = if back_active { cursor_active.as_str() } else { "  " };
    if back_active {
        queue!(stdout, SetForegroundColor(AMBER), Print(pfx), ResetColor)?;
    } else {
        queue!(stdout, Print(pfx))?;
    }
    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("← Back"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

    queue!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("  ↑↓ navigate • d delete key • ⏎ select • esc back"),
        SetAttribute(Attribute::Reset),
        Print("\r\n"),
    )?;
    height += 1;

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

    fn pids() -> Vec<String> {
        vec![
            "openrouter".into(),
            "anthropic".into(),
            "openai".into(),
            "ollama".into(),
            "codex".into(),
            "claude-code".into(),
        ]
    }

    fn empty_state() -> ProviderState {
        ProviderState::new(IndexMap::new())
    }

    fn cred_single(s: &str) -> ProviderCredentialsLite {
        ProviderCredentialsLite {
            api_key: ApiKeyValue::Single(s.to_owned()),
        }
    }

    fn cred_multi(keys: &[&str]) -> ProviderCredentialsLite {
        ProviderCredentialsLite {
            api_key: ApiKeyValue::Multiple(keys.iter().map(|s| (*s).to_owned()).collect()),
        }
    }

    // ---- entries() ------------------------------------------------------

    #[test]
    fn entries_strips_none_sentinel() {
        let v = ApiKeyValue::Single("none".into());
        assert!(v.entries().is_empty());
    }

    #[test]
    fn entries_strips_empty_strings() {
        let v = ApiKeyValue::Multiple(vec!["".into(), "k1".into(), "  ".into()]);
        assert_eq!(v.entries(), vec!["k1"]);
    }

    #[test]
    fn entries_preserves_order_and_label_form() {
        let v = ApiKeyValue::Multiple(vec!["sk-aaa user@x".into(), "sk-bbb".into()]);
        assert_eq!(v.entries(), vec!["sk-aaa user@x", "sk-bbb"]);
    }

    // ---- needs_api_key --------------------------------------------------

    #[test]
    fn codex_does_not_need_key() {
        assert!(!needs_api_key("codex"));
    }

    #[test]
    fn claude_code_does_not_need_key() {
        assert!(!needs_api_key("claude-code"));
    }

    #[test]
    fn openrouter_needs_key() {
        assert!(needs_api_key("openrouter"));
    }

    // ---- mask_key -------------------------------------------------------

    #[test]
    fn mask_key_preserves_ollama_value_verbatim() {
        // Ollama stores its base URL in apiKey — never mask.
        assert_eq!(mask_key("ollama", "http://localhost:11434"), "http://localhost:11434");
    }

    #[test]
    fn mask_key_full_for_short_inputs() {
        assert_eq!(mask_key("openrouter", "abcd"), "****");
        assert_eq!(mask_key("openrouter", "ab"), "**");
    }

    #[test]
    fn mask_key_keeps_last_four_for_long_inputs() {
        let input = "sk-ant-1234567890ABCDEFGHIJ"; // 27 chars
        let expected = format!("{}{}", "*".repeat(input.len() - 4), &input[input.len() - 4..]);
        assert_eq!(mask_key("anthropic", input), expected);
    }

    #[test]
    fn mask_key_exact_last4_behaviour() {
        let masked = mask_key("anthropic", "abcdefghij");
        assert_eq!(masked, "******ghij");
    }

    // ---- toggle_provider -----------------------------------------------

    #[test]
    fn toggle_disabled_codex_uses_none_sentinel() {
        let mut state = empty_state();
        let pids = pids();
        state.active = pids.iter().position(|p| p == "codex").unwrap();
        let outcome = handle_key(&mut state, &pids, InputKey::Space);
        assert_eq!(outcome, ProviderOutcome::Continue);
        assert!(state.providers.contains_key("codex"));
        assert_eq!(
            state.providers["codex"].api_key,
            ApiKeyValue::Single("none".into())
        );
    }

    #[test]
    fn toggle_disabled_keyless_provider_requests_add_key() {
        let mut state = empty_state();
        let pids = pids();
        state.active = pids.iter().position(|p| p == "openrouter").unwrap();
        let outcome = handle_key(&mut state, &pids, InputKey::Space);
        assert!(matches!(
            outcome,
            ProviderOutcome::RequestAddKey { ref provider_id, return_to: ProviderMode::Browse }
                if provider_id == "openrouter"
        ));
    }

    #[test]
    fn toggle_enabled_provider_moves_to_stash() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("sk-1"));
        let pids = pids();
        state.active = pids.iter().position(|p| p == "anthropic").unwrap();
        handle_key(&mut state, &pids, InputKey::Space);
        assert!(!state.providers.contains_key("anthropic"));
        assert!(state.stash.contains_key("anthropic"));
    }

    #[test]
    fn toggle_disabled_with_stash_restores() {
        let mut state = empty_state();
        state.stash.insert("anthropic".into(), cred_single("sk-old"));
        let pids = pids();
        state.active = pids.iter().position(|p| p == "anthropic").unwrap();
        let outcome = handle_key(&mut state, &pids, InputKey::Space);
        assert_eq!(outcome, ProviderOutcome::Continue);
        assert!(state.providers.contains_key("anthropic"));
        assert!(!state.stash.contains_key("anthropic"));
        assert_eq!(
            state.providers["anthropic"].api_key,
            ApiKeyValue::Single("sk-old".into())
        );
    }

    // ---- enter / exit keys mode ----------------------------------------

    #[test]
    fn enter_key_mode_only_for_enabled_providers_that_need_keys() {
        let mut state = empty_state();
        state.providers.insert("openrouter".into(), cred_single("sk-1"));
        let pids = pids();
        state.active = pids.iter().position(|p| p == "openrouter").unwrap();
        handle_key(&mut state, &pids, InputKey::Enter);
        assert_eq!(state.mode, ProviderMode::Keys);
        assert_eq!(state.keys_target.as_deref(), Some("openrouter"));
        assert_eq!(state.keys_active, 0);
    }

    #[test]
    fn enter_does_not_open_keys_for_disabled_providers() {
        let mut state = empty_state();
        let pids = pids();
        state.active = pids.iter().position(|p| p == "openrouter").unwrap();
        handle_key(&mut state, &pids, InputKey::Enter);
        assert_eq!(state.mode, ProviderMode::Browse);
    }

    #[test]
    fn enter_does_not_open_keys_for_keyless_providers() {
        let mut state = empty_state();
        state.providers.insert("codex".into(), cred_single("none"));
        let pids = pids();
        state.active = pids.iter().position(|p| p == "codex").unwrap();
        handle_key(&mut state, &pids, InputKey::Enter);
        assert_eq!(state.mode, ProviderMode::Browse);
    }

    // ---- done ----------------------------------------------------------

    #[test]
    fn enter_on_done_index_emits_done() {
        let mut state = empty_state();
        let pids = pids();
        state.active = pids.len();
        let outcome = handle_key(&mut state, &pids, InputKey::Enter);
        assert_eq!(outcome, ProviderOutcome::Done);
    }

    // ---- clamping ------------------------------------------------------

    #[test]
    fn up_clamps_at_zero() {
        let mut state = empty_state();
        let pids = pids();
        handle_key(&mut state, &pids, InputKey::Up);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn down_clamps_at_done_index() {
        let mut state = empty_state();
        let pids = pids();
        for _ in 0..20 {
            handle_key(&mut state, &pids, InputKey::Down);
        }
        assert_eq!(state.active, pids.len());
    }

    // ---- keys mode -----------------------------------------------------

    #[test]
    fn keys_down_clamps_at_back_index() {
        let mut state = empty_state();
        state
            .providers
            .insert("openrouter".into(), cred_multi(&["k1", "k2"]));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("openrouter".into());
        let pids = pids();
        for _ in 0..10 {
            handle_key(&mut state, &pids, InputKey::Down);
        }
        // back_index = keys.len + 1 == 3
        assert_eq!(state.keys_active, 3);
    }

    #[test]
    fn d_on_key_row_collapses_array_to_string_when_one_remains() {
        let mut state = empty_state();
        state
            .providers
            .insert("anthropic".into(), cred_multi(&["k1", "k2"]));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 0;
        handle_key(&mut state, &pids(), InputKey::Char('d'));
        assert_eq!(
            state.providers["anthropic"].api_key,
            ApiKeyValue::Single("k2".into())
        );
    }

    #[test]
    fn d_on_last_key_drops_provider_and_exits_keys_mode() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 0;
        handle_key(&mut state, &pids(), InputKey::Char('d'));
        assert_eq!(state.mode, ProviderMode::Browse);
        assert!(state.keys_target.is_none());
        assert!(!state.providers.contains_key("anthropic"));
    }

    #[test]
    fn d_clamps_keys_active_after_deletion() {
        let mut state = empty_state();
        state
            .providers
            .insert("anthropic".into(), cred_multi(&["k1", "k2", "k3"]));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 2;
        handle_key(&mut state, &pids(), InputKey::Char('d'));
        // After removing index 2, only 2 keys remain → keys_active clamps to 1.
        assert_eq!(state.keys_active, 1);
    }

    #[test]
    fn enter_on_add_index_emits_request_add_key_with_keys_return() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 1; // add_index when keys.len == 1
        let outcome = handle_key(&mut state, &pids(), InputKey::Enter);
        match outcome {
            ProviderOutcome::RequestAddKey { provider_id, return_to } => {
                assert_eq!(provider_id, "anthropic");
                assert_eq!(return_to, ProviderMode::Keys);
            }
            other => panic!("expected RequestAddKey {{ return_to: Keys }}, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_back_index_returns_to_browse() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 2; // back_index when keys.len == 1
        handle_key(&mut state, &pids(), InputKey::Enter);
        assert_eq!(state.mode, ProviderMode::Browse);
        assert!(state.keys_target.is_none());
    }

    #[test]
    fn esc_in_keys_mode_returns_to_browse() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        handle_key(&mut state, &pids(), InputKey::Escape);
        assert_eq!(state.mode, ProviderMode::Browse);
    }

    #[test]
    fn esc_in_browse_mode_cancels() {
        let mut state = empty_state();
        let outcome = handle_key(&mut state, &pids(), InputKey::Escape);
        assert_eq!(outcome, ProviderOutcome::Cancel);
    }

    #[test]
    fn ctrl_c_always_cancels() {
        let mut state = empty_state();
        let outcome = handle_key(&mut state, &pids(), InputKey::CtrlC);
        assert_eq!(outcome, ProviderOutcome::Cancel);
    }

    // ---- InputKey::from_key_event --------------------------------------

    fn ke(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ke_ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    #[test]
    fn from_key_event_maps_arrows() {
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Up)), InputKey::Up);
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Down)), InputKey::Down);
    }

    #[test]
    fn from_key_event_maps_enter_space_esc() {
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Enter)), InputKey::Enter);
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Char(' '))), InputKey::Space);
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Esc)), InputKey::Escape);
    }

    #[test]
    fn from_key_event_maps_ctrl_c_specifically() {
        // Ctrl-C must take priority even if `Char('c')` would otherwise match.
        assert_eq!(
            InputKey::from_key_event(ke_ctrl(KeyCode::Char('c'))),
            InputKey::CtrlC
        );
    }

    #[test]
    fn from_key_event_maps_other_chars_to_char() {
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Char('d'))), InputKey::Char('d'));
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Char('a'))), InputKey::Char('a'));
    }

    #[test]
    fn from_key_event_maps_unknown_keys_to_other() {
        assert_eq!(InputKey::from_key_event(ke(KeyCode::F(1))), InputKey::Other);
        assert_eq!(InputKey::from_key_event(ke(KeyCode::Tab)), InputKey::Other);
    }

    #[test]
    fn other_input_in_browse_is_continue() {
        let mut state = empty_state();
        let outcome = handle_key(&mut state, &pids(), InputKey::Other);
        assert_eq!(outcome, ProviderOutcome::Continue);
    }

    #[test]
    fn other_input_in_keys_is_continue() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        let outcome = handle_key(&mut state, &pids(), InputKey::Other);
        assert_eq!(outcome, ProviderOutcome::Continue);
    }

    // ---- compose lines -------------------------------------------------

    #[test]
    fn browse_view_shows_check_for_enabled_and_unchecked_for_disabled() {
        let mut state = empty_state();
        state.providers.insert("openrouter".into(), cred_single("sk-1"));
        let pids = pids();
        let lines = compose_browse_lines(&state, &pids, &IndexMap::new());
        // First line: openrouter enabled.
        assert!(lines[0].contains("[✓]"), "got: {}", lines[0]);
        assert!(lines[0].contains("OpenRouter"));
        // Second line: anthropic disabled.
        assert!(lines[1].contains("[ ]"));
        assert!(lines[1].contains("Anthropic"));
    }

    #[test]
    fn browse_view_appends_key_count_suffix() {
        let mut state = empty_state();
        state
            .providers
            .insert("anthropic".into(), cred_multi(&["k1", "k2", "k3"]));
        let lines = compose_browse_lines(&state, &pids(), &IndexMap::new());
        let line = lines.iter().find(|l| l.contains("Anthropic")).unwrap();
        assert!(line.contains("[3 keys]"), "got: {line}");
    }

    #[test]
    fn browse_view_appends_singular_when_one_key() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        let lines = compose_browse_lines(&state, &pids(), &IndexMap::new());
        let line = lines.iter().find(|l| l.contains("Anthropic")).unwrap();
        assert!(line.contains("[1 key]"), "got: {line}");
    }

    #[test]
    fn browse_view_renders_disabled_provider_hints() {
        let state = empty_state();
        let mut hints = IndexMap::new();
        hints.insert(
            "anthropic".into(),
            "via claude setup-token".to_owned(),
        );
        let lines = compose_browse_lines(&state, &pids(), &hints);
        let line = lines.iter().find(|l| l.contains("Anthropic")).unwrap();
        assert!(line.contains("via claude setup-token"), "got: {line}");
    }

    #[test]
    fn browse_view_done_row_uses_thin_chevron_when_active() {
        let mut state = empty_state();
        let pids = pids();
        state.active = pids.len();
        let lines = compose_browse_lines(&state, &pids, &IndexMap::new());
        let last_pre_help = &lines[lines.len() - 2];
        assert!(
            last_pre_help.starts_with(glyphs::CURSOR_THIN),
            "got: {last_pre_help}"
        );
        assert!(last_pre_help.contains("Done"));
    }

    #[test]
    fn browse_help_row_text_verbatim() {
        let state = empty_state();
        let lines = compose_browse_lines(&state, &pids(), &IndexMap::new());
        let help = lines.last().unwrap();
        assert_eq!(help, "  ↑↓ navigate • space toggle • ⏎ manage keys / done");
    }

    #[test]
    fn keys_view_renders_rule_separator_at_correct_width() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        let lines = compose_keys_lines(&state);
        let rule = &lines[1];
        let dashes = rule.matches('─').count();
        assert_eq!(dashes, RULE_WIDTH);
    }

    #[test]
    fn keys_view_help_text_verbatim() {
        let mut state = empty_state();
        state.providers.insert("anthropic".into(), cred_single("k1"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        let lines = compose_keys_lines(&state);
        let help = lines.last().unwrap();
        assert_eq!(
            help,
            "  ↑↓ navigate • d delete key • ⏎ select • esc back"
        );
    }

    #[test]
    fn keys_view_marks_active_row_with_thin_chevron_and_delete_hint() {
        let mut state = empty_state();
        state
            .providers
            .insert("anthropic".into(), cred_multi(&["sk-aaaa1234", "sk-bbbb5678"]));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        state.keys_active = 0;
        let lines = compose_keys_lines(&state);
        let active_row = &lines[2];
        assert!(active_row.starts_with(glyphs::CURSOR_THIN), "got: {active_row}");
        assert!(active_row.contains("d delete"), "got: {active_row}");
    }

    #[test]
    fn keys_view_renders_label_after_masked_key() {
        let mut state = empty_state();
        state
            .providers
            .insert("anthropic".into(), cred_single("sk-ant-oat01-abcdefghij pfer@me.com"));
        state.mode = ProviderMode::Keys;
        state.keys_target = Some("anthropic".into());
        let lines = compose_keys_lines(&state);
        let key_row = &lines[2];
        // Last 4 of the key part are kept; label appears with a 2-space prefix.
        assert!(key_row.contains("ghij"), "got: {key_row}");
        assert!(key_row.contains("pfer@me.com"), "got: {key_row}");
    }
}

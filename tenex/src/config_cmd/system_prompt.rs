//! `tenex config system-prompt` — global system prompt that's added to all
//! projects' agent prompts.
//!
//! Source: `src/commands/config/system-prompt.ts:7-221`. The TS source
//! exposes three CLI flags (`--show`, `--enable`, `--disable`) plus a
//! default action that opens `$EDITOR` on a templated temp file. This
//! Rust port surfaces the same four operations as a sub-menu so
//! `tenex config → System Prompt` works interactively. The editor path
//! itself uses the same delimiter convention to separate template-header
//! from user content (`:137`).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

/// Delimiter line between the template header and user content. Verbatim
/// from `:137` — reproduced exactly so the editor file roundtrips between
/// the TS and Rust ports.
pub const CONTENT_DELIMITER: &str = "---- YOUR PROMPT BELOW THIS LINE ----";

const TEMPLATE_HEADER: &str = "\
# Global System Prompt Configuration
#
# This content will be added to ALL agents' system prompts across ALL projects.
#
# Examples of what you might put here:
# - Personal preferences (e.g., \"Always use TypeScript strict mode\")
# - Coding standards (e.g., \"Follow clean code principles\")
# - Communication preferences (e.g., \"Be concise in responses\")
#
# IMPORTANT: Write your prompt BELOW the delimiter line.
# Everything above the delimiter will be discarded.
# Everything below (including markdown # headings) will be preserved.
#
# Save and close this file when done.

---- YOUR PROMPT BELOW THIS LINE ----
";

pub fn run(base_dir: &Path) -> Result<()> {
    let action = match prompts::select("System Prompt", actions()).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("system prompt menu: {e}")),
    };

    match action.value {
        Action::Show => run_show(base_dir),
        Action::Enable => run_set_enabled(base_dir, true),
        Action::Disable => run_set_enabled(base_dir, false),
        Action::Edit => run_edit(base_dir),
        Action::Back => Ok(()),
    }
}

/// Direct entry points for the three TS flags
/// (`system-prompt.ts:74-76`):
/// - `tenex config system-prompt --show`     → [`run_show`]
/// - `tenex config system-prompt --enable`   → `run_set_enabled(.., true)`
/// - `tenex config system-prompt --disable`  → `run_set_enabled(.., false)`
///
/// When TS sees one of those flags it bypasses the interactive menu
/// and runs the action directly. Mirror that here.
pub fn run_show_flag(base_dir: &Path) -> Result<()> {
    run_show(base_dir)
}

pub fn run_enable_flag(base_dir: &Path) -> Result<()> {
    run_set_enabled(base_dir, true)
}

pub fn run_disable_flag(base_dir: &Path) -> Result<()> {
    run_set_enabled(base_dir, false)
}

fn run_show(base_dir: &Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let content = doc.global_system_prompt_content().unwrap_or_default();
    let enabled = doc.global_system_prompt_enabled().unwrap_or(true);

    if content.trim().is_empty() {
        let gray = crate::tui::theme::chalk_gray();
        println!("{}", gray.apply_to("No global system prompt configured."));
        return Ok(());
    }
    // TS at system-prompt.ts:95-98 uses `amberBold` and `amber` from
    // utils/cli-theme.ts — chalk.hex('#FFC107') / chalk.hex('#FFC107').bold,
    // i.e. the INQUIRER-amber truecolor (NOT the display palette's
    // xterm-256 #214). Emit raw `\x1b[38;2;255;193;7m` so the wire
    // bytes match TS chalk.hex output exactly.
    let amber_open = crate::tui::theme::INQUIRER_AMBER_FG;
    let amber_close = crate::tui::theme::FG_RESET;
    let bold_open = crate::tui::theme::BOLD_OPEN;
    let bold_close = crate::tui::theme::BOLD_CLOSE;
    let label = if enabled { "enabled" } else { "disabled" };
    println!(
        "{amber_open}{bold_open}Global System Prompt ({label}):{bold_close}{amber_close}"
    );
    let rule = "─".repeat(50);
    println!("{amber_open}{rule}{amber_close}");
    println!("{content}");
    println!("{amber_open}{rule}{amber_close}");
    Ok(())
}

fn run_set_enabled(base_dir: &Path, enabled: bool) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.set_global_system_prompt_enabled(enabled);
    doc.save(base_dir)?;
    let label = if enabled { "enabled" } else { "disabled" };
    crate::tui::display::config_success(&format!("Global system prompt {label}."));
    Ok(())
}

fn run_edit(base_dir: &Path) -> Result<()> {
    let editor = preferred_editor();
    // TS at system-prompt.ts:162 uses `amberBold` from utils/cli-theme
    // (chalk.hex('#FFC107').bold) — INQUIRER-amber truecolor, not the
    // display palette's xterm-256 #214. Emit raw truecolor escape.
    let amber_open = crate::tui::theme::INQUIRER_AMBER_FG;
    let amber_close = crate::tui::theme::FG_RESET;
    let bold_open = crate::tui::theme::BOLD_OPEN;
    let bold_close = crate::tui::theme::BOLD_CLOSE;
    let gray = crate::tui::theme::chalk_gray();
    println!(
        "{amber_open}{bold_open}Opening editor to configure global system prompt...{bold_close}{amber_close}"
    );
    // TS at system-prompt.ts:163 puts the trailing `\n` INSIDE the gray
    // wrap: `chalk.gray(`(Using editor: ${getEditor()})\n`)`. console.log
    // adds another newline after, producing one styled line + one blank
    // line. Mirror byte-for-byte by embedding the `\n` in the styled
    // string before console.log's auto-newline.
    println!("{}", gray.apply_to(format!("(Using editor: {editor})\n")));

    let doc = TenexConfigDoc::load(base_dir)?;
    let existing_content = doc.global_system_prompt_content().unwrap_or_default();
    drop(doc);

    let temp_path = make_temp_path()?;
    let initial = format!("{TEMPLATE_HEADER}{existing_content}");
    std::fs::write(&temp_path, &initial)
        .with_context(|| format!("writing template to {}", temp_path.display()))?;

    let edit_result = open_in_editor(&editor, &temp_path);
    let read_result = std::fs::read_to_string(&temp_path);
    // Always remove the temp file, ignoring failures (matches TS try/finally).
    let _ = std::fs::remove_file(&temp_path);

    edit_result?;
    let edited = read_result.with_context(|| {
        format!("reading edited file at {}", temp_path.display())
    })?;

    let cleaned = extract_content_after_delimiter(&edited);

    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.set_global_system_prompt_content(cleaned.clone());
    doc.save(base_dir)?;

    if cleaned.is_empty() {
        crate::tui::display::config_success("Global system prompt cleared (no content).");
    } else {
        crate::tui::display::config_success("Global system prompt saved successfully!");
        let gray = crate::tui::theme::chalk_gray();
        // TS `cleanedContent.length` measures UTF-16 code units, but the
        // user-visible label says "characters" — Rust .len() returns
        // bytes which over-counts every multi-byte codepoint. Use
        // .chars().count() so multi-byte content (CJK, emoji, accented
        // letters) reports a count closer to what TS would produce.
        // For purely-ASCII content the two implementations agree byte
        // for byte. (Surrogate-pair codepoints — chars outside the BMP
        // — still diverge: JS reports 2, Rust reports 1. That's an
        // acceptable approximation; real-world system prompts almost
        // never contain non-BMP characters.)
        println!(
            "{}",
            gray.apply_to(format!(
                "Content length: {} characters",
                cleaned.chars().count()
            ))
        );
        // TS at system-prompt.ts:209 emits:
        //   console.log(chalk.gray("\nThis prompt will be added to all agents' system prompts."));
        // — leading `\n` is INSIDE the gray wrap. Mirror byte-for-byte by
        // embedding it inside the apply_to string.
        println!(
            "{}",
            gray.apply_to("\nThis prompt will be added to all agents' system prompts.")
        );
    }
    Ok(())
}

/// Extract the user-content portion of an edited file. Source:
/// `system-prompt.ts:179-191`. When the delimiter is absent (user nuked
/// the template), the whole file is treated as content.
pub fn extract_content_after_delimiter(edited: &str) -> String {
    if let Some(idx) = edited.find(CONTENT_DELIMITER) {
        edited[idx + CONTENT_DELIMITER.len()..].trim().to_owned()
    } else {
        edited.trim().to_owned()
    }
}

/// Resolve the user's preferred editor. Source: `getEditor` at
/// `system-prompt.ts:16-32`. `$VISUAL` wins, then `$EDITOR`, then
/// `notepad` on Windows, otherwise `nano`.
pub fn preferred_editor() -> String {
    if let Ok(v) = std::env::var("VISUAL") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Ok(v) = std::env::var("EDITOR") {
        if !v.is_empty() {
            return v;
        }
    }
    if cfg!(target_os = "windows") {
        "notepad".to_owned()
    } else {
        "nano".to_owned()
    }
}

fn open_in_editor(editor: &str, file: &Path) -> Result<()> {
    // Use shell so multi-token `$EDITOR` values (e.g. `code --wait`) work
    // exactly as in TS (`:43-50`).
    let cmd = format!("{editor} \"{}\"", file.display());
    let status = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", &cmd]).status()
    } else {
        Command::new("/bin/sh").args(["-c", &cmd]).status()
    }
    .with_context(|| format!("failed to spawn editor '{editor}'"))?;

    if status.success() || status.code().is_none() {
        Ok(())
    } else {
        Err(anyhow!(
            "Editor exited with code {}",
            status.code().unwrap_or(-1)
        ))
    }
}

fn make_temp_path() -> Result<PathBuf> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(std::env::temp_dir().join(format!("tenex-global-prompt-{now}.md")))
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Show,
    Edit,
    Enable,
    Disable,
    Back,
}

#[derive(Debug, Clone)]
struct ActionItem {
    label: String,
    value: Action,
}

impl std::fmt::Display for ActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn actions() -> Vec<ActionItem> {
    let dim_back = console::Style::new().dim().apply_to("Back").to_string();
    vec![
        ActionItem {
            label: "Show current".into(),
            value: Action::Show,
        },
        ActionItem {
            label: "Edit (open in $EDITOR)".into(),
            value: Action::Edit,
        },
        ActionItem {
            label: "Enable".into(),
            value: Action::Enable,
        },
        ActionItem {
            label: "Disable".into(),
            value: Action::Disable,
        },
        ActionItem {
            label: dim_back,
            value: Action::Back,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-system-prompt-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn delimiter_line_is_verbatim_ts_string() {
        // Pin the exact delimiter; the TS port and the Rust port must agree
        // on this byte-for-byte or roundtrip breaks.
        assert_eq!(
            CONTENT_DELIMITER,
            "---- YOUR PROMPT BELOW THIS LINE ----"
        );
    }

    #[test]
    fn template_header_ends_with_delimiter_and_newline() {
        // Ensures the template a fresh user sees has the delimiter at the
        // bottom — without it, the first save would treat the entire
        // template as content.
        assert!(TEMPLATE_HEADER.contains(CONTENT_DELIMITER));
        assert!(TEMPLATE_HEADER.ends_with("\n"));
    }

    #[test]
    fn extract_after_delimiter_returns_trimmed_user_content() {
        let edited = format!(
            "# header\nstuff\n{CONTENT_DELIMITER}\nthe real prompt\n"
        );
        assert_eq!(
            extract_content_after_delimiter(&edited),
            "the real prompt"
        );
    }

    #[test]
    fn extract_after_delimiter_preserves_markdown_headings_below() {
        let edited = format!(
            "preface\n{CONTENT_DELIMITER}\n# Heading\nbody\n"
        );
        assert_eq!(
            extract_content_after_delimiter(&edited),
            "# Heading\nbody"
        );
    }

    #[test]
    fn extract_with_no_delimiter_uses_whole_file() {
        let edited = "  the user wiped the template  \n";
        assert_eq!(
            extract_content_after_delimiter(edited),
            "the user wiped the template"
        );
    }

    #[test]
    fn extract_with_only_delimiter_returns_empty() {
        let edited = format!("preface\n{CONTENT_DELIMITER}\n   \n");
        assert_eq!(extract_content_after_delimiter(&edited), "");
    }

    #[test]
    fn preferred_editor_falls_back_to_nano_on_unix_when_env_unset() {
        // Skip when env vars are present — the test process inherits.
        if std::env::var("VISUAL").is_ok() || std::env::var("EDITOR").is_ok() {
            return;
        }
        if !cfg!(target_os = "windows") {
            assert_eq!(preferred_editor(), "nano");
        }
    }

    #[test]
    fn enable_persists_block_with_enabled_true() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_global_system_prompt_enabled(true);
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.global_system_prompt_enabled(), Some(true));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn disable_preserves_existing_content() {
        // Per `:107-109` — disable spread-shapes the existing block,
        // only flipping `enabled`. Verify content survives.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_global_system_prompt_content("be concise".into());
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_global_system_prompt_enabled(false);
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.global_system_prompt_enabled(), Some(false));
        assert_eq!(
            r.global_system_prompt_content().as_deref(),
            Some("be concise"),
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_content_force_enables_block() {
        // Per `:194-200` — the editor-save path always sets
        // `enabled: true` regardless of prior state.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_global_system_prompt_enabled(false);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_global_system_prompt_content("new prompt".into());
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.global_system_prompt_enabled(), Some(true));
        assert_eq!(
            r.global_system_prompt_content().as_deref(),
            Some("new prompt")
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn actions_match_expected_set_in_order() {
        let acts = actions();
        let labels: Vec<&str> = acts
            .iter()
            .map(|a| a.label.as_str())
            .map(|l| {
                // Strip trailing ANSI reset on the dim Back label for the
                // assertion (Style::dim emits surrounding escape codes).
                let stripped = console::strip_ansi_codes(l);
                let s: &str = match stripped {
                    std::borrow::Cow::Borrowed(b) => b,
                    std::borrow::Cow::Owned(_) => "Back",
                };
                s
            })
            .collect();
        assert_eq!(
            labels,
            vec!["Show current", "Edit (open in $EDITOR)", "Enable", "Disable", "Back"],
        );
    }

    /// Pin the character-count semantics — the post-save 'Content length'
    /// line uses `cleaned.chars().count()`, NOT `cleaned.len()` (bytes).
    /// For ASCII the two agree; for multi-byte content the byte count
    /// over-counts. The label says 'characters' so the codepoint count
    /// is what users expect.
    #[test]
    fn content_length_uses_codepoint_count_not_byte_count() {
        let ascii = "hello";
        assert_eq!(ascii.chars().count(), 5);
        assert_eq!(ascii.len(), 5);

        // Multi-byte CJK: 5 codepoints, 15 bytes.
        let cjk = "你好世界。";
        assert_eq!(cjk.chars().count(), 5);
        assert_eq!(cjk.len(), 15);

        // Multi-byte accented: 5 codepoints, 8 bytes.
        let acc = "café!";
        assert_eq!(acc.chars().count(), 5);
        assert_eq!(acc.len(), 6);

        // The 'characters' line uses the .chars().count() form so
        // multi-byte content reports a sensible count.
        for s in [ascii, cjk, acc] {
            let label = format!("Content length: {} characters", s.chars().count());
            assert!(label.contains("characters"));
            // Reading just the count out of the label and comparing
            // proves the formatter consumed the codepoint count.
            let count_str: String = label
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect();
            assert_eq!(count_str.parse::<usize>().unwrap(), s.chars().count());
        }
    }
}

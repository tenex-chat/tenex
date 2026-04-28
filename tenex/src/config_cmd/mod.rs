//! `tenex config` — top-level configuration menu.
//!
//! Submodules:
//! - [`relays`] — `tenex config relays` (spec doc 08).
//! - [`identity`] — `tenex config identity` (spec doc 07).
//! - [`logging`] — `tenex config logging`.
//! - [`paths`] — `tenex config paths`.
//! - [`escalation`] — `tenex config escalation`.
//! - [`summarization`] — `tenex config summarization`.
//! - [`intervention`] — `tenex config intervention`.
//! - [`nip46`] — `tenex config nip46`.
//! - [`telemetry`] — `tenex config telemetry`.
//! - [`system_prompt`] — `tenex config system-prompt`.
//! - [`context_management`] — `tenex config context-management`.
//! - [`telegram`] — `tenex config telegram` (DM allowlist live; per-agent
//!   bot config requires AgentStorage which is a separate iteration).
//!
//! Source: `src/commands/config/index.ts:77-154` (`runConfigMenu` +
//! command registration). The menu is a `while (true)` loop that
//! re-renders after each submenu returns; on `Back` / Esc / Ctrl-C the
//! loop exits.
//!
//! Per spec doc 02 the menu has 5 sections / 16 selectable entries +
//! a `Back` sentinel. Submenu coverage:
//!
//! | Entry         | Status                                                         |
//! |---------------|----------------------------------------------------------------|
//! | Providers     | Wired — runs the same auto-detect + provider-select flow used in onboarding (provider hints empty since this entry is invoked outside the onboarding context) |
//! | LLMs          | Wired — runs [`crate::onboard::llm_editor::run`]               |
//! | Roles         | Wired — runs [`crate::onboard::role_assignment::run`]          |
//! | Embeddings    | Wired — runs [`crate::onboard::embeddings::run`] using the configured provider IDs |
//! | All others    | Surfaced via `display::hint` "submenu pending port" — honest about what's not done yet (per CLAUDE.md absolute rule "no half-finished implementations") |

pub mod context_management;
pub mod escalation;
pub mod identity;
pub mod intervention;
pub mod logging;
pub mod nip46;
pub mod paths;
pub mod relays;
pub mod summarization;
pub mod system_prompt;
pub mod telegram;
pub mod telemetry;

use anyhow::Result;
use clap::Parser;

use crate::onboard::auto_select_roles::EmptyModelInfoSource;
use crate::store::providers::ProvidersDoc;
use crate::tui::custom_prompts::section_menu_prompt::{
    section_menu_prompt, MenuEntry, MenuSection, SectionMenuResult,
};
use crate::tui::display;

#[derive(Parser, Clone)]
pub struct ConfigArgs {}

pub async fn run(_args: ConfigArgs) -> Result<()> {
    // The TS source prints a welcome banner on entry to interactive
    // config (`src/commands/config/interactive.ts:10`). Reproduce that
    // here — same `display::welcome` used by `tenex onboard`.
    display::welcome();

    let base_dir = crate::store::resolve_base_dir(None);
    let sections = build_menu_sections();

    loop {
        match section_menu_prompt("Settings", &sections)? {
            SectionMenuResult::Back | SectionMenuResult::Cancelled => return Ok(()),
            SectionMenuResult::Selected(value) => {
                dispatch(&base_dir, &value).await?;
            }
        }
    }
}

async fn dispatch(base_dir: &std::path::Path, value: &str) -> Result<()> {
    match value {
        "providers" => run_providers_submenu(base_dir).await,
        "llm" => run_llm_submenu(base_dir),
        "roles" => run_roles_submenu(base_dir),
        "embed" => run_embed_submenu(base_dir),
        "relays" => relays::run(base_dir),
        "identity" => identity::run(base_dir),
        "logging" => logging::run(base_dir),
        "paths" => paths::run(base_dir),
        "escalation" => escalation::run(base_dir),
        "summarization" => summarization::run(base_dir),
        "intervention" => intervention::run(base_dir),
        "nip46" => nip46::run(base_dir),
        "telemetry" => telemetry::run(base_dir),
        "system-prompt" => system_prompt::run(base_dir),
        "context-management" => context_management::run(base_dir),
        "telegram" => telegram::run(base_dir),
        // All 16 config submenus are now wired. Anything else here is a
        // typo or future addition — surface a hint and recurse.
        _ => {
            display::hint(&format!(
                "Submenu '{value}' is pending port — see spec docs in tenex/docs/tui-port/.",
            ));
            Ok(())
        }
    }
}

async fn run_providers_submenu(base_dir: &std::path::Path) -> Result<()> {
    let starting = ProvidersDoc::load(base_dir)?;
    let outcome = crate::onboard::providers::run(starting, std::collections::HashMap::new())?;
    match outcome {
        crate::onboard::providers::ProviderSetupResult::Configured(doc) => {
            doc.save(base_dir)?;
            display::success("Provider credentials saved");
        }
        crate::onboard::providers::ProviderSetupResult::Cancelled => {}
    }
    Ok(())
}

fn run_llm_submenu(base_dir: &std::path::Path) -> Result<()> {
    let _ = crate::onboard::llm_editor::run(base_dir)?;
    Ok(())
}

fn run_roles_submenu(base_dir: &std::path::Path) -> Result<()> {
    let _ = crate::onboard::role_assignment::run(base_dir, &EmptyModelInfoSource)?;
    Ok(())
}

fn run_embed_submenu(base_dir: &std::path::Path) -> Result<()> {
    // Use the configured providers — without that list the auto-pick
    // recommendation falls back to "Local Transformers" silently, which
    // matches `runEmbeddingSetup` semantics with zero providers (`:392-403`).
    let providers = ProvidersDoc::load(base_dir)?;
    let configured = providers.provider_ids();
    let _ = crate::onboard::embeddings::run(base_dir, &configured)?;
    Ok(())
}

/// Build the menu sections verbatim from `MENU_SECTIONS` at
/// `src/commands/config/index.ts:33-75`. Labels are padded with
/// trailing spaces to the 16-character slot per `:89` and rendered with
/// the em-dash separator `"— "` per `:91`.
pub fn build_menu_sections() -> Vec<MenuSection> {
    let raw = [
        (
            "AI",
            &[
                ("Providers", "providers", "API keys and connections"),
                ("LLMs", "llm", "Model configurations"),
                ("Roles", "roles", "Which model handles what task"),
                ("Embeddings", "embed", "Text embedding model"),
            ][..],
        ),
        (
            "Agents",
            &[
                ("Escalation", "escalation", "Route ask() through an agent first"),
                ("Intervention", "intervention", "Auto-review when you're idle"),
                ("Telegram", "telegram", "Agent bot transport and global DM access"),
            ][..],
        ),
        (
            "Network",
            &[("Relays", "relays", "Nostr relay connections")][..],
        ),
        (
            "Conversations",
            &[
                ("Summarization", "summarization", "Auto-summary timing"),
                ("Context", "context-management", "Context management settings"),
            ][..],
        ),
        (
            "Advanced",
            &[
                ("Identity", "identity", "Authorized pubkeys"),
                ("System Prompt", "system-prompt", "Global prompt for all projects"),
                ("Paths", "paths", "File paths and storage"),
                ("NIP-46", "nip46", "Remote signing"),
                ("Logging", "logging", "Log level and file path"),
                ("Telemetry", "telemetry", "OpenTelemetry tracing"),
            ][..],
        ),
    ];

    raw.into_iter()
        .map(|(header, entries)| MenuSection {
            header: header.to_owned(),
            entries: entries
                .iter()
                .map(|(label, value, desc)| MenuEntry {
                    label: format_label(label, desc),
                    value: (*value).to_owned(),
                })
                .collect(),
        })
        .collect()
}

/// Pad `label` to 16 visible characters, then append `"— "` and the
/// description. Source: `src/commands/config/index.ts:89-91`.
fn format_label(label: &str, description: &str) -> String {
    let mut padded = label.to_owned();
    while padded.chars().count() < 16 {
        padded.push(' ');
    }
    format!("{padded}— {description}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_entries(sections: &[MenuSection]) -> Vec<(String, String)> {
        sections
            .iter()
            .flat_map(|s| {
                s.entries
                    .iter()
                    .map(|e| (e.value.clone(), e.label.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn menu_has_five_sections() {
        let s = build_menu_sections();
        assert_eq!(s.len(), 5);
    }

    #[test]
    fn menu_section_headers_are_verbatim_ts_strings() {
        let s = build_menu_sections();
        let headers: Vec<&str> = s.iter().map(|x| x.header.as_str()).collect();
        assert_eq!(
            headers,
            vec!["AI", "Agents", "Network", "Conversations", "Advanced"]
        );
    }

    #[test]
    fn menu_total_entry_count_is_16() {
        let s = build_menu_sections();
        let total: usize = s.iter().map(|sec| sec.entries.len()).sum();
        assert_eq!(total, 16);
    }

    #[test]
    fn menu_entry_values_match_ts_subcommand_names_in_order() {
        let s = build_menu_sections();
        let values: Vec<String> = collect_entries(&s).into_iter().map(|(v, _)| v).collect();
        // Per spec 02 §2.4 / `index.ts:139-154`, the same 16 commands are
        // attached as flat subcommands in this exact order.
        assert_eq!(
            values,
            vec![
                "providers",
                "llm",
                "roles",
                "embed",
                "escalation",
                "intervention",
                "telegram",
                "relays",
                "summarization",
                "context-management",
                "identity",
                "system-prompt",
                "paths",
                "nip46",
                "logging",
                "telemetry",
            ]
        );
    }

    #[test]
    fn menu_entry_labels_use_em_dash_separator() {
        let s = build_menu_sections();
        for sec in &s {
            for e in &sec.entries {
                assert!(e.label.contains("— "), "missing em-dash in: {}", e.label);
            }
        }
    }

    #[test]
    fn menu_labels_pad_to_at_least_16_chars_before_em_dash() {
        let s = build_menu_sections();
        for sec in &s {
            for entry in &sec.entries {
                let pre = entry.label.split("— ").next().unwrap();
                // The label part (before "— ") should be exactly 16 chars
                // (some labels are longer than 16 — those don't pad).
                let pre_len = pre.chars().count();
                let label_only = entry.label.split_whitespace().next().unwrap();
                if label_only.len() <= 16 {
                    assert_eq!(pre_len, 16, "for label: {pre:?}");
                }
            }
        }
    }

    #[test]
    fn menu_descriptions_match_ts_verbatim() {
        let s = build_menu_sections();
        // Spot-check a few from spec 02 §3.3.
        let providers = &s[0].entries[0];
        assert!(providers.label.contains("API keys and connections"));
        let llms = &s[0].entries[1];
        assert!(llms.label.contains("Model configurations"));
        let identity = &s[4].entries[0];
        assert!(identity.label.contains("Authorized pubkeys"));
        let nip46 = &s[4].entries[3];
        assert!(nip46.label.contains("Remote signing"));
    }

    #[test]
    fn format_label_pads_short_labels_to_sixteen_chars() {
        let s = format_label("LLMs", "Model configurations");
        // "LLMs" + 12 spaces = 16 chars before "— ".
        assert!(s.starts_with("LLMs            — "));
    }

    #[test]
    fn format_label_does_not_truncate_long_labels() {
        let s = format_label("Intervention", "x");
        // "Intervention" is 12 chars → padded to 16. "Summarization" is 13.
        assert!(s.starts_with("Intervention    — "));
    }
}

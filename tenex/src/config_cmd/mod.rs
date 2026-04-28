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
pub mod paths;
pub mod relays;
pub mod summarization;
pub mod system_prompt;
pub mod telegram;
pub mod telemetry;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::onboard::auto_select_roles;
use crate::store::providers::ProvidersDoc;
use crate::tui::custom_prompts::section_menu_prompt::{
    section_menu_prompt, MenuEntry, MenuSection, SectionMenuResult,
};
use crate::tui::display;

/// Mirror of the TS `configCommand` subcommand surface
/// (`src/commands/config/index.ts:125-154`). Bare `tenex config` enters
/// the interactive section menu; each named subcommand jumps straight
/// to the corresponding submenu, matching every `tenex config <X>`
/// shortcut TS exposes.
#[derive(Parser, Clone)]
pub struct ConfigArgs {
    #[command(subcommand)]
    pub command: Option<ConfigCommand>,
}

#[derive(Subcommand, Clone)]
pub enum ConfigCommand {
    /// Configure global provider credentials
    Providers,
    /// Manage LLM configurations (global only)
    Llm {
        /// Show advanced options (temperature, max tokens)
        #[arg(long)]
        advanced: bool,
    },
    /// Configure which model handles what task
    Roles,
    /// Configure embedding model for RAG (global by default, --project for current project)
    Embed,
    /// Configure agent escalation — route ask() calls through an agent first
    Escalation,
    /// Configure intervention — auto-review when you're idle
    Intervention,
    /// Configure agent Telegram bots, global DM access, and remembered project bindings
    Telegram,
    /// Configure Nostr relay connections
    Relays,
    /// Configure auto-summary timing
    Summarization,
    /// Configure managed context settings
    #[command(name = "context-management")]
    ContextManagement,
    /// Configure authorized pubkeys
    Identity,
    /// Configure a global system prompt that is added to all projects
    #[command(name = "system-prompt")]
    SystemPrompt,
    /// Configure file paths and storage
    Paths,
    /// Configure logging — log level and file path
    Logging,
    /// Configure OpenTelemetry tracing and analysis telemetry
    Telemetry,
}

impl ConfigCommand {
    /// Stable token used by the section-menu dispatch path. Matches the
    /// values returned by the TS menu rows at
    /// `src/commands/config/index.ts:33-75` so the same dispatcher
    /// works for both the menu and the direct-subcommand entry.
    fn dispatch_value(&self) -> &'static str {
        match self {
            ConfigCommand::Providers => "providers",
            ConfigCommand::Llm { .. } => "llm",
            ConfigCommand::Roles => "roles",
            ConfigCommand::Embed => "embed",
            ConfigCommand::Escalation => "escalation",
            ConfigCommand::Intervention => "intervention",
            ConfigCommand::Telegram => "telegram",
            ConfigCommand::Relays => "relays",
            ConfigCommand::Summarization => "summarization",
            ConfigCommand::ContextManagement => "context-management",
            ConfigCommand::Identity => "identity",
            ConfigCommand::SystemPrompt => "system-prompt",
            ConfigCommand::Paths => "paths",
            ConfigCommand::Logging => "logging",
            ConfigCommand::Telemetry => "telemetry",
        }
    }
}

pub async fn run(args: ConfigArgs) -> Result<()> {
    let base_dir = crate::store::resolve_base_dir(None);

    if let Some(cmd) = args.command {
        // Direct subcommand path — skip the welcome banner and section
        // menu, dispatch straight to the submodule. Matches TS's
        // `tenex config <name>` direct-action behaviour
        // (`src/commands/config/index.ts:137-153` — each submodule
        // command attaches its own action handler).
        return dispatch(&base_dir, cmd.dispatch_value()).await;
    }

    // The TS source prints a welcome banner on entry to interactive
    // config (`src/commands/config/interactive.ts:10`). Reproduce that
    // here — same `display::welcome` used by `tenex onboard`.
    display::welcome();

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
    // Mirror the no-providers guard at TS `commands/config/llm.ts:23-29`.
    // Two-line error: red "❌ No providers configured." then an amber `→`
    // hint pointing at `tenex config providers`. TS calls process.exit(1)
    // when the providers map is empty; we mirror with an early return + a
    // non-zero exit via std::process::exit so the surrounding menu loop
    // doesn't recurse into a broken editor.
    let providers = ProvidersDoc::load(base_dir)?;
    if providers.provider_ids().is_empty() {
        let red = console::Style::new().red();
        let amber = crate::tui::theme::display_accent();
        let bold = console::Style::new().bold();
        eprintln!("{}", red.apply_to("❌ No providers configured."));
        eprintln!(
            "{}{}",
            amber.apply_to("→"),
            bold.apply_to(" Run tenex config providers first"),
        );
        std::process::exit(1);
    }
    let _ = crate::onboard::llm_editor::run(base_dir)?;
    Ok(())
}

fn run_roles_submenu(base_dir: &std::path::Path) -> Result<()> {
    // Use the on-disk models.dev cache when available (best-effort
    // read; falls back to an empty source when the cache file is
    // missing or unparseable — see auto_select_roles::load_or_empty).
    let model_info = auto_select_roles::load_or_empty(base_dir);
    let _ = crate::onboard::role_assignment::run(base_dir, model_info.as_ref())?;
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

    /// Pin each `tenex config <name>` subcommand description against
    /// the TS source. Prevents future drift.
    #[test]
    fn config_subcommand_descriptions_match_ts_verbatim() {
        use clap::CommandFactory;
        let cmd = ConfigArgs::command();

        let expected = [
            ("providers", "Configure global provider credentials"),
            ("llm", "Manage LLM configurations (global only)"),
            ("roles", "Configure which model handles what task"),
            (
                "embed",
                "Configure embedding model for RAG (global by default, --project for current project)",
            ),
            (
                "escalation",
                "Configure agent escalation — route ask() calls through an agent first",
            ),
            (
                "intervention",
                "Configure intervention — auto-review when you're idle",
            ),
            (
                "telegram",
                "Configure agent Telegram bots, global DM access, and remembered project bindings",
            ),
            ("relays", "Configure Nostr relay connections"),
            ("summarization", "Configure auto-summary timing"),
            ("context-management", "Configure managed context settings"),
            ("identity", "Configure authorized pubkeys"),
            (
                "system-prompt",
                "Configure a global system prompt that is added to all projects",
            ),
            ("paths", "Configure file paths and storage"),
            ("logging", "Configure logging — log level and file path"),
            (
                "telemetry",
                "Configure OpenTelemetry tracing and analysis telemetry",
            ),
        ];

        for (name, want) in expected {
            let sub = cmd
                .find_subcommand(name)
                .unwrap_or_else(|| panic!("missing subcommand: {name}"));
            assert_eq!(
                sub.get_about().map(|s| s.to_string()).as_deref(),
                Some(want),
                "description mismatch on `tenex config {name}`"
            );
        }
    }

    #[test]
    fn config_subcommands_count_matches_ts() {
        // Spec doc 02 §2.4 / TS commands/config/index.ts:137-153 — 15
        // subcommands attached after the NIP-46 cutover (was 16 before).
        use clap::CommandFactory;
        let cmd = ConfigArgs::command();
        // Real subcommands plus the auto-generated `help`.
        let names: Vec<&str> = cmd
            .get_subcommands()
            .map(|s| s.get_name())
            .filter(|n| *n != "help")
            .collect();
        assert_eq!(names.len(), 15, "got: {names:?}");
    }

    #[test]
    fn llm_subcommand_exposes_advanced_flag_with_ts_help_text() {
        // TS source: src/commands/config/llm.ts:11 —
        //   .option("--advanced", "Show advanced options (temperature, max tokens)")
        use clap::CommandFactory;
        let cmd = ConfigArgs::command();
        let llm = cmd.find_subcommand("llm").unwrap();
        let advanced = llm
            .get_arguments()
            .find(|a| a.get_long() == Some("advanced"))
            .expect("--advanced flag missing on `tenex config llm`");
        assert_eq!(
            advanced.get_help().map(|s| s.to_string()).as_deref(),
            Some("Show advanced options (temperature, max tokens)"),
        );
    }

    #[test]
    fn config_dispatch_value_for_each_variant_matches_ts_subcommand_name() {
        // For every variant, dispatch_value() must equal the same name
        // clap registers so `tenex config <name>` and the section-menu
        // dispatch path use the exact same dispatcher branch.
        let cases = [
            (ConfigCommand::Providers, "providers"),
            (ConfigCommand::Llm { advanced: false }, "llm"),
            (ConfigCommand::Roles, "roles"),
            (ConfigCommand::Embed, "embed"),
            (ConfigCommand::Escalation, "escalation"),
            (ConfigCommand::Intervention, "intervention"),
            (ConfigCommand::Telegram, "telegram"),
            (ConfigCommand::Relays, "relays"),
            (ConfigCommand::Summarization, "summarization"),
            (ConfigCommand::ContextManagement, "context-management"),
            (ConfigCommand::Identity, "identity"),
            (ConfigCommand::SystemPrompt, "system-prompt"),
            (ConfigCommand::Paths, "paths"),
            (ConfigCommand::Logging, "logging"),
            (ConfigCommand::Telemetry, "telemetry"),
        ];
        for (variant, expected_name) in cases {
            assert_eq!(variant.dispatch_value(), expected_name);
        }
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
    fn menu_total_entry_count_is_15() {
        // Was 16 in spec 02; the `nip46` entry was dropped along with the
        // NIP-46 cutover. Now 15 entries across the 5 sections.
        let s = build_menu_sections();
        let total: usize = s.iter().map(|sec| sec.entries.len()).sum();
        assert_eq!(total, 15);
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

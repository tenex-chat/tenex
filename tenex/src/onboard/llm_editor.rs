//! Onboarding Screen 4 (sub-step B): LLM configuration editor driver.
//!
//! Source: `src/llm/LLMConfigEditor.ts:175-271`. Wraps the bespoke
//! [`crate::tui::custom_prompts::llm_menu_prompt`] in a recurse-on-action
//! loop that:
//!
//! - **Done** — exit cleanly.
//! - **`delete:<name>`** — drop the config from `llms.json`, save, recurse.
//! - **`add` / `add-multi` / `config:<name>`** — these branches require
//!   the standard-config builder (`addConfiguration`,
//!   `addMultiModalConfiguration`) and the per-config detail editor (the
//!   inner select that asks for provider/model/effort/personality/etc.).
//!   Those sub-flows are large enough to deserve their own iterations and
//!   are wired here as explicit `display::hint` notices that recurse the
//!   menu — no stubs that pretend to succeed (per CLAUDE.md absolute rules).
//!
//! The `onTest` callback is currently surfaced as a "test runner not yet
//! configured" hint; the actual test-runner integration (per spec doc 06)
//! is its own subsystem (provider-aware streaming + 30s timeout +
//! four-string error-hint mapping).

use std::fmt::Write as _;

use anyhow::{anyhow, Context, Result};

use crate::store::llms::{LlmConfigKind, LlmsDoc};
use crate::tui::custom_prompts::llm_menu_prompt::{
    llm_menu_prompt, ActionItem, ConfigItem, LlmMenuResult, TestResult,
};
use crate::tui::display;

/// Result of running the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmEditorResult {
    /// User exited via Done.
    Done,
    /// User cancelled (Ctrl-C / Esc).
    Cancelled,
}

/// Run the editor against `<base_dir>/llms.json` until the user exits.
pub fn run(base_dir: &std::path::Path) -> Result<LlmEditorResult> {
    loop {
        let doc = LlmsDoc::load(base_dir)
            .with_context(|| format!("loading llms.json from {}", base_dir.display()))?;
        let items = build_items(&doc);
        let actions = action_items();

        let result = llm_menu_prompt(
            "LLM configurations:",
            &actions,
            &items,
            Some(|_name: &str| TestResult {
                success: false,
                error: Some(
                    "test runner not yet configured (use `tenex config llm` once the test \
                     runner is ported)"
                        .to_owned(),
                ),
            }),
        )
        .map_err(|e| anyhow!("llm menu I/O: {e}"))?;

        match result {
            LlmMenuResult::Cancelled => return Ok(LlmEditorResult::Cancelled),
            LlmMenuResult::Selected(value) => {
                if !route(base_dir, &value)? {
                    return Ok(LlmEditorResult::Done);
                }
                // Anything other than `done` recurses the menu.
            }
        }
    }
}

/// Dispatch on the menu's selected value. Returns `Ok(true)` to continue
/// looping (recurse the menu), `Ok(false)` to exit.
pub fn route(base_dir: &std::path::Path, value: &str) -> Result<bool> {
    match value {
        "done" => Ok(false),
        "add" => {
            display::hint(
                "Adding a new configuration is pending port (see `tenex config llm`).",
            );
            Ok(true)
        }
        "add-multi" => {
            display::hint(
                "Adding a multi-modal configuration is pending port (see `tenex config llm`).",
            );
            Ok(true)
        }
        v if v.starts_with("delete:") => {
            let name = &v["delete:".len()..];
            delete_configuration(base_dir, name)?;
            Ok(true)
        }
        v if v.starts_with("config:") => {
            // TS behaviour: pressing Enter on a config item produces
            // `config:<name>` as the action, but `showMainMenu` matches
            // only against `delete:`, `add`, `addMultiModal`, and `done`.
            // No handler matches `config:` — the function falls through
            // and the menu re-renders. Match that exactly: silent recurse.
            // (`LLMConfigEditor.ts:221-232`).
            Ok(true)
        }
        _ => {
            // Unknown value — recurse defensively rather than swallowing.
            Ok(true)
        }
    }
}

fn delete_configuration(base_dir: &std::path::Path, name: &str) -> Result<()> {
    let mut doc = LlmsDoc::load(base_dir)?;
    if doc.get(name).is_none() {
        // Already absent — nothing to delete; surface a hint and continue.
        display::hint(&format!("Configuration {name:?} not found."));
        return Ok(());
    }
    doc.remove_config(name);
    doc.save(base_dir)?;
    display::success(&format!("Deleted configuration: {name}"));
    Ok(())
}

/// Build the [`ConfigItem`] list shown beneath the action rows. Source:
/// the inline `items` mapping at `LLMConfigEditor.ts:185-194`.
pub fn build_items(doc: &LlmsDoc) -> Vec<ConfigItem> {
    doc.config_names()
        .into_iter()
        .map(|name| {
            let detail = detail_string_for(doc, &name);
            let display_name = compose_display_name(&name, &detail);
            ConfigItem {
                name: display_name,
                value: format!("config:{name}"),
                config_name: Some(name),
            }
        })
        .collect()
}

fn detail_string_for(doc: &LlmsDoc, name: &str) -> String {
    let Some(entry) = doc.get(name) else {
        return String::new();
    };
    if entry.kind() == LlmConfigKind::Meta {
        return "(multi-modal)".to_owned();
    }
    let provider = entry.provider().unwrap_or("");
    let model = entry.model().unwrap_or("");
    format!("{provider}/{model}")
}

/// Compose `<name>  <dim detail>` with embedded ANSI dim escape codes so
/// the bespoke prompt renders the suffix dim without further wiring.
/// Matches the TS template at `:188`:
/// `name: \`${name}  ${chalk.dim(detail)}\``.
fn compose_display_name(name: &str, detail: &str) -> String {
    if detail.is_empty() {
        return name.to_owned();
    }
    let mut out = String::with_capacity(name.len() + detail.len() + 8);
    let _ = write!(out, "{name}  \x1b[2m{detail}\x1b[22m");
    out
}

/// Two action buttons. Source: `LLMConfigEditor.ts:196-200`.
pub fn action_items() -> Vec<ActionItem> {
    vec![
        ActionItem {
            name: "Add a new configuration".to_owned(),
            key: 'a',
            value: "add".to_owned(),
        },
        ActionItem {
            name: "Add a multi-modal configuration".to_owned(),
            key: 'm',
            value: "add-multi".to_owned(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::llms::{MetaConfig, MetaVariant, StandardConfig};

    fn fresh_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-llm-editor-{}-{}-{n}",
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
    fn action_items_match_ts_verbatim() {
        let actions = action_items();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].name, "Add a new configuration");
        assert_eq!(actions[0].key, 'a');
        assert_eq!(actions[0].value, "add");
        assert_eq!(actions[1].name, "Add a multi-modal configuration");
        assert_eq!(actions[1].key, 'm');
        assert_eq!(actions[1].value, "add-multi");
    }

    #[test]
    fn detail_string_renders_provider_slash_model_for_standard() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Sonnet", StandardConfig::new("anthropic", "claude-sonnet-4-6"));
        assert_eq!(detail_string_for(&doc, "Sonnet"), "anthropic/claude-sonnet-4-6");
    }

    #[test]
    fn detail_string_renders_multi_modal_for_meta() {
        let mut doc = LlmsDoc::new();
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![MetaVariant {
                    name: "fast".into(),
                    model: "Sonnet".into(),
                    keywords: None,
                    description: None,
                    system_prompt: None,
                }],
                default: "fast".into(),
            },
        );
        assert_eq!(detail_string_for(&doc, "Auto"), "(multi-modal)");
    }

    #[test]
    fn detail_string_empty_for_unknown_config() {
        let doc = LlmsDoc::new();
        assert_eq!(detail_string_for(&doc, "missing"), "");
    }

    #[test]
    fn compose_display_name_embeds_dim_codes_around_detail() {
        let s = compose_display_name("Sonnet", "anthropic/claude");
        // Two leading spaces between name and detail; ANSI dim sequences
        // wrap the detail.
        assert!(s.contains("Sonnet  "), "got: {s:?}");
        assert!(s.contains("\x1b[2manthropic/claude\x1b[22m"), "got: {s:?}");
    }

    #[test]
    fn compose_display_name_omits_dim_codes_when_detail_empty() {
        let s = compose_display_name("X", "");
        assert_eq!(s, "X");
    }

    #[test]
    fn build_items_carries_config_name_and_uses_config_value_prefix() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("A", StandardConfig::new("p", "m"));
        doc.set_standard_config("B", StandardConfig::new("p", "m2"));
        let items = build_items(&doc);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].config_name.as_deref(), Some("A"));
        assert_eq!(items[0].value, "config:A");
        assert_eq!(items[1].config_name.as_deref(), Some("B"));
        assert_eq!(items[1].value, "config:B");
    }

    #[test]
    fn build_items_preserves_disk_order() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Z", StandardConfig::new("p", "m"));
        doc.set_standard_config("A", StandardConfig::new("p", "n"));
        let items = build_items(&doc);
        let names: Vec<&str> = items
            .iter()
            .map(|i| i.config_name.as_deref().unwrap_or(""))
            .collect();
        // `LlmsDoc::config_names` preserves insertion order — Z first.
        assert_eq!(names, vec!["Z", "A"]);
    }

    #[test]
    fn route_done_returns_false() {
        let base = fresh_temp();
        assert_eq!(route(&base, "done").unwrap(), false);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn route_unknown_value_continues() {
        let base = fresh_temp();
        assert_eq!(route(&base, "garbage").unwrap(), true);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn route_add_action_continues_without_persisting_anything() {
        let base = fresh_temp();
        // `add` is documented as pending — we expect the route to return
        // continue=true and not write llms.json.
        assert!(route(&base, "add").unwrap());
        assert!(!base.join("llms.json").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn route_delete_removes_the_named_config_and_saves() {
        let base = fresh_temp();
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Sonnet", StandardConfig::new("anthropic", "x"));
        doc.set_standard_config("Opus", StandardConfig::new("anthropic", "y"));
        doc.save(&base).unwrap();

        assert!(route(&base, "delete:Sonnet").unwrap());

        let reloaded = LlmsDoc::load(&base).unwrap();
        assert!(reloaded.get("Sonnet").is_none());
        assert!(reloaded.get("Opus").is_some());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn route_delete_of_missing_config_is_noop_and_continues() {
        let base = fresh_temp();
        let doc = LlmsDoc::new();
        doc.save(&base).unwrap();
        // No "Ghost" config exists; route returns continue=true and the
        // file stays empty (or unchanged) without erroring.
        assert!(route(&base, "delete:Ghost").unwrap());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn route_config_prefix_is_silent_noop_and_continues() {
        // TS `LLMConfigEditor.ts:221-232` only handles `delete:`, `add`,
        // `addMultiModal`, and `done`. Selecting a config (Enter on a
        // config row) emits `config:<name>` which matches none of those
        // — the function falls through and the menu re-renders. Match
        // that exactly: route returns continue=true, no side effects.
        let base = fresh_temp();
        assert!(route(&base, "config:Whatever").unwrap());
        // No llms.json should be written (silent noop).
        assert!(!base.join("llms.json").exists());
        std::fs::remove_dir_all(&base).ok();
    }
}

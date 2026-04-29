//! Onboarding Screen 5 (sub-step B): role-assignment driver.
//!
//! Source: `src/commands/config/roles.ts:88-236` `runRoleAssignment`.
//!
//! Behaviours (TS lines cited inline):
//!
//! - **Zero configurations** (`:93-97`): emit
//!   `display::hint("No model configurations found. Skipping role assignment.")`
//!   followed by
//!   `display::context("Run tenex config llm to configure models first.")` and
//!   return without saving.
//! - **Exactly one configuration** (`:99-105`): set every role to that config,
//!   save `llms.json`, render `display::success(\`All roles assigned to "<n>"\`)`
//!   and return.
//! - **Two or more configurations** (`:107-235`):
//!   1. Initialize each role to its current value, falling back to
//!      `doc.default_config` (or the first config name when no default is
//!      set). `:109, :207`.
//!   2. Run [`auto_select_roles`] (`:117`) to populate role assignments
//!      from `models.dev` cost / context-window metadata.
//!   3. Build the per-config display labels (with `(multi-modal, N variants)`
//!      for meta-models and ` <ctx>K ctx · $<cost>/M in` for standard configs
//!      when `models.dev` info is available; just the bare name otherwise).
//!   4. Loop the [`role_menu_prompt`] from layer 4: on `Edit { role_key }`,
//!      open an inquire select prefilled with the current value to pick a
//!      new config. On `Done`, save and emit
//!      `display::success("Model roles saved")`. On cancellation, return
//!      [`RoleAssignmentResult::Cancelled`].

use std::fmt;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;

use crate::onboard::auto_select_roles::{auto_select_roles, ModelInfoSource};
use crate::store::llms::{LlmConfigKind, LlmsDoc};
use crate::tui::custom_prompts::{role_menu_prompt, RoleKey, RoleMenuResult, RoleMenuState, ROLES};
use crate::tui::display;
use crate::tui::prompts;

/// What the driver did.
#[derive(Debug, Clone)]
pub enum RoleAssignmentResult {
    /// Saved (or no save needed because there were 0 configs).
    Configured,
    /// User pressed Ctrl-C / Esc inside the role menu or the inner picker.
    Cancelled,
}

/// Run the role-assignment screen against `<base_dir>/llms.json`.
pub fn run(base_dir: &std::path::Path, source: &dyn ModelInfoSource) -> Result<RoleAssignmentResult> {
    let mut doc = LlmsDoc::load(base_dir)
        .with_context(|| format!("loading llms.json from {}", base_dir.display()))?;

    let config_names = doc.config_names();

    // Zero configurations: hint and return.
    if config_names.is_empty() {
        display::hint("No model configurations found. Skipping role assignment.");
        display::context("Run tenex config llm to configure models first.");
        return Ok(RoleAssignmentResult::Configured);
    }

    // Single configuration: assign every role to it, save, render summary.
    if config_names.len() == 1 {
        let only = &config_names[0];
        doc.set_default_config(Some(only.clone()));
        // Note: per `:101-103` the single-config branch only sets `default`
        // (no per-role assignments). That's faithful to the TS source.
        doc.save(base_dir)
            .with_context(|| format!("saving llms.json to {}", base_dir.display()))?;
        display::success(&format!("All roles assigned to \"{only}\""));
        return Ok(RoleAssignmentResult::Configured);
    }

    // Two-or-more path.
    let default_config = doc
        .default_config()
        .map(str::to_owned)
        .unwrap_or_else(|| config_names[0].clone());

    // Initial role assignments: existing value, or the default fallback.
    for role in ROLES {
        if get_role(&doc, role).is_none() {
            set_role(&mut doc, role, &default_config);
        }
    }

    auto_select_roles(&mut doc, source);

    // Build the picker choices once — same list reused for every edit.
    let choices = build_config_choices(&doc, source);

    loop {
        let assignments = collect_assignments(&doc, &default_config);
        let menu_state = RoleMenuState::new(assignments);
        let menu_result = role_menu_prompt("Model roles", menu_state)
            .map_err(|e| anyhow!("role menu I/O: {e}"))?;

        match menu_result {
            RoleMenuResult::Cancelled => return Ok(RoleAssignmentResult::Cancelled),
            RoleMenuResult::Done { state } => {
                apply_assignments(&mut doc, &state.assignments);
                doc.save(base_dir)
                    .with_context(|| format!("saving llms.json to {}", base_dir.display()))?;
                display::success("Model roles saved");
                return Ok(RoleAssignmentResult::Configured);
            }
            RoleMenuResult::Edit { state, role_key } => {
                apply_assignments(&mut doc, &state.assignments);

                let current = state
                    .assignments
                    .get(&role_key)
                    .cloned()
                    .unwrap_or_else(|| default_config.clone());

                let prompt_message = format!("{}:", role_key.label());
                let picked = match prompts::select(&prompt_message, choices.clone())
                    .with_starting_cursor(starting_cursor(&choices, &current))
                    .prompt()
                {
                    Ok(c) => c,
                    Err(inquire::InquireError::OperationCanceled)
                    | Err(inquire::InquireError::OperationInterrupted) => {
                        return Ok(RoleAssignmentResult::Cancelled);
                    }
                    Err(e) => return Err(anyhow!("config picker for {}: {e}", role_key.label())),
                };
                set_role(&mut doc, role_key, picked.name());
            }
        }
    }
}

/// One row in the inner config picker. `Display` renders the styled label
/// shown to the user; `name()` returns the underlying configuration name
/// to write into `llms.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChoice {
    name: String,
    label: String,
}

impl ConfigChoice {
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl fmt::Display for ConfigChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label)
    }
}

/// Build the set of choices once for the inner select. Order follows
/// `LlmsDoc::config_names()`. Source: `roles.ts:123-139`.
pub fn build_config_choices(doc: &LlmsDoc, source: &dyn ModelInfoSource) -> Vec<ConfigChoice> {
    doc.config_names()
        .iter()
        .map(|name| ConfigChoice {
            label: format_choice_label(doc, name, source),
            name: name.clone(),
        })
        .collect()
}

/// Format the picker row label for one config name.
///
/// Mirror TS `roles.ts:123-139` byte-for-byte:
/// - Meta config: `<name>  <dim>(multi-modal, N variants)</dim>`
/// - Standard with info: `<name>  <dim>parts.join(" · ")</dim>` where
///   parts = `<ctx>K ctx`, `$<cost>/M in` (filtered to non-empty).
/// - Standard without info: bare `<name>`.
///
/// The dim suffix is rendered with embedded ANSI dim codes
/// (`\x1b[2m...\x1b[22m`) so the inquire `Select` prompt renders the
/// suffix muted relative to the name.
fn format_choice_label(doc: &LlmsDoc, name: &str, source: &dyn ModelInfoSource) -> String {
    let entry = match doc.get(name) {
        Some(e) => e,
        None => return name.to_owned(),
    };

    let dim_open = crate::tui::theme::DIM_OPEN;
    let dim_close = crate::tui::theme::DIM_CLOSE;
    if entry.kind() == LlmConfigKind::Meta {
        let n_variants = entry.variant_names().len();
        // TS: `${name}  ${chalk.dim(\`(multi-modal, ${count} variants)\`)}`
        return format!(
            "{name}  {dim_open}(multi-modal, {n_variants} variants){dim_close}"
        );
    }

    let provider = entry.provider().unwrap_or("");
    let model = entry.model().unwrap_or("");
    let info = source.info(provider, model);

    let mut parts: Vec<String> = Vec::new();
    if let Some(info) = info {
        if info.context_window > 0 {
            let ctx_k = (info.context_window as f64 / 1000.0).round() as u64;
            parts.push(format!("{ctx_k}K ctx"));
        }
        // TS guard: `if (info?.cost)` — only emit when cost is set.
        // Our ModelsDevSource only constructs ModelInfo when *both*
        // cost and limit are present in the cache, so a Some(info)
        // here implies cost is set. Keep the row.
        parts.push(format!("${}/M in", strip_trailing_zero(info.input_cost)));
    }
    if parts.is_empty() {
        name.to_owned()
    } else {
        // TS: `${name}  ${chalk.dim(parts.join(" · "))}`
        format!("{name}  {dim_open}{}{dim_close}", parts.join(" · "))
    }
}

fn strip_trailing_zero(value: f64) -> String {
    let s = format!("{value}");
    if let Some(stripped) = s.strip_suffix(".0") {
        stripped.to_owned()
    } else {
        s
    }
}

fn collect_assignments(
    doc: &LlmsDoc,
    default_config: &str,
) -> IndexMap<RoleKey, String> {
    let mut out = IndexMap::new();
    for role in ROLES {
        let value = get_role(doc, role)
            .map(str::to_owned)
            .unwrap_or_else(|| default_config.to_owned());
        out.insert(role, value);
    }
    out
}

fn apply_assignments(doc: &mut LlmsDoc, assignments: &IndexMap<RoleKey, String>) {
    for (role, value) in assignments {
        set_role(doc, *role, value);
    }
}

fn get_role(doc: &LlmsDoc, role: RoleKey) -> Option<&str> {
    match role {
        RoleKey::Default => doc.default_config(),
        RoleKey::Summarization => doc.summarization(),
        RoleKey::Supervision => doc.supervision(),
        RoleKey::PromptCompilation => doc.prompt_compilation(),
        RoleKey::Categorization => doc.categorization(),
        RoleKey::ContextDiscovery => doc.context_discovery(),
    }
}

fn set_role(doc: &mut LlmsDoc, role: RoleKey, value: &str) {
    let owned = Some(value.to_owned());
    match role {
        RoleKey::Default => doc.set_default_config(owned),
        RoleKey::Summarization => doc.set_summarization(owned),
        RoleKey::Supervision => doc.set_supervision(owned),
        RoleKey::PromptCompilation => doc.set_prompt_compilation(owned),
        RoleKey::Categorization => doc.set_categorization(owned),
        RoleKey::ContextDiscovery => doc.set_context_discovery(owned),
    }
}

fn starting_cursor(choices: &[ConfigChoice], current: &str) -> usize {
    choices.iter().position(|c| c.name == current).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::onboard::auto_select_roles::{EmptyModelInfoSource, ModelInfo};
    use crate::store::llms::{MetaConfig, MetaVariant, StandardConfig};
    use std::collections::HashMap;

    struct MockSource {
        entries: HashMap<(String, String), ModelInfo>,
    }
    impl MockSource {
        fn new() -> Self {
            Self {
                entries: HashMap::new(),
            }
        }
        fn with(mut self, p: &str, m: &str, info: ModelInfo) -> Self {
            self.entries.insert((p.to_owned(), m.to_owned()), info);
            self
        }
    }
    impl ModelInfoSource for MockSource {
        fn info(&self, p: &str, m: &str) -> Option<ModelInfo> {
            self.entries.get(&(p.to_owned(), m.to_owned())).copied()
        }
    }

    fn doc_with(configs: &[(&str, &str, &str)]) -> LlmsDoc {
        let mut doc = LlmsDoc::new();
        for (n, p, m) in configs {
            doc.set_standard_config(n, StandardConfig::new(*p, *m));
        }
        doc
    }

    #[test]
    fn standard_config_without_info_renders_bare_name() {
        let doc = doc_with(&[("Sonnet", "anthropic", "claude-sonnet-4-6")]);
        let choices = build_config_choices(&doc, &EmptyModelInfoSource);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].name, "Sonnet");
        assert_eq!(choices[0].label, "Sonnet");
    }

    #[test]
    fn standard_config_with_info_renders_ctx_and_cost() {
        // TS roles.ts:138 wraps the parts.join(' · ') suffix in
        // chalk.dim — embed the dim ANSI codes inline.
        let doc = doc_with(&[("Sonnet", "anthropic", "claude-sonnet-4-6")]);
        let source = MockSource::new().with(
            "anthropic",
            "claude-sonnet-4-6",
            ModelInfo {
                input_cost: 3.0,
                context_window: 200_000,
            },
        );
        let choices = build_config_choices(&doc, &source);
        assert_eq!(
            choices[0].label,
            "Sonnet  \x1b[2m200K ctx · $3/M in\x1b[22m"
        );
    }

    #[test]
    fn standard_config_with_decimal_cost_keeps_significant_digit() {
        let doc = doc_with(&[("Haiku", "anthropic", "claude-haiku-4-5")]);
        let source = MockSource::new().with(
            "anthropic",
            "claude-haiku-4-5",
            ModelInfo {
                input_cost: 0.25,
                context_window: 200_000,
            },
        );
        let choices = build_config_choices(&doc, &source);
        assert_eq!(
            choices[0].label,
            "Haiku  \x1b[2m200K ctx · $0.25/M in\x1b[22m"
        );
    }

    #[test]
    fn meta_config_renders_variant_count_label() {
        let mut doc = LlmsDoc::new();
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![
                    MetaVariant {
                        name: "fast".into(),
                        model: "S".into(),
                        keywords: None,
                        description: None,
                        system_prompt: None,
                    },
                    MetaVariant {
                        name: "deep".into(),
                        model: "O".into(),
                        keywords: None,
                        description: None,
                        system_prompt: None,
                    },
                ],
                default: "fast".into(),
            },
        );
        let choices = build_config_choices(&doc, &EmptyModelInfoSource);
        assert_eq!(choices[0].name, "Auto");
        // TS roles.ts:127 wraps the (multi-modal, N variants) suffix
        // in chalk.dim — embed the dim ANSI codes inline.
        assert_eq!(
            choices[0].label,
            "Auto  \x1b[2m(multi-modal, 2 variants)\x1b[22m"
        );
    }

    #[test]
    fn collect_assignments_falls_back_to_default_for_unset_roles() {
        let mut doc = doc_with(&[("A", "p", "m"), ("B", "p", "n")]);
        doc.set_default_config(Some("A".into()));
        doc.set_supervision(Some("B".into()));

        let assignments = collect_assignments(&doc, "A");
        assert_eq!(assignments.get(&RoleKey::Default).map(String::as_str), Some("A"));
        assert_eq!(
            assignments.get(&RoleKey::Supervision).map(String::as_str),
            Some("B")
        );
        // Unset roles fall back to default.
        assert_eq!(
            assignments.get(&RoleKey::Categorization).map(String::as_str),
            Some("A")
        );
    }

    #[test]
    fn apply_assignments_writes_each_role() {
        let mut doc = doc_with(&[("A", "p", "m")]);
        let mut assignments: IndexMap<RoleKey, String> = IndexMap::new();
        for role in ROLES {
            assignments.insert(role, "A".to_owned());
        }
        apply_assignments(&mut doc, &assignments);
        assert_eq!(doc.default_config(), Some("A"));
        assert_eq!(doc.summarization(), Some("A"));
        assert_eq!(doc.supervision(), Some("A"));
        assert_eq!(doc.prompt_compilation(), Some("A"));
        assert_eq!(doc.categorization(), Some("A"));
        assert_eq!(doc.context_discovery(), Some("A"));
    }

    #[test]
    fn starting_cursor_finds_current_value_by_name() {
        let choices = vec![
            ConfigChoice { name: "A".into(), label: "A".into() },
            ConfigChoice { name: "B".into(), label: "B".into() },
            ConfigChoice { name: "C".into(), label: "C".into() },
        ];
        assert_eq!(starting_cursor(&choices, "B"), 1);
        assert_eq!(starting_cursor(&choices, "C"), 2);
    }

    #[test]
    fn starting_cursor_defaults_to_zero_when_current_missing() {
        let choices = vec![ConfigChoice { name: "A".into(), label: "A".into() }];
        assert_eq!(starting_cursor(&choices, "Z"), 0);
    }

    #[test]
    fn run_with_zero_configs_returns_configured_without_saving() {
        let tmp = std::env::temp_dir().join(format!(
            "tenex-roles-zero-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let outcome = run(&tmp, &EmptyModelInfoSource).unwrap();
        assert!(matches!(outcome, RoleAssignmentResult::Configured));
        // No llms.json should have been written.
        assert!(!tmp.join("llms.json").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn run_with_single_config_assigns_default_and_saves() {
        let tmp = std::env::temp_dir().join(format!(
            "tenex-roles-one-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // Pre-populate llms.json with one config.
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Only", StandardConfig::new("anthropic", "x"));
        doc.save(&tmp).unwrap();

        let outcome = run(&tmp, &EmptyModelInfoSource).unwrap();
        assert!(matches!(outcome, RoleAssignmentResult::Configured));

        let reloaded = LlmsDoc::load(&tmp).unwrap();
        assert_eq!(reloaded.default_config(), Some("Only"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn strip_trailing_zero_normalises_floats() {
        assert_eq!(strip_trailing_zero(3.0), "3");
        assert_eq!(strip_trailing_zero(15.0), "15");
        assert_eq!(strip_trailing_zero(0.25), "0.25");
        assert_eq!(strip_trailing_zero(1.5), "1.5");
    }
}

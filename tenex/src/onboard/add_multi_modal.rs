//! Adds a multi-modal (meta) LLM configuration interactively.
//!
//! Source: `src/llm/utils/ConfigurationManager.ts:159-204` (outer driver) +
//! `src/llm/utils/variant-list-prompt.ts:263-362` (add/edit helpers).
//!
//! Flow:
//! 1. Check ≥ 2 standard configs exist; if not, hint and return.
//! 2. Display header + prompt configuration name.
//! 3. Immediately call `add_variant` for the first variant (TS does not
//!    show the empty-list state to the user — `:325`).
//! 4. Loop: show variant list prompt → handle Add / Edit / Done.
//! 5. On Done: persist to `llms.json` and print success.

use std::path::Path;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use inquire::InquireError;

use crate::onboard::add_configuration::{config_name_validation, standard_config_names};
use crate::store::llms::{LlmsDoc, MetaConfig, MetaVariant};
use crate::tui::custom_prompts::variant_list_prompt::{
    run as variant_list_run, MetaVariantData, VariantListState, VariantOutcome,
};
use crate::tui::{display, prompts};

/// Add a new variant to `state` via inquire prompts.
///
/// Returns `true` when the variant was added, `false` when the user
/// cancelled at any step (the state is left unchanged).
///
/// Source: `variant-list-prompt.ts:263-309`.
fn add_variant(state: &mut VariantListState, standard_configs: &[String]) -> Result<bool> {
    let existing_names: Vec<String> = state.variants.keys().cloned().collect();
    let is_first = existing_names.is_empty();

    let name = {
        let existing = existing_names.clone();
        match prompts::input("Variant name:")
            .with_validator(move |input: &str| {
                if input.trim().is_empty() {
                    return Ok(inquire::validator::Validation::Invalid(
                        "Name is required".into(),
                    ));
                }
                if existing.contains(&input.to_owned()) {
                    return Ok(inquire::validator::Validation::Invalid(
                        "Variant already exists".into(),
                    ));
                }
                Ok(inquire::validator::Validation::Valid)
            })
            .prompt()
        {
            Ok(n) => n,
            Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                return Ok(false);
            }
            Err(e) => return Err(anyhow!("variant name prompt: {e}")),
        }
    };

    let model = match prompts::select("Select model for this variant:", standard_configs.to_vec())
        .prompt()
    {
        Ok(m) => m,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(false);
        }
        Err(e) => return Err(anyhow!("model select: {e}")),
    };

    // For non-first variants: ask "When to use this variant" (`:298-308`).
    let description = if !is_first {
        match prompts::input("When to use this variant:").prompt() {
            Ok(d) => {
                if d.trim().is_empty() {
                    None
                } else {
                    Some(d)
                }
            }
            Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                return Ok(false);
            }
            Err(e) => return Err(anyhow!("description prompt: {e}")),
        }
    } else {
        None
    };

    state.variants.insert(
        name.clone(),
        MetaVariantData {
            model,
            keywords: vec![],
            description,
            system_prompt: None,
        },
    );

    // First variant auto-becomes default (`:293`).
    if is_first {
        state.default_variant = name;
    }

    Ok(true)
}

/// Edit individual fields of an existing variant via a field-select loop.
///
/// Source: `variant-list-prompt.ts:160-261`.
fn edit_variant_detail(
    variant_name: &str,
    state: &mut VariantListState,
    standard_configs: &[String],
) -> Result<()> {
    loop {
        let Some(variant) = state.variants.get(variant_name) else {
            return Ok(());
        };
        let is_default = variant_name == state.default_variant;
        let default_tag = if is_default { " (default)" } else { "" };

        display::blank();
        display::context(&format!(
            "Variant: {} → {}{}",
            variant_name, variant.model, default_tag
        ));
        display::blank();

        let dim = |s: &str| crate::tui::theme::chalk_dim(s);
        let model_display = variant.model.clone();
        let keywords_display = if variant.keywords.is_empty() {
            "(none)".to_owned()
        } else {
            variant.keywords.join(", ")
        };
        let desc_display = variant
            .description
            .as_deref()
            .unwrap_or("(none)")
            .to_owned();
        let sys_display = variant
            .system_prompt
            .as_deref()
            .unwrap_or("(none)")
            .to_owned();

        let model_label = format!("Model              {}", dim(&model_display));
        let keywords_label = format!("Trigger keyword    {}", dim(&keywords_display));
        let desc_label = format!("When to use        {}", dim(&desc_display));
        let sys_label = format!("Behavior when active  {}", dim(&sys_display));
        let back_label = "Back".to_owned();

        let field = match prompts::select(
            &format!("Edit {variant_name}:"),
            vec![
                model_label.clone(),
                keywords_label.clone(),
                desc_label.clone(),
                sys_label.clone(),
                back_label.clone(),
            ],
        )
        .prompt()
        {
            Ok(f) => f,
            Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                return Ok(());
            }
            Err(e) => return Err(anyhow!("field select: {e}")),
        };

        if field == back_label {
            return Ok(());
        }

        if field == model_label {
            let model = match prompts::select("Select model:", standard_configs.to_vec()).prompt() {
                Ok(m) => m,
                Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                    continue;
                }
                Err(e) => return Err(anyhow!("model select: {e}")),
            };
            if let Some(v) = state.variants.get_mut(variant_name) {
                v.model = model;
            }
        } else if field == keywords_label {
            let current = state
                .variants
                .get(variant_name)
                .map(|v| v.keywords.join(", "))
                .unwrap_or_default();
            let input = match prompts::input("Trigger keywords (comma-separated):")
                .with_default(&current)
                .prompt()
            {
                Ok(i) => i,
                Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                    continue;
                }
                Err(e) => return Err(anyhow!("keywords input: {e}")),
            };
            let keywords: Vec<String> = if input.trim().is_empty() {
                vec![]
            } else {
                input
                    .split(',')
                    .map(|k| k.trim().to_lowercase())
                    .filter(|k| !k.is_empty())
                    .collect()
            };
            if let Some(v) = state.variants.get_mut(variant_name) {
                v.keywords = keywords;
            }
        } else if field == desc_label {
            let current = state
                .variants
                .get(variant_name)
                .and_then(|v| v.description.clone())
                .unwrap_or_default();
            let input = match prompts::input("When to use this variant:")
                .with_default(&current)
                .prompt()
            {
                Ok(i) => i,
                Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                    continue;
                }
                Err(e) => return Err(anyhow!("description input: {e}")),
            };
            if let Some(v) = state.variants.get_mut(variant_name) {
                v.description = if input.trim().is_empty() {
                    None
                } else {
                    Some(input)
                };
            }
        } else if field == sys_label {
            let current = state
                .variants
                .get(variant_name)
                .and_then(|v| v.system_prompt.clone())
                .unwrap_or_default();
            let input = match prompts::input("Behavior when active:")
                .with_default(&current)
                .prompt()
            {
                Ok(i) => i,
                Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                    continue;
                }
                Err(e) => return Err(anyhow!("system prompt input: {e}")),
            };
            if let Some(v) = state.variants.get_mut(variant_name) {
                v.system_prompt = if input.trim().is_empty() {
                    None
                } else {
                    Some(input)
                };
            }
        }
    }
}

/// Inner variant-list loop shared by `run` and `edit`.
///
/// Drives the add/edit/done cycle for `state` under `meta_name`. Returns
/// `Some(MetaConfig)` when the user commits (Done), `None` on cancel.
fn run_variant_loop(
    state: &mut VariantListState,
    meta_name: &str,
    standard_configs: &[String],
) -> Result<Option<MetaConfig>> {
    loop {
        let outcome = variant_list_run(state, meta_name)
            .map_err(|e| anyhow!("variant list prompt: {e}"))?;

        match outcome {
            VariantOutcome::Continue => unreachable!("run() never returns Continue"),
            VariantOutcome::Cancel => return Ok(None),
            VariantOutcome::Add => {
                add_variant(state, standard_configs)?;
            }
            VariantOutcome::Edit { variant_name } => {
                edit_variant_detail(&variant_name, state, standard_configs)?;
            }
            VariantOutcome::Done => {
                let variants: Vec<MetaVariant> = state
                    .variants
                    .iter()
                    .map(|(name, v)| MetaVariant {
                        name: name.clone(),
                        model: v.model.clone(),
                        keywords: if v.keywords.is_empty() {
                            None
                        } else {
                            Some(v.keywords.clone())
                        },
                        description: v.description.clone(),
                        system_prompt: v.system_prompt.clone(),
                    })
                    .collect();
                return Ok(Some(MetaConfig {
                    variants,
                    default: state.default_variant.clone(),
                }));
            }
        }
    }
}

/// Run the multi-modal configuration wizard against `<base_dir>/llms.json`.
///
/// Returns `Ok(())` on success or user cancellation. Source:
/// `ConfigurationManager.ts:159-204`.
pub fn run(base_dir: &Path) -> Result<()> {
    let doc = LlmsDoc::load(base_dir)?;
    let standard_configs = standard_config_names(&doc);

    if standard_configs.len() < 2 {
        display::hint(
            "You need at least 2 standard LLM configurations to create a multi-modal \
             configuration.",
        );
        display::context("Create more configurations first with 'Add new configuration'.");
        return Ok(());
    }

    display::blank();
    display::step(0, 0, "Add Multi-Modal Configuration");
    display::context(
        "Multi-modal configurations let you switch between different models using \
         keywords.\nFor example, starting a message with 'ultrathink' can trigger a \
         more powerful model.",
    );
    display::blank();

    let existing_names = doc.config_names();
    let meta_name = match prompts::input("Multi-modal configuration name:")
        .with_validator(move |input: &str| Ok(config_name_validation(input, &existing_names)))
        .prompt()
    {
        Ok(n) => n,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("name prompt: {e}")),
    };

    let mut state = VariantListState::new(IndexMap::new(), String::new());

    // Add first variant immediately — TS never shows the empty list (`:325`).
    if !add_variant(&mut state, &standard_configs)? {
        return Ok(());
    }

    if let Some(config) = run_variant_loop(&mut state, &meta_name, &standard_configs)? {
        let variant_count = config.variants.len();
        let mut doc = LlmsDoc::load(base_dir)?;
        doc.set_meta_config(&meta_name, config);
        if doc.default_config().is_none() {
            doc.set_default_config(Some(meta_name.clone()));
        }
        doc.save(base_dir)?;
        display::blank();
        display::success(&format!(
            "Multi-modal configuration \"{meta_name}\" created with {variant_count} variants"
        ));
    }
    Ok(())
}

/// Edit an existing meta-model configuration in `<base_dir>/llms.json`.
///
/// Loads the named config's current variants into a `VariantListState` and
/// runs the variant-list loop. On Done the config is overwritten in place;
/// on Cancel the disk state is left unchanged.
pub fn edit(base_dir: &Path, meta_name: &str) -> Result<()> {
    let doc = LlmsDoc::load(base_dir)?;
    let standard_configs = standard_config_names(&doc);

    let entry = match doc.get(meta_name) {
        Some(e) => e,
        None => return Ok(()),
    };

    let default_variant = entry.meta_default_variant().unwrap_or("").to_owned();
    let mut variants: IndexMap<String, crate::tui::custom_prompts::variant_list_prompt::MetaVariantData> = IndexMap::new();
    for name in entry.variant_names() {
        if let Some(v) = entry.variant(&name) {
            variants.insert(
                name,
                crate::tui::custom_prompts::variant_list_prompt::MetaVariantData {
                    model: v.model().unwrap_or("").to_owned(),
                    keywords: v.keywords(),
                    description: v.description().map(str::to_owned),
                    system_prompt: v.system_prompt().map(str::to_owned),
                },
            );
        }
    }

    let mut state = VariantListState::new(variants, default_variant);

    display::blank();
    display::step(0, 0, &format!("Edit Multi-Modal Configuration: {meta_name}"));
    display::blank();

    if let Some(config) = run_variant_loop(&mut state, meta_name, &standard_configs)? {
        let variant_count = config.variants.len();
        let mut doc = LlmsDoc::load(base_dir)?;
        doc.set_meta_config(meta_name, config);
        doc.save(base_dir)?;
        display::blank();
        display::success(&format!(
            "Multi-modal configuration \"{meta_name}\" updated with {variant_count} variants"
        ));
    }
    Ok(())
}

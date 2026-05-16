//! Interactive wizard for adding an ACP backend configuration to `llms.json`.
//!
//! ACP (Agent Capability Protocol) runs agent backends as external processes
//! via stdin/stdout. This wizard is Rust-only — the TypeScript LLMConfigEditor
//! predates ACP and has no equivalent flow.
//!
//! Wizard steps:
//! 1. Config name (unique, non-empty)
//! 2. Backend selection (claude-code / codex / custom)
//! 3. Command (executable, pre-filled per backend)
//! 4. Arguments (comma-separated, pre-filled per backend)
//! 5. Model ID (optional)
//! 6. Permission policy (allow / deny)

use anyhow::{anyhow, Result};
use inquire::InquireError;

use crate::store::llms::{AcpConfig, LlmsDoc};
use crate::tui::display;
use crate::tui::prompts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcpBackend {
    ClaudeCode,
    Codex,
    Custom,
}

impl std::fmt::Display for AcpBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcpBackend::ClaudeCode => write!(f, "claude-code"),
            AcpBackend::Codex => write!(f, "codex"),
            AcpBackend::Custom => write!(f, "custom"),
        }
    }
}

/// Run the ACP backend configuration wizard.
/// Returns the name of the newly-created configuration on success, or `None`
/// if the user cancelled at any step.
pub fn run(base_dir: &std::path::Path) -> Result<Option<String>> {
    let doc = LlmsDoc::load(base_dir)?;
    let existing = doc.config_names();

    // Step 1: Config name — must be unique and non-empty.
    let name = {
        let existing = existing.clone();
        match prompts::input("Configuration name")
            .with_help_message("e.g. \"claude code acp\" — must be unique in llms.json")
            .with_validator(move |input: &str| {
                if input.trim().is_empty() {
                    return Ok(inquire::validator::Validation::Invalid(
                        "Name cannot be empty".into(),
                    ));
                }
                if existing.contains(&input.to_owned()) {
                    return Ok(inquire::validator::Validation::Invalid(
                        format!("A configuration named \"{input}\" already exists").into(),
                    ));
                }
                Ok(inquire::validator::Validation::Valid)
            })
            .prompt()
        {
            Ok(n) => n,
            Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                return Ok(None)
            }
            Err(e) => return Err(anyhow!("name prompt: {e}")),
        }
    };

    // Step 2: Backend.
    let backend = match prompts::select(
        "Backend",
        vec![
            AcpBackend::ClaudeCode,
            AcpBackend::Codex,
            AcpBackend::Custom,
        ],
    )
    .prompt()
    {
        Ok(b) => b,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("backend prompt: {e}")),
    };

    // Pre-fill command and args based on backend.
    let default_command = match backend {
        AcpBackend::ClaudeCode | AcpBackend::Codex => "npx",
        AcpBackend::Custom => "",
    };
    let default_args = match backend {
        AcpBackend::ClaudeCode => "-y,@agentclientprotocol/claude-agent-acp@latest",
        AcpBackend::Codex => "-y,@agentclientprotocol/codex-acp@latest",
        AcpBackend::Custom => "",
    };

    // Step 3: Command.
    let command = match if default_command.is_empty() {
        prompts::input("Command (executable to run)")
            .with_help_message("e.g. npx, node, /path/to/binary")
            .prompt()
    } else {
        prompts::input("Command (executable to run)")
            .with_help_message("e.g. npx, node, /path/to/binary")
            .with_default(default_command)
            .prompt()
    } {
        Ok(c) => c,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("command prompt: {e}")),
    };

    // Step 4: Arguments (comma-separated).
    let args_str = match if default_args.is_empty() {
        prompts::input("Arguments (comma-separated, optional)")
            .with_help_message("e.g. -y,@agentclientprotocol/claude-agent-acp@latest")
            .prompt_skippable()
    } else {
        prompts::input("Arguments (comma-separated, optional)")
            .with_help_message("e.g. -y,@agentclientprotocol/claude-agent-acp@latest")
            .with_default(default_args)
            .prompt_skippable()
    } {
        Ok(a) => a,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("args prompt: {e}")),
    };

    let args: Vec<String> = args_str
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();

    // Step 5: Model ID (optional). Each backend has a canonical list of
    // model IDs it accepts:
    //   - claude-code: the 3 aliases (sonnet / opus / haiku) the ACP
    //     package resolves to real Claude versions.
    //   - codex / custom: no static list — fall back to models.dev for
    //     codex (when cached) or freeform text input otherwise.
    // In every case the user may skip — model is optional and the backend
    // then uses its own default.
    let model = match select_acp_model(backend, base_dir)? {
        Some(m) => m,
        None => return Ok(None),
    };

    // Step 6: Permission policy.
    let policy = match prompts::select("Permission policy", vec!["allow", "deny"]).prompt() {
        Ok(p) => p.to_owned(),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("permission policy prompt: {e}")),
    };

    // Persist.
    let config = AcpConfig {
        backend: backend.to_string(),
        command,
        args,
        env: std::collections::HashMap::new(),
        model,
        permission_policy: Some(policy),
    };

    let mut doc = LlmsDoc::load(base_dir)?;
    doc.set_acp_config(&name, config);
    doc.save(base_dir)?;

    display::success(&format!("ACP configuration \"{name}\" saved"));
    Ok(Some(name))
}

/// Outer `Option`: `None` = user cancelled the wizard.
/// Inner `Option`: `None` = user skipped (no model set).
fn select_acp_model(
    backend: AcpBackend,
    base_dir: &std::path::Path,
) -> Result<Option<Option<String>>> {
    match backend {
        AcpBackend::ClaudeCode => select_claude_code_acp_model(),
        AcpBackend::Codex => select_codex_acp_model(base_dir),
        AcpBackend::Custom => acp_model_text_input(),
    }
}

/// Picker over the 3 Claude Code aliases. Includes a synthetic skip row.
fn select_claude_code_acp_model() -> Result<Option<Option<String>>> {
    use crate::onboard::claude_code_models::CLAUDE_CODE_MODELS;

    let mut choices: Vec<AcpModelChoice> = Vec::with_capacity(CLAUDE_CODE_MODELS.len() + 1);
    choices.push(AcpModelChoice {
        id: None,
        label: format!(
            "(skip {})",
            crate::tui::theme::chalk_dim("— use backend default"),
        ),
    });
    for m in CLAUDE_CODE_MODELS {
        choices.push(AcpModelChoice {
            id: Some(m.id.to_owned()),
            label: format!(
                "{} {} {}",
                m.display_name,
                crate::tui::theme::chalk_dim(&format!("({})", m.id)),
                crate::tui::theme::chalk_dim(&format!("— {}", m.description)),
            ),
        });
    }

    match prompts::select("Select model:", choices).prompt() {
        Ok(c) => Ok(Some(c.id)),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model select: {e}")),
    }
}

/// Codex ACP has no static list yet (TS uses live CLI IPC). When the
/// models.dev cache is populated for `openai`, use it as a picker;
/// otherwise fall back to freeform input.
fn select_codex_acp_model(base_dir: &std::path::Path) -> Result<Option<Option<String>>> {
    use crate::store::models_dev;

    let cache_opt = models_dev::load_from_disk(base_dir).ok().flatten();
    if let Some(cache) = cache_opt {
        let models = models_dev::get_provider_models(&cache.data, "openai");
        if !models.is_empty() {
            return select_from_models_dev(models);
        }
    }
    acp_model_text_input()
}

fn acp_model_text_input() -> Result<Option<Option<String>>> {
    match prompts::input("Model ID (press Enter to skip)")
        .with_help_message("e.g. claude-haiku-4-5-20251001 or gpt-5.4")
        .prompt_skippable()
    {
        Ok(m) => Ok(Some(m.filter(|s| !s.trim().is_empty()))),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model prompt: {e}")),
    }
}

/// Picker entry. The synthetic skip row stores `id = None`; real models
/// store their full ID.
struct AcpModelChoice {
    id: Option<String>,
    label: String,
}

impl std::fmt::Display for AcpModelChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn select_from_models_dev(
    models: Vec<crate::store::models_dev::ModelsDevModel>,
) -> Result<Option<Option<String>>> {
    use crate::store::models_dev;

    let mut choices: Vec<AcpModelChoice> = Vec::with_capacity(models.len() + 1);
    choices.push(AcpModelChoice {
        id: None,
        label: format!(
            "(skip {})",
            crate::tui::theme::chalk_dim("— use backend default"),
        ),
    });
    for m in &models {
        let (name, id_seg, meta_seg) = models_dev::picker_label_segments(m);
        choices.push(AcpModelChoice {
            id: Some(m.id.clone()),
            label: format!(
                "{} {} {}",
                name,
                crate::tui::theme::chalk_dim(&id_seg),
                crate::tui::theme::chalk_dim(&meta_seg),
            )
            .trim()
            .to_owned(),
        });
    }

    match prompts::select("Select model:", choices).prompt() {
        Ok(c) => Ok(Some(c.id)),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model select: {e}")),
    }
}

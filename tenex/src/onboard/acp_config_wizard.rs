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

    // Step 5: Model ID (optional).
    let model = match prompts::input("Model ID (press Enter to skip)")
        .with_help_message("e.g. claude-haiku-4-5-20251001 or gpt-5.4")
        .prompt_skippable()
    {
        Ok(m) => m.filter(|s| !s.trim().is_empty()),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("model prompt: {e}")),
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

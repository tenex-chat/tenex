//! `tenex config escalation` — agent slug routed for `ask()` calls.
//!
//! Source: `src/commands/config/escalation.ts:7-39`. Single-shot.
//! Renders the current agent (or `"not configured"`), accepts a new
//! slug from input (empty → clear the field), persists, success line.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let current = doc
        .escalation_agent()
        .unwrap_or_else(|| "not configured".to_owned());
    println!(
        "  Current escalation agent: {}\n",
        crate::tui::theme::chalk_dim(&current),
    );

    let default = doc.escalation_agent().unwrap_or_default();
    match select_escalation_agent(base_dir, &default)? {
        EscalationPick::Cancelled => return Ok(()),
        EscalationPick::Disable => doc.set_escalation_agent(None),
        EscalationPick::Slug(s) => doc.set_escalation_agent(Some(&s)),
    }
    doc.save(base_dir)?;
    crate::tui::display::config_success("Escalation config saved.");
    Ok(())
}

/// Result of the escalation agent prompt. `Cancelled` means the user
/// hit Esc/Ctrl-C — leave the existing config untouched. `Disable`
/// means the user picked the synthetic disable row (or, in the
/// fallback text input, submitted an empty string). `Slug` carries
/// the chosen agent slug.
enum EscalationPick {
    Cancelled,
    Disable,
    Slug(String),
}

/// Render the agent picker for escalation. When the global agent index
/// is non-empty we render a `Select` with a synthetic disable row at
/// the top followed by every known slug; otherwise we fall back to a
/// freeform text input where an empty submission disables the field
/// (the historic behaviour).
fn select_escalation_agent(base_dir: &std::path::Path, default: &str) -> Result<EscalationPick> {
    let slugs: Vec<String> = match tenex_agent_registry::AgentIndexDoc::load(base_dir) {
        Ok(idx) => idx.by_slug().keys().cloned().collect(),
        Err(_) => Vec::new(),
    };

    if slugs.is_empty() {
        let raw = match prompts::input("Agent slug (empty to disable):")
            .with_default(default)
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => {
                return Ok(EscalationPick::Cancelled);
            }
            Err(e) => return Err(anyhow!("escalation agent prompt: {e}")),
        };
        let trimmed = raw.trim();
        return Ok(if trimmed.is_empty() {
            EscalationPick::Disable
        } else {
            EscalationPick::Slug(trimmed.to_owned())
        });
    }

    let mut choices: Vec<String> = Vec::with_capacity(slugs.len() + 1);
    choices.push("(disable escalation)".to_owned());
    choices.extend(slugs);
    let starting = choices.iter().position(|s| s == default).unwrap_or(0);

    let picked = match prompts::select("Escalation agent:", choices.clone())
        .with_starting_cursor(starting)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => {
            return Ok(EscalationPick::Cancelled);
        }
        Err(e) => return Err(anyhow!("escalation agent select: {e}")),
    };
    Ok(if picked == "(disable escalation)" {
        EscalationPick::Disable
    } else {
        EscalationPick::Slug(picked)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-escalation-{}-{}-{n}",
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
    fn set_agent_persists_object_with_agent_field() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_escalation_agent(Some("triage"));
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.escalation_agent().as_deref(), Some("triage"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_agent_none_clears_existing_block() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_escalation_agent(Some("triage"));
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_escalation_agent(None);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert!(reloaded.escalation_agent().is_none());
        // The whole "escalation" key should be absent (TS sets to undefined).
        let written = std::fs::read_to_string(base.join("config.json")).unwrap();
        assert!(!written.contains("escalation"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_agent_empty_string_clears_via_helper() {
        // `set_escalation_agent(Some(""))` is treated as None per the
        // TS branch at `:25-29` ("agent.trim() === ''" → undefined).
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_escalation_agent(Some("triage"));
        doc.set_escalation_agent(Some(""));
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert!(reloaded.escalation_agent().is_none());
        std::fs::remove_dir_all(&base).ok();
    }
}

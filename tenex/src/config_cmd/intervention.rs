//! `tenex config intervention` — auto-review when you're idle.
//!
//! Source: `src/commands/config/intervention.ts:7-66`. Single-shot.
//! Renders the current `enabled`, `agent`, `timeoutSeconds`, asks
//! `Enable intervention?` (confirm), and on enable collects an agent
//! slug + an integer timeout. On disable, preserves the existing
//! `agent` / `timeoutSeconds` and only flips `enabled = false` (matches
//! the spread-then-set at `:52-55`).

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

const DEFAULT_TIMEOUT_SECONDS: u64 = 300;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;

    let prev_enabled = doc.intervention_enabled().unwrap_or(false);
    let prev_agent = doc.intervention_agent();
    let prev_timeout = doc
        .intervention_timeout_seconds()
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

    println!("  Enabled: {prev_enabled}");
    if let Some(a) = &prev_agent {
        println!("  Agent: {a}");
    }
    println!("  Review timeout: {prev_timeout}s\n");

    let enabled = match prompts::confirm("Enable intervention?")
        .with_default(prev_enabled)
        .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("intervention enable prompt: {e}")),
    };

    if enabled {
        let agent_default = prev_agent.clone().unwrap_or_default();
        let agent_raw = match prompts::input("Agent slug:")
            .with_default(&agent_default)
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("intervention agent prompt: {e}")),
        };
        let validator = prompts::adapt_static_str_validator(
            crate::config_cmd::summarization::validate_integer,
        );
        let timeout_raw = match prompts::input("Review timeout (seconds):")
            .with_default(&prev_timeout.to_string())
            .with_validator(validator)
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("intervention timeout prompt: {e}")),
        };
        let timeout: u64 = timeout_raw
            .trim()
            .parse()
            .map_err(|e| anyhow!("invariant violated post-validation: {e}"))?;

        let agent_trimmed = agent_raw.trim();
        let agent_opt = if agent_trimmed.is_empty() {
            None
        } else {
            Some(agent_trimmed)
        };
        doc.set_intervention(true, agent_opt, Some(timeout));
    } else {
        // Disable — preserve previous agent + timeoutSeconds (TS spread).
        doc.set_intervention(false, prev_agent.as_deref(), Some(prev_timeout));
    }

    doc.save(base_dir)?;
    crate::tui::display::config_success("Intervention config saved.");
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-intervention-{}-{}-{n}",
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
    fn default_timeout_is_300_seconds() {
        // Source: `:17, :40` `?? 300`.
        assert_eq!(DEFAULT_TIMEOUT_SECONDS, 300);
    }

    #[test]
    fn enable_persists_full_block() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_intervention(true, Some("triage"), Some(120));
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.intervention_enabled(), Some(true));
        assert_eq!(r.intervention_agent().as_deref(), Some("triage"));
        assert_eq!(r.intervention_timeout_seconds(), Some(120));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enable_with_empty_agent_omits_field() {
        // Per `:48` `agent: answers.agent || undefined`.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_intervention(true, Some(""), Some(60));
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.intervention_enabled(), Some(true));
        assert!(r.intervention_agent().is_none());
        assert_eq!(r.intervention_timeout_seconds(), Some(60));
        let written = std::fs::read_to_string(base.join("config.json")).unwrap();
        // The "agent" field should be absent in the written JSON.
        let intervention_obj_start = written.find("\"intervention\"").unwrap();
        let block = &written[intervention_obj_start..];
        let block_end = block.find("}\n").unwrap_or(block.len());
        let block = &block[..block_end];
        assert!(!block.contains("\"agent\""), "agent leaked: {block}");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn disable_preserves_agent_and_timeout_via_spread_shape() {
        // Per `:52-55` — disabling preserves the existing agent +
        // timeoutSeconds, only flipping `enabled` to false.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_intervention(true, Some("triage"), Some(120));
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        let prev_agent = doc.intervention_agent();
        let prev_timeout = doc
            .intervention_timeout_seconds()
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);
        doc.set_intervention(false, prev_agent.as_deref(), Some(prev_timeout));
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.intervention_enabled(), Some(false));
        assert_eq!(r.intervention_agent().as_deref(), Some("triage"));
        assert_eq!(r.intervention_timeout_seconds(), Some(120));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_intervention_replaces_block() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_intervention(true, Some("a1"), Some(60));
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_intervention(true, Some("a2"), Some(900));
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.intervention_agent().as_deref(), Some("a2"));
        assert_eq!(r.intervention_timeout_seconds(), Some(900));
        std::fs::remove_dir_all(&base).ok();
    }
}

//! `tenex config summarization` — auto-summary inactivity timeout.
//!
//! Source: `src/commands/config/summarization.ts:7-39`. Single-shot.
//! Renders the current timeout in seconds and minutes, accepts an integer
//! number of seconds, persists, success line. Default 300 seconds (5 min).

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

const DEFAULT_TIMEOUT_SECONDS: u64 = 300;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let current = doc
        .summarization_inactivity_timeout_seconds()
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    let minutes = (current as f64 / 60.0).round() as u64;
    println!("  Inactivity timeout: {current}s ({minutes}min)\n");

    let validator = prompts::adapt_static_str_validator(validate_integer);
    let raw = match prompts::input("Inactivity timeout (seconds):")
        .with_default(&current.to_string())
        .with_validator(validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("summarization timeout prompt: {e}")),
    };
    let parsed: u64 = raw
        .trim()
        .parse()
        .map_err(|e| anyhow!("invariant violated post-validation: {e}"))?;

    doc.set_summarization_inactivity_timeout_seconds(parsed);
    doc.save(base_dir)?;
    print_success_line("Summarization config saved.");
    Ok(())
}

/// Match the TS regex `/^\d+$/` exactly. Source: `summarization.ts:24`.
pub fn validate_integer(input: &str) -> Result<(), &'static str> {
    if !input.is_empty() && input.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("Must be a number")
    }
}

fn print_success_line(text: &str) {
    let check = console::Style::new().green().apply_to("✓");
    let bold_text = console::Style::new().bold().apply_to(format!(" {text}"));
    println!("{check}{bold_text}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-summarization-{}-{}-{n}",
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
        // Source: `:14` `?? 300`.
        assert_eq!(DEFAULT_TIMEOUT_SECONDS, 300);
    }

    #[test]
    fn validate_integer_accepts_pure_digits() {
        assert!(validate_integer("0").is_ok());
        assert!(validate_integer("42").is_ok());
        assert!(validate_integer("300").is_ok());
        assert!(validate_integer("999999999").is_ok());
    }

    #[test]
    fn validate_integer_rejects_empty_with_verbatim_message() {
        assert_eq!(validate_integer(""), Err("Must be a number"));
    }

    #[test]
    fn validate_integer_rejects_signed_numbers() {
        // The TS regex doesn't accept `-` or `+`.
        assert_eq!(validate_integer("-1"), Err("Must be a number"));
        assert_eq!(validate_integer("+5"), Err("Must be a number"));
    }

    #[test]
    fn validate_integer_rejects_decimals_and_whitespace_and_garbage() {
        assert_eq!(validate_integer("3.5"), Err("Must be a number"));
        assert_eq!(validate_integer("3 "), Err("Must be a number"));
        assert_eq!(validate_integer("  3"), Err("Must be a number"));
        assert_eq!(validate_integer("abc"), Err("Must be a number"));
    }

    #[test]
    fn set_timeout_persists_object_with_inactivity_field() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_summarization_inactivity_timeout_seconds(120);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(
            reloaded.summarization_inactivity_timeout_seconds(),
            Some(120)
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_timeout_replaces_existing_block() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_summarization_inactivity_timeout_seconds(60);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_summarization_inactivity_timeout_seconds(900);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(
            reloaded.summarization_inactivity_timeout_seconds(),
            Some(900)
        );
        std::fs::remove_dir_all(&base).ok();
    }
}

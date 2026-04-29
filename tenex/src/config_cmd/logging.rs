//! `tenex config logging` — set log level + log-file path.
//!
//! Source: `src/commands/config/logging.ts:9-50`. Single-shot, no menu loop.
//! Renders the current level/file, asks for a new level, asks for a new
//! file path (empty → undefined), persists, success line.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

const LOG_LEVELS: &[&str] = &["silent", "error", "warn", "info", "debug"];

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let current_level = doc.logging_level().unwrap_or_else(|| "info".to_owned());
    let current_log_file = doc.logging_log_file().unwrap_or_default();

    println!("  Level: {current_level}");
    println!(
        "  Log file: {}\n",
        if current_log_file.is_empty() {
            "(stdout)".to_owned()
        } else {
            current_log_file.clone()
        }
    );

    let level_choices: Vec<String> = LOG_LEVELS.iter().map(|s| (*s).to_owned()).collect();
    let starting_level = level_choices
        .iter()
        .position(|l| l == &current_level)
        .unwrap_or_else(|| LOG_LEVELS.iter().position(|s| *s == "info").unwrap_or(0));

    let level = match prompts::select("Log level:", level_choices)
        .with_starting_cursor(starting_level)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("log level prompt: {e}")),
    };

    let log_file_raw = match prompts::input("Log file path (empty for stdout):")
        .with_default(&current_log_file)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("log file prompt: {e}")),
    };
    let log_file_trimmed = log_file_raw.trim();
    let log_file_opt = if log_file_trimmed.is_empty() {
        None
    } else {
        Some(log_file_trimmed)
    };

    doc.set_logging(&level, log_file_opt);
    doc.save(base_dir)?;
    crate::tui::display::config_success("Logging config saved.");
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
            "tenex-config-logging-{}-{}-{n}",
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
    fn log_levels_pinned_to_ts_array_in_order() {
        // Source: `logging.ts:7` `LOG_LEVELS = [...] as const`.
        assert_eq!(
            LOG_LEVELS,
            &["silent", "error", "warn", "info", "debug"],
        );
    }

    #[test]
    fn set_logging_with_level_only_persists_block_with_no_log_file_field() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_logging("debug", None);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.logging_level().as_deref(), Some("debug"));
        assert!(reloaded.logging_log_file().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_logging_with_log_file_persists_both_fields() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_logging("warn", Some("/tmp/tenex.log"));
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.logging_level().as_deref(), Some("warn"));
        assert_eq!(reloaded.logging_log_file().as_deref(), Some("/tmp/tenex.log"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_logging_with_empty_string_log_file_omits_the_field() {
        // TS uses `logFile.trim() || undefined` (`logging.ts:39`); empty
        // input maps to absent field, matching that.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_logging("info", Some(""));
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert!(reloaded.logging_log_file().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn set_logging_replaces_existing_block_completely() {
        // Existing logging block with both fields → set_logging with no
        // logFile must clear the field (the TS spread overwrites the block).
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_logging("info", Some("/old.log"));
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_logging("debug", None);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.logging_level().as_deref(), Some("debug"));
        assert!(reloaded.logging_log_file().is_none());
        std::fs::remove_dir_all(&base).ok();
    }
}

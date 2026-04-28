//! `tenex config paths` — set backend name, projects-base directory, and
//! Blossom server URL.
//!
//! Source: `src/commands/config/paths.ts:8-51`. Three sequential input
//! prompts with current-value defaults; the Blossom URL has a prefix
//! validator. Persists all three fields together via
//! `saveTenexConfig` (`:49`); empty trimmed values clear the field
//! (matches `value || undefined` at `:45-47`).

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

const DEFAULT_BACKEND_NAME: &str = "tenex backend";
const DEFAULT_BLOSSOM_SERVER: &str = "https://blossom.primal.net";

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;

    let default_projects_base = default_home_tenex();
    let current_backend = doc
        .backend_name()
        .unwrap_or_else(|| DEFAULT_BACKEND_NAME.to_owned());
    let current_projects = doc.projects_base().unwrap_or(default_projects_base);
    let current_blossom = doc
        .blossom_server_url()
        .unwrap_or_else(|| DEFAULT_BLOSSOM_SERVER.to_owned());

    let backend_raw = match prompts::input("TENEX backend profile name:")
        .with_default(&current_backend)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("backend name prompt: {e}")),
    };

    let projects_raw = match prompts::input("Projects base directory:")
        .with_default(&current_projects)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("projects base prompt: {e}")),
    };

    let blossom_validator = prompts::adapt_static_str_validator(validate_blossom_url);
    let blossom_raw = match prompts::input("Blossom server URL for blob uploads:")
        .with_default(&current_blossom)
        .with_validator(blossom_validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("blossom URL prompt: {e}")),
    };

    let backend = backend_raw.trim();
    let projects = projects_raw.trim();
    let blossom = blossom_raw.trim();

    if backend.is_empty() {
        clear_field(&mut doc, "backendName");
    } else {
        doc.set_backend_name(backend.to_owned());
    }
    if projects.is_empty() {
        clear_field(&mut doc, "projectsBase");
    } else {
        doc.set_projects_base(projects.to_owned());
    }
    if blossom.is_empty() {
        clear_field(&mut doc, "blossomServerUrl");
    } else {
        doc.set_blossom_server_url(blossom.to_owned());
    }

    doc.save(base_dir)?;
    println!();
    let check_bold = console::Style::new().green().bold().apply_to("✓");
    let body = console::Style::new().green().apply_to(" Path settings updated");
    println!("{check_bold}{body}");
    Ok(())
}

/// Validate the Blossom URL — verbatim TS rule: must start with `http://`
/// or `https://`. Source: `paths.ts:36-41`.
pub fn validate_blossom_url(input: &str) -> Result<(), &'static str> {
    if input.starts_with("http://") || input.starts_with("https://") {
        Ok(())
    } else {
        Err("Please enter a valid HTTP(S) URL")
    }
}

fn clear_field(doc: &mut TenexConfigDoc, key: &str) {
    doc.raw_mut().shift_remove(key);
}

fn default_home_tenex() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        "tenex".to_owned()
    } else {
        format!("{home}/tenex")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-paths-{}-{}-{n}",
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
    fn validate_blossom_url_accepts_https() {
        assert!(validate_blossom_url("https://blossom.primal.net").is_ok());
    }

    #[test]
    fn validate_blossom_url_accepts_http() {
        assert!(validate_blossom_url("http://localhost:3000").is_ok());
    }

    #[test]
    fn validate_blossom_url_rejects_other_schemes_with_verbatim_message() {
        // Source: `paths.ts:38`.
        assert_eq!(
            validate_blossom_url("ftp://example.com"),
            Err("Please enter a valid HTTP(S) URL"),
        );
        assert_eq!(
            validate_blossom_url("blossom.primal.net"),
            Err("Please enter a valid HTTP(S) URL"),
        );
        assert_eq!(
            validate_blossom_url(""),
            Err("Please enter a valid HTTP(S) URL"),
        );
    }

    #[test]
    fn defaults_pinned_to_ts_constants() {
        assert_eq!(DEFAULT_BACKEND_NAME, "tenex backend");
        assert_eq!(DEFAULT_BLOSSOM_SERVER, "https://blossom.primal.net");
    }

    #[test]
    fn empty_value_clears_existing_field_via_clear_field_helper() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_backend_name("old".into());
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        clear_field(&mut doc, "backendName");
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert!(reloaded.backend_name().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn round_trip_writes_all_three_fields() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_backend_name("my backend".into());
        doc.set_projects_base("/srv/projects".into());
        doc.set_blossom_server_url("https://my.blossom".into());
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.backend_name().as_deref(), Some("my backend"));
        assert_eq!(reloaded.projects_base().as_deref(), Some("/srv/projects"));
        assert_eq!(
            reloaded.blossom_server_url().as_deref(),
            Some("https://my.blossom")
        );
        std::fs::remove_dir_all(&base).ok();
    }
}

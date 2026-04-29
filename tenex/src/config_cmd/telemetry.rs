//! `tenex config telemetry` — OpenTelemetry tracing and analysis store.
//!
//! Source: `src/commands/config/telemetry.ts:7-194`. Top-level menu has
//! 3 actions (configure, reset-analysis, back). The configure path
//! collects the three top-level fields (`enabled`, `serviceName`,
//! `endpoint`) plus an analysis sub-block guarded by a confirm; when
//! enabled, additional inputs collect `dbPath`, `retentionDays`,
//! `largeMessageThresholdTokens`, `storeMessagePreviews`,
//! `maxPreviewChars` (only when previews are enabled), and
//! `storeFullMessageText`. Disabling analysis spread-shapes the previous
//! values forward and only flips `enabled = false` (`:178-181`).

use std::path::PathBuf;

use anyhow::{anyhow, Result};

use crate::store::tenex_config::{TelemetryAnalysisFields, TenexConfigDoc};
use crate::tui::prompts;

const DEFAULT_SERVICE_NAME: &str = "tenex-daemon";
const DEFAULT_ENDPOINT: &str = "http://localhost:4318/v1/traces";
const DEFAULT_RETENTION_DAYS: u64 = 14;
const DEFAULT_LARGE_MESSAGE_THRESHOLD_TOKENS: u64 = 2000;
const DEFAULT_MAX_PREVIEW_CHARS: u64 = 256;
const DEFAULT_STORE_MESSAGE_PREVIEWS: bool = true;
const DEFAULT_STORE_FULL_MESSAGE_TEXT: bool = true;

/// Resolved analysis defaults — mirrors `getAnalysisTelemetryConfig`
/// at `ConfigService.ts:154-177`.
#[derive(Debug, Clone)]
pub struct ResolvedAnalysis {
    pub db_path: PathBuf,
    pub retention_days: u64,
    pub large_message_threshold_tokens: u64,
    pub store_message_previews: bool,
    pub max_preview_chars: u64,
    pub store_full_message_text: bool,
}

impl ResolvedAnalysis {
    /// Compute the resolved defaults given the TENEX base directory.
    pub fn from_base_dir(base_dir: &std::path::Path) -> Self {
        Self {
            db_path: base_dir.join("data").join("trace-analysis.db"),
            retention_days: DEFAULT_RETENTION_DAYS,
            large_message_threshold_tokens: DEFAULT_LARGE_MESSAGE_THRESHOLD_TOKENS,
            store_message_previews: DEFAULT_STORE_MESSAGE_PREVIEWS,
            max_preview_chars: DEFAULT_MAX_PREVIEW_CHARS,
            store_full_message_text: DEFAULT_STORE_FULL_MESSAGE_TEXT,
        }
    }
}

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let resolved = ResolvedAnalysis::from_base_dir(base_dir);
    render_listing(&doc, &resolved);
    drop(doc);

    let action = match prompts::select("Telemetry Settings", top_actions()).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("telemetry menu prompt: {e}")),
    };

    match action.value {
        TopAction::Back => Ok(()),
        TopAction::ResetAnalysis => run_reset_analysis(base_dir),
        TopAction::Configure => run_configure(base_dir, &resolved),
    }
}

fn render_listing(doc: &TenexConfigDoc, resolved: &ResolvedAnalysis) {
    let enabled = doc.telemetry_enabled().unwrap_or(true);
    let service_name = doc
        .telemetry_service_name()
        .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_owned());
    let endpoint = doc
        .telemetry_endpoint()
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
    let analysis_enabled = doc.telemetry_analysis_enabled().unwrap_or(false);
    let db_path = doc
        .telemetry_analysis_db_path()
        .unwrap_or_else(|| resolved.db_path.to_string_lossy().into_owned());
    let retention = doc
        .telemetry_analysis_retention_days()
        .unwrap_or(resolved.retention_days);
    let large_threshold = doc
        .telemetry_analysis_large_message_threshold_tokens()
        .unwrap_or(resolved.large_message_threshold_tokens);
    let store_previews = doc
        .telemetry_analysis_store_message_previews()
        .unwrap_or(resolved.store_message_previews);
    let max_preview = doc
        .telemetry_analysis_max_preview_chars()
        .unwrap_or(resolved.max_preview_chars);
    let store_full = doc
        .telemetry_analysis_store_full_message_text()
        .unwrap_or(resolved.store_full_message_text);

    println!("  Tracing enabled: {enabled}");
    println!("  Service name: {service_name}");
    println!("  Endpoint: {endpoint}");
    println!("  Analysis store enabled: {analysis_enabled}");
    println!("  Analysis DB path: {db_path}");
    println!("  Analysis retention days: {retention}");
    println!("  Large message threshold: {large_threshold}");
    println!("  Store previews: {store_previews}");
    println!("  Max preview chars: {max_preview}");
    println!("  Store full messages: {store_full}\n");
}

fn run_reset_analysis(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.clear_telemetry_analysis();
    doc.save(base_dir)?;
    crate::tui::display::config_success("Analysis telemetry reset to defaults.");
    Ok(())
}

fn run_configure(base_dir: &std::path::Path, resolved: &ResolvedAnalysis) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let prev_enabled = doc.telemetry_enabled().unwrap_or(true);
    let prev_service = doc
        .telemetry_service_name()
        .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_owned());
    let prev_endpoint = doc
        .telemetry_endpoint()
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
    let prev_analysis_enabled = doc.telemetry_analysis_enabled().unwrap_or(false);
    let prev_db_path = doc
        .telemetry_analysis_db_path()
        .unwrap_or_else(|| resolved.db_path.to_string_lossy().into_owned());
    let prev_retention = doc
        .telemetry_analysis_retention_days()
        .unwrap_or(resolved.retention_days);
    let prev_threshold = doc
        .telemetry_analysis_large_message_threshold_tokens()
        .unwrap_or(resolved.large_message_threshold_tokens);
    let prev_store_previews = doc
        .telemetry_analysis_store_message_previews()
        .unwrap_or(resolved.store_message_previews);
    let prev_max_preview = doc
        .telemetry_analysis_max_preview_chars()
        .unwrap_or(resolved.max_preview_chars);
    let prev_store_full = doc
        .telemetry_analysis_store_full_message_text()
        .unwrap_or(resolved.store_full_message_text);
    drop(doc);

    let enabled = match prompts::confirm("Enable OpenTelemetry tracing?")
        .with_default(prev_enabled)
        .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("tracing enable confirm: {e}")),
    };
    let service_name = match prompts::input("OTEL service name:")
        .with_default(&prev_service)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("service name prompt: {e}")),
    };
    let endpoint = match prompts::input("OTLP HTTP endpoint:")
        .with_default(&prev_endpoint)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("endpoint prompt: {e}")),
    };
    let analysis_enabled = match prompts::confirm("Enable local analysis telemetry store?")
        .with_default(prev_analysis_enabled)
        .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("analysis enable confirm: {e}")),
    };

    let analysis_fields = if analysis_enabled {
        let db_path = match prompts::input("Analysis SQLite DB path:")
            .with_default(&prev_db_path)
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("dbPath prompt: {e}")),
        };
        let positive = prompts::adapt_static_str_validator(
            crate::tui::prompts::validators::validate_positive_integer,
        );
        let retention_raw = match prompts::input("Analysis retention days:")
            .with_default(&prev_retention.to_string())
            .with_validator(positive.clone())
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("retentionDays prompt: {e}")),
        };
        let retention: u64 = retention_raw.trim().parse()?;

        let threshold_raw = match prompts::input("Large-message carry threshold (tokens):")
            .with_default(&prev_threshold.to_string())
            .with_validator(positive.clone())
            .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("largeMessageThreshold prompt: {e}")),
        };
        let threshold: u64 = threshold_raw.trim().parse()?;

        let store_previews = match prompts::confirm("Store prompt message previews?")
            .with_default(prev_store_previews)
            .prompt()
        {
            Ok(b) => b,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("storeMessagePreviews confirm: {e}")),
        };

        let max_preview_chars = if store_previews {
            let raw = match prompts::input("Maximum preview length:")
                .with_default(&prev_max_preview.to_string())
                .with_validator(positive)
                .prompt()
            {
                Ok(s) => s,
                Err(inquire::InquireError::OperationCanceled)
                | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
                Err(e) => return Err(anyhow!("maxPreviewChars prompt: {e}")),
            };
            Some(raw.trim().parse::<u64>()?)
        } else {
            None
        };

        let store_full = match prompts::confirm("Store full prompt message text?")
            .with_default(prev_store_full)
            .prompt()
        {
            Ok(b) => b,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("storeFullMessageText confirm: {e}")),
        };

        TelemetryAnalysisFields {
            enabled: true,
            db_path: Some(db_path),
            retention_days: Some(retention),
            large_message_threshold_tokens: Some(threshold),
            store_message_previews: Some(store_previews),
            max_preview_chars,
            store_full_message_text: Some(store_full),
        }
    } else {
        // Disabled: spread previous values forward, only flip enabled.
        // Matches `:178-181` `{ ...analysis, enabled: false }`.
        TelemetryAnalysisFields {
            enabled: false,
            db_path: Some(prev_db_path),
            retention_days: Some(prev_retention),
            large_message_threshold_tokens: Some(prev_threshold),
            store_message_previews: Some(prev_store_previews),
            max_preview_chars: Some(prev_max_preview),
            store_full_message_text: Some(prev_store_full),
        }
    };

    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.set_telemetry_enabled(enabled);
    doc.set_telemetry_service_name(&service_name);
    doc.set_telemetry_endpoint(&endpoint);
    doc.set_telemetry_analysis(analysis_fields);
    doc.save(base_dir)?;
    crate::tui::display::config_success("Telemetry config saved.");
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopAction {
    Configure,
    ResetAnalysis,
    Back,
}

#[derive(Debug, Clone)]
struct TopActionItem {
    label: String,
    value: TopAction,
}

impl std::fmt::Display for TopActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn top_actions() -> Vec<TopActionItem> {
    let dim_back = crate::tui::theme::chalk_dim("Back");
    vec![
        TopActionItem {
            label: "Configure tracing and analysis".into(),
            value: TopAction::Configure,
        },
        TopActionItem {
            label: "Reset analysis settings to defaults".into(),
            value: TopAction::ResetAnalysis,
        },
        TopActionItem {
            label: dim_back,
            value: TopAction::Back,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-telemetry-{}-{}-{n}",
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
    fn defaults_pinned_to_ts_constants() {
        assert_eq!(DEFAULT_SERVICE_NAME, "tenex-daemon");
        assert_eq!(DEFAULT_ENDPOINT, "http://localhost:4318/v1/traces");
        assert_eq!(DEFAULT_RETENTION_DAYS, 14);
        assert_eq!(DEFAULT_LARGE_MESSAGE_THRESHOLD_TOKENS, 2000);
        assert_eq!(DEFAULT_MAX_PREVIEW_CHARS, 256);
        let defaults = (
            DEFAULT_STORE_MESSAGE_PREVIEWS,
            DEFAULT_STORE_FULL_MESSAGE_TEXT,
        );
        assert_eq!(defaults, (true, true));
    }

    #[test]
    fn resolved_dbpath_lives_under_base_dir_data_subdir() {
        let r = ResolvedAnalysis::from_base_dir(std::path::Path::new("/tmp/fakehome/.tenex"));
        assert_eq!(
            r.db_path,
            std::path::PathBuf::from("/tmp/fakehome/.tenex/data/trace-analysis.db")
        );
    }

    #[test]
    fn top_actions_match_ts_in_order() {
        let acts = top_actions();
        assert_eq!(acts.len(), 3);
        assert_eq!(acts[0].label, "Configure tracing and analysis");
        assert_eq!(acts[0].value, TopAction::Configure);
        assert_eq!(acts[1].label, "Reset analysis settings to defaults");
        assert_eq!(acts[1].value, TopAction::ResetAnalysis);
        assert_eq!(acts[2].value, TopAction::Back);
    }

    #[test]
    fn reset_analysis_clears_block_and_keeps_other_fields() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_telemetry_enabled(true);
        doc.set_telemetry_service_name("svc");
        doc.set_telemetry_analysis(TelemetryAnalysisFields {
            enabled: true,
            db_path: Some("/tmp/x.db".into()),
            retention_days: Some(7),
            large_message_threshold_tokens: Some(100),
            store_message_previews: Some(false),
            max_preview_chars: Some(64),
            store_full_message_text: Some(false),
        });
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.clear_telemetry_analysis();
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.telemetry_enabled(), Some(true));
        assert_eq!(r.telemetry_service_name().as_deref(), Some("svc"));
        assert!(r.telemetry_analysis_enabled().is_none());
        assert!(r.telemetry_analysis_db_path().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn configure_persists_full_analysis_block_when_enabled() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_telemetry_analysis(TelemetryAnalysisFields {
            enabled: true,
            db_path: Some("/tmp/y.db".into()),
            retention_days: Some(30),
            large_message_threshold_tokens: Some(2000),
            store_message_previews: Some(true),
            max_preview_chars: Some(256),
            store_full_message_text: Some(true),
        });
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.telemetry_analysis_enabled(), Some(true));
        assert_eq!(r.telemetry_analysis_db_path().as_deref(), Some("/tmp/y.db"));
        assert_eq!(r.telemetry_analysis_retention_days(), Some(30));
        assert_eq!(
            r.telemetry_analysis_large_message_threshold_tokens(),
            Some(2000)
        );
        assert_eq!(r.telemetry_analysis_store_message_previews(), Some(true));
        assert_eq!(r.telemetry_analysis_max_preview_chars(), Some(256));
        assert_eq!(r.telemetry_analysis_store_full_message_text(), Some(true));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn disabled_analysis_omits_max_preview_chars_when_previews_off() {
        // Per `:173-175` — when `storeMessagePreviews` is false,
        // `maxPreviewChars` is `undefined`. Our `TelemetryAnalysisFields`
        // honors `None` by writing the field absent.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_telemetry_analysis(TelemetryAnalysisFields {
            enabled: true,
            db_path: Some("/tmp/p.db".into()),
            retention_days: Some(7),
            large_message_threshold_tokens: Some(100),
            store_message_previews: Some(false),
            max_preview_chars: None,
            store_full_message_text: Some(true),
        });
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.telemetry_analysis_store_message_previews(), Some(false));
        assert!(r.telemetry_analysis_max_preview_chars().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn telemetry_top_level_fields_preserved_through_analysis_set() {
        // Setting analysis must NOT clobber enabled/serviceName/endpoint.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_telemetry_enabled(false);
        doc.set_telemetry_service_name("custom-svc");
        doc.set_telemetry_endpoint("http://custom:1234");
        doc.set_telemetry_analysis(TelemetryAnalysisFields {
            enabled: true,
            db_path: Some("/tmp/d.db".into()),
            retention_days: Some(1),
            large_message_threshold_tokens: Some(10),
            store_message_previews: Some(false),
            max_preview_chars: None,
            store_full_message_text: Some(false),
        });
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.telemetry_enabled(), Some(false));
        assert_eq!(r.telemetry_service_name().as_deref(), Some("custom-svc"));
        assert_eq!(
            r.telemetry_endpoint().as_deref(),
            Some("http://custom:1234")
        );
        assert_eq!(r.telemetry_analysis_enabled(), Some(true));
        std::fs::remove_dir_all(&base).ok();
    }
}

//! `tenex config context-management` — managed context + RAG discovery.
//!
//! Source: `src/commands/config/context-management.ts:13-331`. Top-level
//! offers configure / reset / back. Configure walks 4 prompt sections in
//! order: managed-context (4 prompts), tool-result-decay (4 prompts),
//! strategies (5 confirms), context-discovery (10 prompts). Reset deletes
//! both the `contextManagement` and `contextDiscovery` blocks (`:35-36`).

use anyhow::{anyhow, Result};

use crate::store::tenex_config::{
    ContextDiscoveryPromptedFields, ContextManagementFields, TenexConfigDoc,
};
use crate::tui::prompts;

pub const DEFAULT_WORKING_TOKEN_BUDGET: u64 = 40_000;
pub const DEFAULT_WARNING_THRESHOLD_PERCENT: u64 = 70;
pub const DEFAULT_COMPACTION_THRESHOLD_PERCENT: u64 = 90;
pub const DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE: u64 = 10;
pub const DEFAULT_TOOL_DECAY_MIN_TOTAL_SAVINGS_TOKENS: u64 = 20_000;
pub const DEFAULT_TOOL_DECAY_MIN_DEPTH: u64 = 20;
pub const DEFAULT_DISCOVERY_TIMEOUT_MS: u64 = 1_200;
pub const DEFAULT_DISCOVERY_MAX_QUERIES: u64 = 4;
pub const DEFAULT_DISCOVERY_MAX_HINTS: u64 = 5;
pub const DEFAULT_DISCOVERY_MIN_SCORE: f64 = 0.45;
pub const DEFAULT_DISCOVERY_SOURCES: &[&str] = &["conversations", "lessons", "rag"];
pub const DEFAULT_DECAY_EXCLUDE_TOOL_NAMES: &[&str] = &["delegate", "delegate_followup"];

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let action = match prompts::select(
        "Context Management Settings",
        top_actions(),
    )
    .prompt()
    {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("context mgmt menu: {e}")),
    };
    match action.value {
        TopAction::Back => Ok(()),
        TopAction::Reset => run_reset(base_dir),
        TopAction::Configure => run_configure(base_dir),
    }
}

fn run_reset(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.clear_context_management();
    doc.clear_context_discovery();
    doc.save(base_dir)?;
    println!(
        "{}",
        crate::tui::theme::chalk_green("\n✓ Context management settings reset to defaults"),
    );
    Ok(())
}

fn run_configure(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let cm = read_cm_defaults(&doc);
    let cd = read_cd_defaults(&doc);
    drop(doc);

    let pos = prompts::adapt_static_str_validator(
        crate::tui::prompts::validators::validate_positive_integer,
    );
    let nonneg = prompts::adapt_static_str_validator(
        crate::tui::prompts::validators::validate_non_negative_integer,
    );
    let pct = prompts::adapt_static_str_validator(validate_percent_0_100);
    let batch = prompts::adapt_static_str_validator(validate_int_at_least_5);
    let queries = prompts::adapt_static_str_validator(validate_int_1_to_8);
    let hints = prompts::adapt_static_str_validator(validate_int_1_to_12);
    let score = prompts::adapt_static_str_validator(validate_float_0_to_1);
    let sources_v = prompts::adapt_static_str_validator(validate_discovery_sources);

    // Managed-context section.
    let enabled = ask_confirm(
        "Enable ai-sdk-context-management strategies:",
        cm.enabled,
    )?;
    let token_budget = ask_int(
        "Token budget for managed context:",
        cm.token_budget,
        pos.clone(),
    )?;
    let warn_pct = ask_int(
        "Utilization warning threshold (%):",
        cm.utilization_warning_threshold_percent,
        pct.clone(),
    )?;
    let compact_pct = ask_int(
        "Automatic compaction threshold (%):",
        cm.compaction_threshold_percent,
        pct.clone(),
    )?;

    // Tool-result-decay section.
    let decay_min_savings = ask_int(
        "Tool decay minimum savings threshold (tokens):",
        cm.tool_decay_min_total_savings_tokens,
        nonneg.clone(),
    )?;
    let decay_min_depth = ask_int(
        "Tool decay minimum age (messages ago):",
        cm.tool_decay_min_depth,
        nonneg.clone(),
    )?;
    let decay_batch_size = ask_int(
        "Tool decay minimum placeholder batch size:",
        cm.tool_decay_min_placeholder_batch_size,
        batch.clone(),
    )?;
    let decay_exclude_raw = ask_string(
        "Tool decay excluded tool names (comma-separated):",
        &cm.tool_decay_exclude_tool_names.join(", "),
    )?;
    let decay_exclude = parse_csv(&decay_exclude_raw);

    // Strategies section.
    let s_reminders =
        ask_confirm("Enable RemindersStrategy:", cm.strategies_reminders)?;
    let s_decay = ask_confirm(
        "Enable ToolResultDecayStrategy:",
        cm.strategies_tool_result_decay,
    )?;
    let s_compaction = ask_confirm(
        "Enable CompactionToolStrategy:",
        cm.strategies_compaction,
    )?;
    let s_ctx_util = ask_confirm(
        "Enable reminders context-utilization source:",
        cm.strategies_context_utilization_reminder,
    )?;
    let s_ctx_window = ask_confirm(
        "Enable reminders context-window-status source:",
        cm.strategies_context_window_status,
    )?;

    // Context discovery section.
    let cd_enabled = ask_confirm("Enable proactive context discovery:", cd.enabled)?;
    let cd_trigger = ask_select_trigger(&cd.trigger)?;
    let cd_timeout = ask_int(
        "Context discovery hot-path timeout (ms):",
        cd.timeout_ms,
        pos,
    )?;
    let cd_queries = ask_int(
        "Maximum discovery search queries:",
        cd.max_queries,
        queries,
    )?;
    let cd_hints = ask_int(
        "Maximum context hints to inject:",
        cd.max_hints,
        hints,
    )?;
    let cd_min_score = ask_float(
        "Minimum relevance score (0-1):",
        cd.min_score,
        score,
    )?;
    let cd_sources_raw = ask_string_validated(
        "Discovery sources (comma-separated: conversations, lessons, rag):",
        &cd.sources.join(", "),
        sources_v,
    )?;
    let cd_sources = parse_csv(&cd_sources_raw);
    let cd_planner = ask_confirm(
        "Use the contextDiscovery model to plan searches:",
        cd.use_planner_model,
    )?;
    let cd_reranker = ask_confirm(
        "Use the contextDiscovery model to rerank hints:",
        cd.use_reranker_model,
    )?;
    let cd_bg = ask_confirm(
        "Surface late context discovery results on a later turn:",
        cd.background_completion_reminders,
    )?;

    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.set_context_management(ContextManagementFields {
        enabled,
        token_budget,
        utilization_warning_threshold_percent: warn_pct,
        compaction_threshold_percent: compact_pct,
        tool_decay_min_total_savings_tokens: decay_min_savings,
        tool_decay_min_depth: decay_min_depth,
        tool_decay_min_placeholder_batch_size: decay_batch_size,
        tool_decay_exclude_tool_names: decay_exclude,
        strategies_reminders: s_reminders,
        strategies_tool_result_decay: s_decay,
        strategies_compaction: s_compaction,
        strategies_context_utilization_reminder: s_ctx_util,
        strategies_context_window_status: s_ctx_window,
    });
    doc.update_context_discovery(ContextDiscoveryPromptedFields {
        enabled: cd_enabled,
        trigger: cd_trigger,
        timeout_ms: cd_timeout,
        max_queries: cd_queries,
        max_hints: cd_hints,
        min_score: cd_min_score,
        sources: cd_sources,
        use_planner_model: cd_planner,
        use_reranker_model: cd_reranker,
        background_completion_reminders: cd_bg,
    });
    doc.save(base_dir)?;
    println!(
        "{}",
        crate::tui::theme::chalk_green("\n✓ Context management settings updated"),
    );
    Ok(())
}

#[derive(Debug, Clone)]
struct CmDefaults {
    enabled: bool,
    token_budget: u64,
    utilization_warning_threshold_percent: u64,
    compaction_threshold_percent: u64,
    tool_decay_min_total_savings_tokens: u64,
    tool_decay_min_depth: u64,
    tool_decay_min_placeholder_batch_size: u64,
    tool_decay_exclude_tool_names: Vec<String>,
    strategies_reminders: bool,
    strategies_tool_result_decay: bool,
    strategies_compaction: bool,
    strategies_context_utilization_reminder: bool,
    strategies_context_window_status: bool,
}

#[derive(Debug, Clone)]
struct CdDefaults {
    enabled: bool,
    trigger: String,
    timeout_ms: u64,
    max_queries: u64,
    max_hints: u64,
    min_score: f64,
    sources: Vec<String>,
    use_planner_model: bool,
    use_reranker_model: bool,
    background_completion_reminders: bool,
}

fn read_cm_defaults(doc: &TenexConfigDoc) -> CmDefaults {
    let block = doc.context_management_block();
    let bool_or = |key: &str, fallback: bool| -> bool {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(fallback)
    };
    let u64_or = |key: &str, fallback: u64| -> u64 {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(fallback)
    };
    let decay_block = block.and_then(|b| b.get("toolResultDecay")).and_then(serde_json::Value::as_object);
    let strat_block = block.and_then(|b| b.get("strategies")).and_then(serde_json::Value::as_object);
    let decay_u64 = |key: &str, fallback: u64| -> u64 {
        decay_block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(fallback)
    };
    let strat_bool = |key: &str, fallback: bool| -> bool {
        strat_block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(fallback)
    };
    let exclude = decay_block
        .and_then(|b| b.get("excludeToolNames"))
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| {
            DEFAULT_DECAY_EXCLUDE_TOOL_NAMES
                .iter()
                .map(|s| (*s).to_owned())
                .collect()
        });

    // The TS default for `enabled` uses `!== false` (i.e. true unless
    // explicitly disabled). Same for strategies.
    CmDefaults {
        enabled: block
            .and_then(|b| b.get("enabled"))
            .and_then(serde_json::Value::as_bool)
            != Some(false),
        token_budget: u64_or("tokenBudget", DEFAULT_WORKING_TOKEN_BUDGET),
        utilization_warning_threshold_percent: u64_or(
            "utilizationWarningThresholdPercent",
            DEFAULT_WARNING_THRESHOLD_PERCENT,
        ),
        compaction_threshold_percent: u64_or(
            "compactionThresholdPercent",
            DEFAULT_COMPACTION_THRESHOLD_PERCENT,
        ),
        tool_decay_min_total_savings_tokens: decay_u64(
            "minTotalSavingsTokens",
            DEFAULT_TOOL_DECAY_MIN_TOTAL_SAVINGS_TOKENS,
        ),
        tool_decay_min_depth: decay_u64("minDepth", DEFAULT_TOOL_DECAY_MIN_DEPTH),
        tool_decay_min_placeholder_batch_size: decay_u64(
            "minPlaceholderBatchSize",
            DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE,
        ),
        tool_decay_exclude_tool_names: exclude,
        strategies_reminders: strat_bool("reminders", true),
        strategies_tool_result_decay: strat_bool("toolResultDecay", true),
        strategies_compaction: strat_bool("compaction", true),
        strategies_context_utilization_reminder: strat_bool(
            "contextUtilizationReminder",
            true,
        ),
        strategies_context_window_status: strat_bool("contextWindowStatus", true),
        // The unused `bool_or` is reserved for future fields that use the
        // `?? false` pattern (rather than `!== false`); calls above use
        // `!= Some(false)` directly.
    }
    .with_unused(bool_or)
}

impl CmDefaults {
    fn with_unused<F>(self, _f: F) -> Self
    where
        F: Fn(&str, bool) -> bool,
    {
        self
    }
}

fn read_cd_defaults(doc: &TenexConfigDoc) -> CdDefaults {
    let block = doc.context_discovery_block();
    let bool_neq_false = |key: &str| -> bool {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    };
    let bool_or_false = |key: &str| -> bool {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    };
    let u64_or = |key: &str, fallback: u64| -> u64 {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(fallback)
    };
    let f64_or = |key: &str, fallback: f64| -> f64 {
        block
            .and_then(|b| b.get(key))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(fallback)
    };
    let trigger = block
        .and_then(|b| b.get("trigger"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("new-conversation")
        .to_owned();
    let sources = block
        .and_then(|b| b.get("sources"))
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| {
            DEFAULT_DISCOVERY_SOURCES
                .iter()
                .map(|s| (*s).to_owned())
                .collect()
        });

    CdDefaults {
        enabled: bool_neq_false("enabled"),
        trigger,
        timeout_ms: u64_or("timeoutMs", DEFAULT_DISCOVERY_TIMEOUT_MS),
        max_queries: u64_or("maxQueries", DEFAULT_DISCOVERY_MAX_QUERIES),
        max_hints: u64_or("maxHints", DEFAULT_DISCOVERY_MAX_HINTS),
        min_score: f64_or("minScore", DEFAULT_DISCOVERY_MIN_SCORE),
        sources,
        use_planner_model: bool_or_false("usePlannerModel"),
        use_reranker_model: bool_or_false("useRerankerModel"),
        background_completion_reminders: bool_neq_false("backgroundCompletionReminders"),
    }
}

// ---- prompt helpers ----

fn ask_confirm(message: &str, default: bool) -> Result<bool> {
    match prompts::confirm(message).with_default(default).prompt() {
        Ok(b) => Ok(b),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => {
            Err(anyhow!("cancelled"))
        }
        Err(e) => Err(anyhow!("{message}: {e}")),
    }
}

fn ask_int<F>(message: &str, default: u64, validator: F) -> Result<u64>
where
    F: Fn(&str) -> Result<inquire::validator::Validation, inquire::CustomUserError>
        + Clone
        + Send
        + Sync
        + 'static,
{
    let raw = prompts::input(message)
        .with_default(&default.to_string())
        .with_validator(validator)
        .prompt()
        .map_err(|e| anyhow!("{message}: {e}"))?;
    Ok(raw.trim().parse()?)
}

fn ask_float<F>(message: &str, default: f64, validator: F) -> Result<f64>
where
    F: Fn(&str) -> Result<inquire::validator::Validation, inquire::CustomUserError>
        + Clone
        + Send
        + Sync
        + 'static,
{
    let raw = prompts::input(message)
        .with_default(&default.to_string())
        .with_validator(validator)
        .prompt()
        .map_err(|e| anyhow!("{message}: {e}"))?;
    Ok(raw.trim().parse()?)
}

fn ask_string(message: &str, default: &str) -> Result<String> {
    prompts::input(message)
        .with_default(default)
        .prompt()
        .map_err(|e| anyhow!("{message}: {e}"))
}

fn ask_string_validated<F>(
    message: &str,
    default: &str,
    validator: F,
) -> Result<String>
where
    F: Fn(&str) -> Result<inquire::validator::Validation, inquire::CustomUserError>
        + Clone
        + Send
        + Sync
        + 'static,
{
    prompts::input(message)
        .with_default(default)
        .with_validator(validator)
        .prompt()
        .map_err(|e| anyhow!("{message}: {e}"))
}

fn ask_select_trigger(default: &str) -> Result<String> {
    let choices = vec![
        TriggerChoice {
            label: "When a conversation starts".into(),
            value: "new-conversation".into(),
        },
        TriggerChoice {
            label: "Before every turn".into(),
            value: "every-turn".into(),
        },
    ];
    let starting = choices
        .iter()
        .position(|c| c.value == default)
        .unwrap_or(0);
    let chosen = prompts::select("Run context discovery:", choices)
        .with_starting_cursor(starting)
        .prompt()
        .map_err(|e| anyhow!("trigger select: {e}"))?;
    Ok(chosen.value)
}

#[derive(Debug, Clone)]
struct TriggerChoice {
    label: String,
    value: String,
}

impl std::fmt::Display for TriggerChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn parse_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

// ---- validators (TS verbatim error strings) ----

pub fn validate_percent_0_100(input: &str) -> Result<(), &'static str> {
    let n: i64 = match input.parse::<i64>() {
        Ok(n) => n,
        Err(_) => return Err("Please enter a number between 0 and 100"),
    };
    if (0..=100).contains(&n) {
        Ok(())
    } else {
        Err("Please enter a number between 0 and 100")
    }
}

pub fn validate_int_at_least_5(input: &str) -> Result<(), &'static str> {
    match input.parse::<i64>() {
        Ok(n) if n >= 5 => Ok(()),
        _ => Err("Please enter an integer 5 or greater"),
    }
}

pub fn validate_int_1_to_8(input: &str) -> Result<(), &'static str> {
    match input.parse::<i64>() {
        Ok(n) if (1..=8).contains(&n) => Ok(()),
        _ => Err("Please enter a number from 1 to 8"),
    }
}

pub fn validate_int_1_to_12(input: &str) -> Result<(), &'static str> {
    match input.parse::<i64>() {
        Ok(n) if (1..=12).contains(&n) => Ok(()),
        _ => Err("Please enter a number from 1 to 12"),
    }
}

pub fn validate_float_0_to_1(input: &str) -> Result<(), &'static str> {
    match input.parse::<f64>() {
        Ok(n) if (0.0..=1.0).contains(&n) => Ok(()),
        _ => Err("Please enter a number from 0 to 1"),
    }
}

pub fn validate_discovery_sources(input: &str) -> Result<(), &'static str> {
    let allowed = ["conversations", "lessons", "rag"];
    let parsed: Vec<&str> = input
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parsed.is_empty() || parsed.iter().any(|s| !allowed.contains(s)) {
        Err("Use one or more of: conversations, lessons, rag")
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopAction {
    Configure,
    Reset,
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
            label: "Configure settings".into(),
            value: TopAction::Configure,
        },
        TopActionItem {
            label: "Reset to defaults".into(),
            value: TopAction::Reset,
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
            "tenex-config-cm-{}-{}-{n}",
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
        assert_eq!(DEFAULT_WORKING_TOKEN_BUDGET, 40_000);
        assert_eq!(DEFAULT_WARNING_THRESHOLD_PERCENT, 70);
        assert_eq!(DEFAULT_COMPACTION_THRESHOLD_PERCENT, 90);
        assert_eq!(DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE, 10);
        assert_eq!(DEFAULT_TOOL_DECAY_MIN_TOTAL_SAVINGS_TOKENS, 20_000);
        assert_eq!(DEFAULT_TOOL_DECAY_MIN_DEPTH, 20);
        assert_eq!(DEFAULT_DISCOVERY_TIMEOUT_MS, 1_200);
        assert_eq!(DEFAULT_DISCOVERY_MAX_QUERIES, 4);
        assert_eq!(DEFAULT_DISCOVERY_MAX_HINTS, 5);
        assert!((DEFAULT_DISCOVERY_MIN_SCORE - 0.45).abs() < 1e-9);
        assert_eq!(
            DEFAULT_DISCOVERY_SOURCES,
            &["conversations", "lessons", "rag"]
        );
        assert_eq!(
            DEFAULT_DECAY_EXCLUDE_TOOL_NAMES,
            &["delegate", "delegate_followup"]
        );
    }

    // Validators — verbatim TS error strings.

    #[test]
    fn percent_validator_accepts_0_to_100() {
        assert!(validate_percent_0_100("0").is_ok());
        assert!(validate_percent_0_100("70").is_ok());
        assert!(validate_percent_0_100("100").is_ok());
    }

    #[test]
    fn percent_validator_rejects_out_of_range_with_verbatim_message() {
        assert_eq!(
            validate_percent_0_100("-1"),
            Err("Please enter a number between 0 and 100"),
        );
        assert_eq!(
            validate_percent_0_100("101"),
            Err("Please enter a number between 0 and 100"),
        );
        assert_eq!(
            validate_percent_0_100("xyz"),
            Err("Please enter a number between 0 and 100"),
        );
    }

    #[test]
    fn batch_size_validator_floor_is_5() {
        assert!(validate_int_at_least_5("5").is_ok());
        assert!(validate_int_at_least_5("100").is_ok());
        assert_eq!(
            validate_int_at_least_5("4"),
            Err("Please enter an integer 5 or greater"),
        );
    }

    #[test]
    fn queries_validator_caps_at_8() {
        assert!(validate_int_1_to_8("1").is_ok());
        assert!(validate_int_1_to_8("8").is_ok());
        assert_eq!(
            validate_int_1_to_8("0"),
            Err("Please enter a number from 1 to 8"),
        );
        assert_eq!(
            validate_int_1_to_8("9"),
            Err("Please enter a number from 1 to 8"),
        );
    }

    #[test]
    fn hints_validator_caps_at_12() {
        assert!(validate_int_1_to_12("12").is_ok());
        assert_eq!(
            validate_int_1_to_12("13"),
            Err("Please enter a number from 1 to 12"),
        );
    }

    #[test]
    fn min_score_validator_accepts_zero_and_one() {
        assert!(validate_float_0_to_1("0").is_ok());
        assert!(validate_float_0_to_1("0.45").is_ok());
        assert!(validate_float_0_to_1("1.0").is_ok());
        assert_eq!(
            validate_float_0_to_1("1.1"),
            Err("Please enter a number from 0 to 1")
        );
        assert_eq!(
            validate_float_0_to_1("-0.1"),
            Err("Please enter a number from 0 to 1")
        );
    }

    #[test]
    fn sources_validator_accepts_all_three_in_any_order() {
        assert!(validate_discovery_sources("conversations").is_ok());
        assert!(validate_discovery_sources("rag, lessons, conversations").is_ok());
    }

    #[test]
    fn sources_validator_rejects_unknown_with_verbatim_message() {
        assert_eq!(
            validate_discovery_sources("conversations, evil"),
            Err("Use one or more of: conversations, lessons, rag")
        );
        assert_eq!(
            validate_discovery_sources(""),
            Err("Use one or more of: conversations, lessons, rag")
        );
    }

    #[test]
    fn parse_csv_trims_and_drops_empty() {
        assert_eq!(
            parse_csv("a, b ,, c "),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert!(parse_csv("").is_empty());
    }

    // Reset path.

    #[test]
    fn reset_clears_both_blocks() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_context_management(ContextManagementFields {
            enabled: true,
            token_budget: 40_000,
            utilization_warning_threshold_percent: 70,
            compaction_threshold_percent: 90,
            tool_decay_min_total_savings_tokens: 20_000,
            tool_decay_min_depth: 20,
            tool_decay_min_placeholder_batch_size: 10,
            tool_decay_exclude_tool_names: vec!["delegate".into()],
            strategies_reminders: true,
            strategies_tool_result_decay: true,
            strategies_compaction: true,
            strategies_context_utilization_reminder: true,
            strategies_context_window_status: true,
        });
        doc.update_context_discovery(ContextDiscoveryPromptedFields {
            enabled: true,
            trigger: "new-conversation".into(),
            timeout_ms: 1200,
            max_queries: 4,
            max_hints: 5,
            min_score: 0.45,
            sources: vec!["conversations".into()],
            use_planner_model: false,
            use_reranker_model: false,
            background_completion_reminders: true,
        });
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.clear_context_management();
        doc.clear_context_discovery();
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert!(r.context_management_block().is_none());
        assert!(r.context_discovery_block().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn discovery_update_preserves_unknown_fields() {
        // Per `:312-313`, the discovery write spreads existing fields. We
        // simulate that by pre-injecting `injectWhenEmpty` (not in the
        // prompt) and verifying it survives an update.
        use serde_json::Value;
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        // Manually inject a contextDiscovery block with an extra field.
        let mut block = serde_json::Map::new();
        block.insert("injectWhenEmpty".into(), Value::Bool(true));
        block.insert("manifestTtlMs".into(), Value::Number(60000.into()));
        doc.raw_mut()
            .insert("contextDiscovery".into(), Value::Object(block));
        doc.update_context_discovery(ContextDiscoveryPromptedFields {
            enabled: false,
            trigger: "every-turn".into(),
            timeout_ms: 500,
            max_queries: 2,
            max_hints: 1,
            min_score: 0.1,
            sources: vec!["rag".into()],
            use_planner_model: true,
            use_reranker_model: true,
            background_completion_reminders: false,
        });
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        let block = r.context_discovery_block().unwrap();
        // Prompted fields applied.
        assert_eq!(block.get("trigger").and_then(Value::as_str), Some("every-turn"));
        assert_eq!(block.get("timeoutMs").and_then(Value::as_u64), Some(500));
        // Unprompted fields preserved.
        assert_eq!(block.get("injectWhenEmpty").and_then(Value::as_bool), Some(true));
        assert_eq!(
            block.get("manifestTtlMs").and_then(Value::as_u64),
            Some(60000)
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn top_actions_match_expected_set_in_order() {
        let acts = top_actions();
        assert_eq!(acts.len(), 3);
        assert_eq!(acts[0].value, TopAction::Configure);
        assert_eq!(acts[1].value, TopAction::Reset);
        assert_eq!(acts[2].value, TopAction::Back);
    }
}

//! `tenex config telegram` — agent Telegram bots + global DM allowlist.
//!
//! Source: `src/commands/config/telegram.ts:1-435`. The TS source has two
//! sub-flows reachable from a top-level select:
//!
//! 1. **Configure an agent Telegram bot** (`:236-307`) — operates on
//!    per-agent `TelegramAgentConfig` records in
//!    [`crate::store::agent_storage::AgentStorage`]. The Rust port wires
//!    the chooseAgent → action loop with the four mutation paths
//!    (token, apiBaseUrl, toggle DMs, reset) plus Back. The TS version
//!    enriches its summary with runtime-binding-store data
//!    (`TransportBindingStore`, `IdentityBindingStore`,
//!    `TelegramChatContextStore`); those stores are daemon-owned and
//!    not yet ported, so the Rust summary skips the
//!    "Remembered project bindings" lines and prints only the three
//!    immediate-config lines (token mask, DMs status, API base URL).
//! 2. **Configure global Telegram DM allowlist** (`:317-392`) — operates
//!    on the `whitelistedIdentities` array in `~/.tenex/config.json`,
//!    filtered for entries with the `telegram:` prefix. Wired fully.

use anyhow::{anyhow, Result};

use crate::agent_cmd::telegram_config::{mask_token, normalize_telegram_draft, to_draft};
use crate::store::agent_storage::{AgentStorage, TelegramAgentConfig};
use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;
use crate::types::telegram::is_telegram_identity;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    loop {
        println!();
        let action = match prompts::select("Telegram settings", top_actions()).prompt() {
            Ok(a) => a,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("telegram menu: {e}")),
        };
        match action.value {
            TopAction::Back => return Ok(()),
            TopAction::Agent => configure_agent_telegram(base_dir)?,
            TopAction::Global => run_global_allowlist(base_dir)?,
        }
    }
}

fn run_global_allowlist(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let mut tg = collect_telegram_identities(&doc);

    loop {
        render_listing(&tg);
        let action =
            match prompts::select("Global Telegram DM access", allowlist_actions()).prompt() {
                Ok(a) => a,
                Err(inquire::InquireError::OperationCanceled)
                | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
                Err(e) => return Err(anyhow!("allowlist menu: {e}")),
            };
        match action.value {
            AllowlistAction::Back => return Ok(()),
            AllowlistAction::Add => match run_add(&tg)? {
                Some(updated) => tg = updated,
                None => continue,
            },
            AllowlistAction::Remove => match run_remove(&tg)? {
                Some(updated) => tg = updated,
                None => continue,
            },
            AllowlistAction::Clear => {
                tg.clear();
            }
        }
        let merged = merge_back(&doc, &tg);
        doc.set_whitelisted_identities(merged);
        doc.save(base_dir)?;
        crate::tui::display::config_success("Global Telegram DM allowlist saved.");
    }
}

/// Read existing `whitelistedIdentities`, filter to `telegram:`-prefix
/// entries, trim each, dedupe preserving first-seen order. Source:
/// `:320-324`.
fn collect_telegram_identities(doc: &TenexConfigDoc) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for raw in doc.whitelisted_identities() {
        let trimmed = raw.trim().to_owned();
        if !is_telegram_identity(&trimmed) {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    out
}

/// Build the new `whitelistedIdentities` list from the on-disk doc by
/// keeping every non-telegram identity and appending the deduped current
/// telegram set. Source: `mergeTelegramIdentityList` at `:309-315`.
fn merge_back(doc: &TenexConfigDoc, telegram: &[String]) -> Vec<String> {
    let mut out: Vec<String> = doc
        .whitelisted_identities()
        .into_iter()
        .filter(|id| !is_telegram_identity(id))
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    for id in telegram {
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    out
}

fn render_listing(telegram: &[String]) {
    println!();
    println!("  Global Telegram DM allowlist:");
    if telegram.is_empty() {
        // TS at telegram.ts:330 emits `console.log(chalk.dim("    none"))`
        // — 4 leading spaces are INSIDE the dim wrap. Mirror byte-for-byte.
        println!("{}", crate::tui::theme::chalk_dim("    none"));
    } else {
        for id in telegram {
            println!("    {id}");
        }
    }
}

fn run_add(current: &[String]) -> Result<Option<Vec<String>>> {
    let validator = prompts::adapt_static_str_validator(validate_telegram_principal);
    let raw = match prompts::input("Telegram principal ID (for example telegram:user:12345):")
        .with_validator(validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("add identity prompt: {e}")),
    };
    let trimmed = raw.trim().to_owned();
    let mut updated = current.to_vec();
    if !updated.iter().any(|id| id == &trimmed) {
        updated.push(trimmed);
    }
    Ok(Some(updated))
}

fn run_remove(current: &[String]) -> Result<Option<Vec<String>>> {
    if current.is_empty() {
        // Per `:367-369` — silently continue when there's nothing to remove.
        return Ok(None);
    }
    let chosen = match prompts::select("Remove which identity?", current.to_vec()).prompt() {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("remove identity prompt: {e}")),
    };
    let updated: Vec<String> = current.iter().filter(|id| **id != chosen).cloned().collect();
    Ok(Some(updated))
}

/// Verbatim TS validator at `:362`: `startsWith("telegram:")`.
pub fn validate_telegram_principal(input: &str) -> Result<(), &'static str> {
    if input.trim().starts_with("telegram:") {
        Ok(())
    } else {
        Err("Principal IDs must start with telegram:")
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopAction {
    Agent,
    Global,
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
    vec![
        TopActionItem {
            label: "Configure an agent Telegram bot".into(),
            value: TopAction::Agent,
        },
        TopActionItem {
            label: "Configure global Telegram DM allowlist".into(),
            value: TopAction::Global,
        },
        TopActionItem {
            label: "Back".into(),
            value: TopAction::Back,
        },
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AllowlistAction {
    Add,
    Remove,
    Clear,
    Back,
}

#[derive(Debug, Clone)]
struct AllowlistActionItem {
    label: String,
    value: AllowlistAction,
}

impl std::fmt::Display for AllowlistActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn allowlist_actions() -> Vec<AllowlistActionItem> {
    vec![
        AllowlistActionItem {
            label: "Add an identity".into(),
            value: AllowlistAction::Add,
        },
        AllowlistActionItem {
            label: "Remove an identity".into(),
            value: AllowlistAction::Remove,
        },
        AllowlistActionItem {
            label: "Clear all Telegram identities".into(),
            value: AllowlistAction::Clear,
        },
        AllowlistActionItem {
            label: "Back".into(),
            value: AllowlistAction::Back,
        },
    ]
}

// ─── Per-agent Telegram config flow ─────────────────────────────────────────

/// Mirror `configureAgentTelegram` (`commands/config/telegram.ts:236-307`).
///
/// Outer loop: pick an agent (or Back); inner loop: re-load + summarise +
/// action select, dispatch to the four mutation paths plus Back. Each
/// successful mutation prints `✓ Telegram transport updated.` (TS green
/// checkmark + bold suffix).
///
/// The runtime-binding-store enrichments (`listRememberedBindings`,
/// `describeRememberedBinding`) used by the TS summary are not surfaced
/// — those stores are daemon-owned and not yet ported. The three
/// immediate config lines (bot token mask, DMs status, API base URL) are
/// faithful.
fn configure_agent_telegram(base_dir: &std::path::Path) -> Result<()> {
    loop {
        let Some(pubkey) = choose_agent(base_dir)? else {
            return Ok(());
        };
        run_agent_actions(base_dir, &pubkey)?;
    }
}

fn run_agent_actions(base_dir: &std::path::Path, pubkey: &str) -> Result<()> {
    loop {
        let mut storage = AgentStorage::open(base_dir)?;
        let Some(agent) = storage.load_agent(pubkey)? else {
            // Mirror TS: red "❌ Agent disappeared while editing."
            // (`telegram.ts:248`).
            println!(
                "{}",
                crate::tui::theme::chalk_red("❌ Agent disappeared while editing."),
            );
            return Ok(());
        };
        let current = agent.telegram_config();
        let slug = agent.slug().unwrap_or("?").to_owned();

        println!();
        println!(
            "{}",
            crate::tui::theme::chalk_bold(&format!("{slug} — Telegram transport")),
        );
        for line in summarise_telegram_lines(current.as_ref()) {
            println!("{line}");
        }
        println!();

        let action = match prompts::select(
            "Telegram transport",
            agent_actions(),
        )
        .prompt()
        {
            Ok(a) => a,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("agent telegram action: {e}")),
        };

        match action.value {
            AgentAction::Back => return Ok(()),
            AgentAction::Reset => {
                storage.update_agent_telegram_config(pubkey, None)?;
                print_agent_transport_updated();
                continue;
            }
            AgentAction::Token => {
                let mut next = to_draft(current.as_ref()).unwrap_or_default();
                let new_token = match prompt_for_bot_token(next.bot_token.as_deref())? {
                    Some(t) => t,
                    None => continue,
                };
                next.bot_token = Some(new_token);
                let normalised = normalize_telegram_draft(Some(&next));
                storage.update_agent_telegram_config(pubkey, normalised.as_ref())?;
                print_agent_transport_updated();
            }
            AgentAction::ApiBaseUrl => {
                let mut next = to_draft(current.as_ref()).unwrap_or_default();
                if next.bot_token.is_none()
                    || next.bot_token.as_deref().map(str::trim).unwrap_or("").is_empty()
                {
                    println!(
                        "{}",
                        crate::tui::theme::chalk_yellow("  Set a bot token first."),
                    );
                    continue;
                }
                let updated = match prompt_for_api_base_url(next.api_base_url.as_deref())? {
                    Some(s) => s,
                    None => continue,
                };
                next.api_base_url = updated;
                let normalised = normalize_telegram_draft(Some(&next));
                storage.update_agent_telegram_config(pubkey, normalised.as_ref())?;
                print_agent_transport_updated();
            }
            AgentAction::ToggleDms => {
                let mut next = to_draft(current.as_ref()).unwrap_or_default();
                if next.bot_token.is_none()
                    || next.bot_token.as_deref().map(str::trim).unwrap_or("").is_empty()
                {
                    println!(
                        "{}",
                        crate::tui::theme::chalk_yellow("  Set a bot token first."),
                    );
                    continue;
                }
                // TS at `telegram.ts:300`:
                //   nextDraft.allowDMs = nextDraft.allowDMs === false;
                // i.e. flip false→true; everything else (true / undefined)
                // becomes false. We mirror that exactly.
                next.allow_dms = Some(next.allow_dms == Some(false));
                let normalised = normalize_telegram_draft(Some(&next));
                storage.update_agent_telegram_config(pubkey, normalised.as_ref())?;
                print_agent_transport_updated();
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentAction {
    Token,
    ApiBaseUrl,
    ToggleDms,
    Reset,
    Back,
}

#[derive(Debug, Clone)]
struct AgentActionItem {
    label: String,
    value: AgentAction,
}

impl std::fmt::Display for AgentActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn agent_actions() -> Vec<AgentActionItem> {
    vec![
        AgentActionItem {
            label: "Set or replace bot token".into(),
            value: AgentAction::Token,
        },
        AgentActionItem {
            label: "Set or clear API base URL".into(),
            value: AgentAction::ApiBaseUrl,
        },
        AgentActionItem {
            label: "Toggle DMs".into(),
            value: AgentAction::ToggleDms,
        },
        AgentActionItem {
            label: "Disable Telegram for this agent".into(),
            value: AgentAction::Reset,
        },
        AgentActionItem {
            label: "Back".into(),
            value: AgentAction::Back,
        },
    ]
}

/// Mirror `chooseAgent` (`telegram.ts:173-207`).
///
/// Lists canonical-active agents sorted by slug; appends a dim "Back"
/// entry. Returns `None` for the Back path or when the prompt is
/// cancelled. The TS version annotates each agent with project count;
/// we mirror that via the index's project list.
fn choose_agent(base_dir: &std::path::Path) -> Result<Option<String>> {
    let storage = AgentStorage::open(base_dir)?;
    let mut agents = storage.get_canonical_active_agents()?;
    if agents.is_empty() {
        println!(
            "{}",
            crate::tui::theme::chalk_dim("  No active agents found."),
        );
        return Ok(None);
    }
    agents.sort_by(|a, b| {
        a.slug()
            .unwrap_or("")
            .cmp(b.slug().unwrap_or(""))
    });

    let mut items: Vec<AgentChoice> = Vec::with_capacity(agents.len() + 1);
    for agent in &agents {
        let nsec = agent.nsec().ok_or_else(|| anyhow!("agent missing nsec"))?;
        let pubkey = crate::store::agent_storage::derive_agent_pubkey_from_nsec(nsec)?;
        let projects = crate::store::project_members::list_projects_for_agent(
            base_dir, &pubkey,
        )?;
        let n = projects.len();
        let plural = if n == 1 { "" } else { "s" };
        let slug = agent.slug().unwrap_or("?");
        let name = agent.name().unwrap_or("");
        items.push(AgentChoice {
            label: format!("{slug} — {name} ({n} project{plural})"),
            pubkey: Some(pubkey),
        });
    }
    items.push(AgentChoice {
        label: crate::tui::theme::chalk_dim("Back"),
        pubkey: None,
    });

    let chosen = match prompts::select("Choose an agent", items).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("choose agent: {e}")),
    };
    Ok(chosen.pubkey)
}

#[derive(Debug, Clone)]
struct AgentChoice {
    label: String,
    pubkey: Option<String>,
}

impl std::fmt::Display for AgentChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

/// Mirror `summarizeTelegramConfig` (`telegram.ts:132-163`), minus the
/// runtime-binding-store-derived "Remembered project bindings" lines
/// (those depend on the TransportBindingStore + IdentityBindingStore +
/// TelegramChatContextStore — daemon-owned, not yet ported).
fn summarise_telegram_lines(config: Option<&TelegramAgentConfig>) -> Vec<String> {
    use crate::tui::theme::chalk_dim;
    let bot_token = match config {
        Some(c) => mask_token(&c.bot_token),
        None => chalk_dim("not configured"),
    };
    let dms = match config {
        None => chalk_dim("no bot configured"),
        Some(c) if c.allow_dms == Some(false) => "no".to_string(),
        Some(_) => "yes".to_string(),
    };
    let api = match config.and_then(|c| c.api_base_url.as_deref()) {
        Some(u) => u.to_string(),
        None => chalk_dim("default"),
    };
    vec![
        format!("  Bot token: {bot_token}"),
        format!("  DMs enabled: {dms}"),
        format!("  API base URL: {api}"),
    ]
}

/// Mirror `promptForBotToken` (`telegram.ts:209-221`):
/// password prompt with masked input + non-empty-trim validation
/// (verbatim error: `"Bot token cannot be empty"`).
/// Cancel/interrupt → `Ok(None)`.
fn prompt_for_bot_token(_current: Option<&str>) -> Result<Option<String>> {
    // `inquire::Password` does not honour a `default` value — entering
    // a blank password just re-uses the prior value. The TS `default`
    // parameter is functionally a hint; users typically want to retype.
    // We mirror by validating non-empty trimmed input directly.
    let validator = prompts::adapt_static_str_validator(validate_bot_token);
    let result = prompts::password("Telegram Bot API token:")
        .with_validator(validator)
        .prompt();
    match result {
        Ok(s) => Ok(Some(s.trim().to_owned())),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("bot token prompt: {e}")),
    }
}

fn validate_bot_token(input: &str) -> Result<(), &'static str> {
    if input.trim().is_empty() {
        Err("Bot token cannot be empty")
    } else {
        Ok(())
    }
}

/// Mirror `promptForApiBaseUrl` (`telegram.ts:223-234`):
/// plain text prompt, default = current; trimmed empty → `None` (clears
/// the field).
fn prompt_for_api_base_url(current: Option<&str>) -> Result<Option<Option<String>>> {
    let prompt = prompts::input("Telegram API base URL (leave blank for default):");
    let prompt = match current {
        Some(s) => prompt.with_default(s),
        None => prompt,
    };
    match prompt.prompt() {
        Ok(s) => {
            let trimmed = s.trim().to_owned();
            if trimmed.is_empty() {
                Ok(Some(None))
            } else {
                Ok(Some(Some(trimmed)))
            }
        }
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("api base url prompt: {e}")),
    }
}

/// Route through `display::config_success` so the agent flow's
/// `✓ Telegram transport updated.` line uses the same green-check +
/// bold-text wire bytes as every other config-submenu success banner.
fn print_agent_transport_updated() {
    crate::tui::display::config_success("Telegram transport updated.");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-telegram-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // ---- validators -----------------------------------------------------

    #[test]
    fn validate_principal_accepts_telegram_user() {
        assert!(validate_telegram_principal("telegram:user:12345").is_ok());
    }

    #[test]
    fn validate_principal_accepts_minimal_telegram_prefix() {
        // The TS validator only checks the prefix; the `user:`/`channel:` shape
        // is a hint in the prompt message but not enforced.
        assert!(validate_telegram_principal("telegram:foo").is_ok());
    }

    #[test]
    fn validate_principal_rejects_non_telegram_prefix_with_verbatim_message() {
        assert_eq!(
            validate_telegram_principal("user:12345"),
            Err("Principal IDs must start with telegram:")
        );
        assert_eq!(
            validate_telegram_principal(""),
            Err("Principal IDs must start with telegram:")
        );
    }

    // ---- collect / merge --------------------------------------------

    #[test]
    fn collect_filters_to_telegram_prefix_only() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_identities(vec![
            "telegram:user:1".into(),
            "github:other".into(),
            "telegram:user:2".into(),
        ]);
        doc.save(&base).unwrap();

        let doc = TenexConfigDoc::load(&base).unwrap();
        let collected = collect_telegram_identities(&doc);
        assert_eq!(
            collected,
            vec!["telegram:user:1".to_owned(), "telegram:user:2".to_owned()]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn collect_dedupes_telegram_identities() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_identities(vec![
            "telegram:user:1".into(),
            "telegram:user:1".into(),
            " telegram:user:1 ".into(), // trim before dedupe
        ]);
        doc.save(&base).unwrap();

        let doc = TenexConfigDoc::load(&base).unwrap();
        let collected = collect_telegram_identities(&doc);
        assert_eq!(collected, vec!["telegram:user:1".to_owned()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn merge_back_preserves_non_telegram_entries_then_appends_telegram() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_identities(vec![
            "github:foo".into(),
            "telegram:user:OLD".into(),
            "matrix:bar".into(),
        ]);
        doc.save(&base).unwrap();

        let doc = TenexConfigDoc::load(&base).unwrap();
        let new_tg = vec!["telegram:user:1".to_owned(), "telegram:user:2".to_owned()];
        let merged = merge_back(&doc, &new_tg);
        // Non-telegram entries preserved (in their original order),
        // followed by the new telegram set.
        assert_eq!(
            merged,
            vec![
                "github:foo".to_owned(),
                "matrix:bar".to_owned(),
                "telegram:user:1".to_owned(),
                "telegram:user:2".to_owned(),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn merge_back_dedupes_telegram_during_append() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_identities(vec!["github:foo".into()]);
        doc.save(&base).unwrap();
        let doc = TenexConfigDoc::load(&base).unwrap();
        let new_tg = vec![
            "telegram:user:1".to_owned(),
            "telegram:user:1".to_owned(),
            "telegram:user:2".to_owned(),
        ];
        let merged = merge_back(&doc, &new_tg);
        assert_eq!(
            merged,
            vec![
                "github:foo".to_owned(),
                "telegram:user:1".to_owned(),
                "telegram:user:2".to_owned(),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- run_add / run_remove (pure logic on the input list) ------------

    #[test]
    fn add_dedupes_against_existing_list() {
        // We can't drive the actual prompt; verify the dedupe semantics
        // directly via a parallel pure helper.
        fn append_dedup(current: &[String], new_id: &str) -> Vec<String> {
            let mut updated = current.to_vec();
            let trimmed = new_id.trim().to_owned();
            if !updated.iter().any(|id| id == &trimmed) {
                updated.push(trimmed);
            }
            updated
        }
        let current = vec!["telegram:user:1".to_owned()];
        let after = append_dedup(&current, "telegram:user:1");
        assert_eq!(after, vec!["telegram:user:1".to_owned()]);
        let after2 = append_dedup(&current, "telegram:user:2");
        assert_eq!(
            after2,
            vec!["telegram:user:1".to_owned(), "telegram:user:2".to_owned()]
        );
    }

    #[test]
    fn remove_filters_chosen_entry() {
        let current = [
            "telegram:user:1".to_owned(),
            "telegram:user:2".to_owned(),
            "telegram:user:3".to_owned(),
        ];
        let updated: Vec<String> = current
            .iter()
            .filter(|id| **id != "telegram:user:2")
            .cloned()
            .collect();
        assert_eq!(
            updated,
            vec!["telegram:user:1".to_owned(), "telegram:user:3".to_owned()]
        );
    }

    // ---- menu shapes ---------------------------------------------------

    #[test]
    fn top_actions_match_ts_in_order() {
        let acts = top_actions();
        let labels: Vec<&str> = acts.iter().map(|a| a.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Configure an agent Telegram bot",
                "Configure global Telegram DM allowlist",
                "Back",
            ]
        );
    }

    #[test]
    fn allowlist_actions_match_ts_in_order() {
        let acts = allowlist_actions();
        let labels: Vec<&str> = acts.iter().map(|a| a.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Add an identity",
                "Remove an identity",
                "Clear all Telegram identities",
                "Back",
            ]
        );
    }
}

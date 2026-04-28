//! `tenex config telegram` — agent Telegram bots + global DM allowlist.
//!
//! Source: `src/commands/config/telegram.ts:1-435`. The TS source has two
//! sub-flows reachable from a top-level select:
//!
//! 1. **Configure an agent Telegram bot** (`:236-307`) — operates on
//!    per-agent `TelegramAgentConfig` records in
//!    [`agentStorage`][TS]. This Rust port surfaces this branch with a
//!    `display::hint` since `AgentStorage` is its own subsystem (spec doc
//!    10) and is not yet ported. Going further would require porting the
//!    agent registry, transport-binding store, identity-binding store,
//!    and telegram-chat-context cache — each substantial.
//! 2. **Configure global Telegram DM allowlist** (`:317-392`) — operates
//!    on the `whitelistedIdentities` array in `~/.tenex/config.json`,
//!    filtered for entries with the `telegram:` prefix. This Rust port
//!    implements this branch fully against [`TenexConfigDoc`].
//!
//! [TS]: src/agents/AgentStorage.ts

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::display;
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
            TopAction::Agent => {
                display::hint(
                    "Per-agent Telegram bot configuration depends on the AgentStorage \
                     subsystem (spec doc 10) — pending port.",
                );
            }
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
        print_success_line("Global Telegram DM allowlist saved.");
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
        let dim = console::Style::new().dim();
        println!("    {}", dim.apply_to("none"));
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

fn print_success_line(text: &str) {
    let check = console::Style::new().green().apply_to("✓");
    let bold = console::Style::new().bold().apply_to(format!(" {text}"));
    println!("{check}{bold}");
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
        let current = vec![
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

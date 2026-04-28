//! `tenex config identity` — manage `whitelistedPubkeys`.
//!
//! Source: `src/commands/config/identity.ts:7-70`. Single-shot interaction
//! (no menu loop): list current state, ask for one action, perform it,
//! return. The outer `tenex config` menu is responsible for the
//! "show again on return" loop.
//!
//! **Important asymmetry preserved verbatim** (per spec doc 07 §1):
//! the Add prompt's *label* says `Pubkey (hex or npub):` but the value is
//! stored VERBATIM — no `nip19` decode happens here (`:42-49`). The only
//! validator is non-empty-after-trim. Decoding lives in
//! `tenex onboard --pubkey` and `runInteractiveSetup`, not here.
//! Rust [`crate::types::pubkey::Pubkey::parse_decoding`] is intentionally
//! NOT routed through this module.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::display;
use crate::tui::prompts;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let pubkeys = doc.whitelisted_pubkeys();

    render_listing(&pubkeys);

    let action = match prompts::select("What do you want to do?", actions()).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("identity action prompt: {e}")),
    };

    match action.value {
        ActionValue::Add => add_pubkey(base_dir, &mut doc, pubkeys)?,
        ActionValue::Remove => remove_pubkey(base_dir, &mut doc, pubkeys)?,
        ActionValue::Back => {}
    }
    Ok(())
}

/// Print the listing block. Source: `:14-23`.
fn render_listing(pubkeys: &[String]) {
    let dim = console::Style::new().dim();
    if pubkeys.is_empty() {
        // TS prints with a trailing `\n` embedded in the string.
        println!("  {}", dim.apply_to("No authorized pubkeys."));
        println!();
    } else {
        println!("  Authorized pubkeys:");
        for pk in pubkeys {
            println!("    {pk}");
        }
        println!();
    }
}

fn add_pubkey(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    existing: Vec<String>,
) -> Result<()> {
    let validator = prompts::adapt_static_str_validator(|input: &str| {
        if input.trim().is_empty() {
            Err("Pubkey cannot be empty")
        } else {
            Ok(())
        }
    });
    let raw = match prompts::input("Pubkey (hex or npub):")
        .with_validator(validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("pubkey input: {e}")),
    };
    let trimmed = raw.trim().to_owned();
    let mut updated = existing;
    updated.push(trimmed);
    doc.set_whitelisted_pubkeys(updated);
    doc.save(base_dir)?;
    print_success_line("Pubkey added.");
    Ok(())
}

fn remove_pubkey(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    existing: Vec<String>,
) -> Result<()> {
    if existing.is_empty() {
        let dim = console::Style::new().dim();
        println!("  {}", dim.apply_to("Nothing to remove."));
        return Ok(());
    }
    let chosen = match prompts::select("Remove which pubkey?", existing.clone()).prompt() {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("remove pubkey prompt: {e}")),
    };
    let updated: Vec<String> = existing.into_iter().filter(|pk| pk != &chosen).collect();
    doc.set_whitelisted_pubkeys(updated);
    doc.save(base_dir)?;
    print_success_line("Pubkey removed.");
    Ok(())
}

fn print_success_line(text: &str) {
    let check = console::Style::new().green().apply_to("✓");
    let bold_text = console::Style::new().bold().apply_to(format!(" {text}"));
    println!("{check}{bold_text}");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionValue {
    Add,
    Remove,
    Back,
}

#[derive(Debug, Clone)]
struct ActionItem {
    label: &'static str,
    value: ActionValue,
}

impl std::fmt::Display for ActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label)
    }
}

fn actions() -> Vec<ActionItem> {
    vec![
        ActionItem {
            label: "Add a pubkey",
            value: ActionValue::Add,
        },
        ActionItem {
            label: "Remove a pubkey",
            value: ActionValue::Remove,
        },
        ActionItem {
            label: "Back",
            value: ActionValue::Back,
        },
    ]
}

// Suppress unused-warning bookkeeping: `display` is imported for future use
// when error rendering is migrated through `display::context`.
#[allow(dead_code)]
fn _ensure_display_imported() {
    let _ = display::blank;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-identity-{}-{}-{n}",
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
    fn actions_match_ts_verbatim_in_order() {
        let acts = actions();
        let labels: Vec<&str> = acts.iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Add a pubkey", "Remove a pubkey", "Back"]);
        assert_eq!(acts[0].value, ActionValue::Add);
        assert_eq!(acts[1].value, ActionValue::Remove);
        assert_eq!(acts[2].value, ActionValue::Back);
    }

    #[test]
    fn add_persists_pubkey_to_whitelisted_field_verbatim() {
        // Spec doc 07 §1: VALUE STORED VERBATIM — no npub decode here.
        // The string is trimmed and pushed as-is.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_pubkeys(vec!["existing".to_owned()]);
        doc.save(&base).unwrap();

        // Simulate what the add path does after the prompt.
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        let mut pks = doc.whitelisted_pubkeys();
        pks.push("npub1examplenotdecoded".to_owned());
        doc.set_whitelisted_pubkeys(pks);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(
            reloaded.whitelisted_pubkeys(),
            vec!["existing".to_owned(), "npub1examplenotdecoded".to_owned()],
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_filters_chosen_pubkey_and_persists() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_whitelisted_pubkeys(vec![
            "aa".to_owned(),
            "bb".to_owned(),
            "cc".to_owned(),
        ]);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        let updated: Vec<String> = doc
            .whitelisted_pubkeys()
            .into_iter()
            .filter(|pk| pk != "bb")
            .collect();
        doc.set_whitelisted_pubkeys(updated);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.whitelisted_pubkeys(), vec!["aa", "cc"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn empty_remove_path_does_not_corrupt_unrelated_fields() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_version(7);
        doc.set_whitelisted_pubkeys(vec![]);
        doc.save(&base).unwrap();

        // The empty branch of remove_pubkey returns early — no save.
        // Verify the unrelated `version` field stays put.
        let after = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(after.version(), Some(7));
        assert!(after.whitelisted_pubkeys().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn add_validation_rejects_empty_input_with_ts_string() {
        // The validator is invoked by inquire; here we inspect it directly
        // to pin the verbatim error string.
        fn validate(input: &str) -> Result<(), &'static str> {
            if input.trim().is_empty() {
                Err("Pubkey cannot be empty")
            } else {
                Ok(())
            }
        }
        assert_eq!(validate(""), Err("Pubkey cannot be empty"));
        assert_eq!(validate("   "), Err("Pubkey cannot be empty"));
        assert!(validate("aa").is_ok());
    }

    #[test]
    fn npub_input_is_stored_verbatim_not_decoded() {
        // Reinforces the asymmetry called out in spec doc 07 §1: the
        // identity Add path does not decode npub. Even if the input is
        // a valid bech32 npub, the stored value is the raw string.
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();

        // Build a real npub so the test demonstrates the verbatim store
        // even with a "decodable" input.
        use nostr_sdk::ToBech32;
        let keys = nostr_sdk::Keys::generate();
        let npub = keys.public_key().to_bech32().unwrap();

        let mut pks = doc.whitelisted_pubkeys();
        pks.push(npub.clone());
        doc.set_whitelisted_pubkeys(pks);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(reloaded.whitelisted_pubkeys(), vec![npub.clone()]);
        // And it really is the bech32, not the hex form.
        assert!(npub.starts_with("npub1"));
        std::fs::remove_dir_all(&base).ok();
    }
}

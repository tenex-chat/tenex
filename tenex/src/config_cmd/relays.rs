//! `tenex config relays` — configure Nostr relay connections.
//!
//! Single-shot interaction (no menu loop): list current state, ask for one
//! action, perform it, return. The caller (the top-level config menu) is
//! responsible for the outer "show again on return" loop.
//!
//! Identity resolution (kind:0 fetches by `tenex-identity`) always uses
//! [`IDENTITY_PINNED_RELAY`] in addition to the configured `relays`. This
//! is enforced inside the identity daemon itself; the UI surfaces it as a
//! static info line so users understand where kind:0 traffic goes.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

/// Pinned relay for kind:0 identity events — always connected by
/// `tenex-identity` regardless of config. Mirrors the constant of the
/// same name in `crates/tenex-identity/src/lib.rs`.
const IDENTITY_PINNED_RELAY: &str = "wss://purplepag.es";

/// Run the relays submenu once. Returns immediately on Cancel.
pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let relays = doc.relays();

    render_listing(&relays);

    let action = match prompts::select("What do you want to do?", actions()).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("relay action prompt: {e}")),
    };

    match action.value {
        ActionValue::Add => add_relay(base_dir, &mut doc, relays)?,
        ActionValue::Remove => remove_relay(base_dir, &mut doc, relays)?,
        ActionValue::Back => {}
    }
    Ok(())
}

fn render_listing(relays: &[String]) {
    use crate::tui::theme::{chalk_cyan, chalk_dim};
    let cyan_bullet = chalk_cyan("●");
    println!("{}", chalk_dim("\n  Relays:"));
    if relays.is_empty() {
        println!("{}", chalk_dim("    No relays configured."));
    } else {
        for r in relays {
            println!("    {cyan_bullet} {r}");
        }
    }

    println!(
        "{}",
        chalk_dim(&format!(
            "\n  Identity events (kind:0) always go to {IDENTITY_PINNED_RELAY}."
        )),
    );
    println!();
}

fn add_relay(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    existing: Vec<String>,
) -> Result<()> {
    let trimmed = match prompt_relay_url("Relay URL (ws:// or wss://):") {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut updated = existing;
    updated.push(trimmed);
    doc.set_relays(updated);
    doc.save(base_dir)?;
    crate::tui::display::config_success("Relay added.");
    Ok(())
}

fn remove_relay(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    existing: Vec<String>,
) -> Result<()> {
    if existing.is_empty() {
        println!("{}", crate::tui::theme::chalk_dim("  Nothing to remove."));
        return Ok(());
    }
    let chosen = match prompt_select_relay("Remove which relay?", &existing) {
        Some(s) => s,
        None => return Ok(()),
    };
    let updated: Vec<String> = existing.into_iter().filter(|r| r != &chosen).collect();
    doc.set_relays(updated);
    doc.save(base_dir)?;
    crate::tui::display::config_success("Relay removed.");
    Ok(())
}

fn prompt_relay_url(message: &str) -> Option<String> {
    let validator = prompts::adapt_static_str_validator(|input: &str| {
        crate::types::relay::validate_config_screen(input).map(|_| ())
    });
    match prompts::input(message).with_validator(validator).prompt() {
        Ok(raw) => Some(raw.trim().to_owned()),
        Err(_) => None,
    }
}

fn prompt_select_relay(message: &str, options: &[String]) -> Option<String> {
    prompts::select(message, options.to_vec()).prompt().ok()
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
            label: "Add a relay",
            value: ActionValue::Add,
        },
        ActionItem {
            label: "Remove a relay",
            value: ActionValue::Remove,
        },
        ActionItem {
            label: "Back",
            value: ActionValue::Back,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_in_order() {
        let acts = actions();
        let labels: Vec<&str> = acts.iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Add a relay", "Remove a relay", "Back"]);
    }

    #[test]
    fn action_values_correspond_to_each_label() {
        let acts = actions();
        assert_eq!(acts[0].value, ActionValue::Add);
        assert_eq!(acts[1].value, ActionValue::Remove);
        assert_eq!(acts[2].value, ActionValue::Back);
    }

    #[test]
    fn identity_pinned_relay_constant_pinned() {
        assert_eq!(IDENTITY_PINNED_RELAY, "wss://purplepag.es");
    }

    #[test]
    fn cyan_bullet_byte_sequence() {
        assert_eq!(crate::tui::theme::chalk_cyan("●"), "\x1b[36m●\x1b[39m");
    }

    #[test]
    fn add_persists_relay_to_config_json() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_relays(vec!["wss://existing.example".to_owned()]);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        let mut relays = doc.relays();
        relays.push("wss://added.example".to_owned());
        doc.set_relays(relays);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(
            reloaded.relays(),
            vec!["wss://existing.example", "wss://added.example"]
        );
        cleanup(&base);
    }

    #[test]
    fn remove_filters_out_chosen_relay_and_persists() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_relays(vec![
            "wss://a.example".to_owned(),
            "wss://b.example".to_owned(),
            "wss://c.example".to_owned(),
        ]);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        let updated: Vec<String> = doc
            .relays()
            .into_iter()
            .filter(|r| r != "wss://b.example")
            .collect();
        doc.set_relays(updated);
        doc.save(&base).unwrap();

        let reloaded = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(
            reloaded.relays(),
            vec!["wss://a.example", "wss://c.example"]
        );
        cleanup(&base);
    }

    #[test]
    fn remove_when_list_empty_is_a_noop() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_version(7);
        doc.save(&base).unwrap();

        let doc = TenexConfigDoc::load(&base).unwrap();
        let relays = doc.relays();
        assert!(relays.is_empty());
        let after = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(after.version(), Some(7));
        cleanup(&base);
    }

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-relays-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn cleanup(p: &std::path::Path) {
        std::fs::remove_dir_all(p).ok();
    }
}

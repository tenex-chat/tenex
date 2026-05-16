//! `tenex config projects` — configure per-backend project filters and the
//! external-author routing flag.
//!
//! Three on-disk fields live in `config.json`:
//!
//! - `ignoredProjects`: project d-tags this backend will skip at boot.
//! - `onlyProjects`: allowlist applied before the `ignoredProjects`
//!   subtraction. Empty = no allowlist.
//! - `routeUnauthorizedAuthors`: when true, kind:1 events from authors
//!   outside `whitelistedPubkeys` are eligible for firewall + dispatch.
//!
//! Single-shot interaction (no menu loop): list current state, ask for one
//! action, perform it, return. The top-level config menu owns the outer
//! "show again on return" loop.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let ignored = doc.ignored_projects();
    let only = doc.only_projects();
    let route = doc.route_unauthorized_authors();

    render_listing(&ignored, &only, route);

    let action = match prompts::select("What do you want to do?", actions()).prompt() {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("projects action prompt: {e}")),
    };

    match action.value {
        ActionValue::EditIgnored => edit_list(
            base_dir,
            &mut doc,
            "ignoredProjects (comma-separated d-tags, empty to clear):",
            ignored,
            TenexConfigDoc::set_ignored_projects,
            "Ignored projects updated.",
        )?,
        ActionValue::EditOnly => edit_list(
            base_dir,
            &mut doc,
            "onlyProjects (comma-separated d-tags, empty to clear):",
            only,
            TenexConfigDoc::set_only_projects,
            "Only-projects allowlist updated.",
        )?,
        ActionValue::ToggleRoute => toggle_route(base_dir, &mut doc, route)?,
        ActionValue::Back => {}
    }
    Ok(())
}

fn render_listing(ignored: &[String], only: &[String], route: bool) {
    use crate::tui::theme::{chalk_cyan, chalk_dim};
    let cyan_bullet = chalk_cyan("●");
    println!("{}", chalk_dim("\n  ignoredProjects:"));
    if ignored.is_empty() {
        println!("{}", chalk_dim("    (none)"));
    } else {
        for d in ignored {
            println!("    {cyan_bullet} {d}");
        }
    }

    println!("{}", chalk_dim("\n  onlyProjects:"));
    if only.is_empty() {
        println!("{}", chalk_dim("    (none — serve every matching project)"));
    } else {
        for d in only {
            println!("    {cyan_bullet} {d}");
        }
    }

    println!(
        "{}\n",
        chalk_dim(&format!(
            "\n  routeUnauthorizedAuthors: {}",
            if route { "enabled" } else { "disabled" }
        )),
    );
}

fn edit_list(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    prompt: &str,
    current: Vec<String>,
    setter: fn(&mut TenexConfigDoc, Vec<String>),
    success_msg: &str,
) -> Result<()> {
    let raw = match prompts::input(prompt)
        .with_default(&current.join(", "))
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("list edit prompt: {e}")),
    };
    let parsed = parse_comma_list(&raw);
    setter(doc, parsed);
    doc.save(base_dir)?;
    crate::tui::display::config_success(success_msg);
    Ok(())
}

fn toggle_route(
    base_dir: &std::path::Path,
    doc: &mut TenexConfigDoc,
    current: bool,
) -> Result<()> {
    let prompt = if current {
        "routeUnauthorizedAuthors is enabled. Disable it?"
    } else {
        "routeUnauthorizedAuthors is disabled. Enable it?"
    };
    let confirmed = match prompts::confirm(prompt).with_default(false).prompt() {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("route toggle prompt: {e}")),
    };
    if !confirmed {
        return Ok(());
    }
    doc.set_route_unauthorized_authors(!current);
    doc.save(base_dir)?;
    crate::tui::display::config_success(if current {
        "routeUnauthorizedAuthors disabled."
    } else {
        "routeUnauthorizedAuthors enabled."
    });
    Ok(())
}

/// Split a comma-separated input into trimmed, non-empty entries while
/// preserving order and de-duplicating (first occurrence wins).
fn parse_comma_list(input: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in input.split(',') {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if !out.iter().any(|e| e == t) {
            out.push(t.to_owned());
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionValue {
    EditIgnored,
    EditOnly,
    ToggleRoute,
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
            label: "Edit ignoredProjects",
            value: ActionValue::EditIgnored,
        },
        ActionItem {
            label: "Edit onlyProjects",
            value: ActionValue::EditOnly,
        },
        ActionItem {
            label: "Toggle routeUnauthorizedAuthors",
            value: ActionValue::ToggleRoute,
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
    fn parse_comma_list_trims_and_dedupes() {
        assert_eq!(
            parse_comma_list("  a , b,a, ,c "),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
    }

    #[test]
    fn parse_comma_list_empty_returns_empty_vec() {
        assert!(parse_comma_list("").is_empty());
        assert!(parse_comma_list("   ,  ,").is_empty());
    }

    #[test]
    fn actions_in_canonical_order() {
        let labels: Vec<&str> = actions().iter().map(|a| a.label).collect();
        assert_eq!(
            labels,
            vec![
                "Edit ignoredProjects",
                "Edit onlyProjects",
                "Toggle routeUnauthorizedAuthors",
                "Back",
            ]
        );
    }
}

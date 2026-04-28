//! Onboarding Screen 2: Communication (relay choice).
//!
//! Spec: `tenex/docs/tui-port/01-cli-entrypoint-and-onboarding.md` §"Screen 2".
//! Source: `src/commands/onboard.ts:1336-1421`.
//!
//! Builds the [`RelayItem`] list (optional local relay + TENEX Community
//! Relay + free-text input row), runs the bespoke
//! [`crate::tui::custom_prompts::relay_prompt`], and returns the chosen URL.
//!
//! No persistence happens here — the parent state machine combines this
//! with the identity result and any carried-over fields, then commits via
//! [`crate::onboard::commit::commit_initial_config`].

use anyhow::{anyhow, Result};

use crate::tui::custom_prompts::{relay_prompt, RelayItem, RelayPromptConfig};
use crate::tui::display;
use crate::types::relay;

/// Run Screen 2. `local_relay_url` is the optional `--local-relay-url` CLI
/// arg; when present, a `Local relay` choice is prepended (so it lands as
/// the default-active row at index 0, matching `:1346-1353`).
///
/// Returns the chosen relay URL (always exactly one — `relays = [relay]`
/// per `:1379`) or `Ok(None)` if the user cancelled.
pub fn run(json_mode: bool, local_relay_url: Option<&str>) -> Result<Option<String>> {
    if !json_mode {
        display::step(2, 7, "Communication");
        display::context("Choose a relay for your agents to communicate through.");
        display::blank();
    }

    let items = build_items(local_relay_url);

    let cfg = RelayPromptConfig::new("Relay", items)
        .with_validator(|url: &str| relay::validate_onboard(url).map_err(str::to_owned));

    let chosen = relay_prompt(cfg)
        .map_err(|e| anyhow!("relay prompt I/O: {e}"))?;
    Ok(chosen)
}

/// Construct the relay-prompt item list per `:1343-1358`. Pure function so
/// the ordering can be unit-tested without any I/O.
pub fn build_items(local_relay_url: Option<&str>) -> Vec<RelayItem> {
    let mut items = Vec::with_capacity(3);

    if let Some(url) = local_relay_url {
        items.push(RelayItem::Choice {
            name: "Local relay".to_owned(),
            value: url.to_owned(),
            description: url.to_owned(),
        });
    }

    items.push(RelayItem::Choice {
        name: "TENEX Community Relay".to_owned(),
        value: "wss://tenex.chat".to_owned(),
        description: "wss://tenex.chat".to_owned(),
    });

    items.push(RelayItem::Input);

    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_choice(item: &RelayItem, expected_name: &str) -> bool {
        matches!(item, RelayItem::Choice { name, .. } if name == expected_name)
    }

    fn is_input(item: &RelayItem) -> bool {
        matches!(item, RelayItem::Input)
    }

    #[test]
    fn items_without_local_relay_have_two_entries() {
        let items = build_items(None);
        assert_eq!(items.len(), 2);
        assert!(is_choice(&items[0], "TENEX Community Relay"));
        assert!(is_input(&items[1]));
    }

    #[test]
    fn items_with_local_relay_prepend_local_first() {
        let items = build_items(Some("wss://my-local"));
        assert_eq!(items.len(), 3);
        assert!(is_choice(&items[0], "Local relay"));
        assert!(is_choice(&items[1], "TENEX Community Relay"));
        assert!(is_input(&items[2]));
    }

    #[test]
    fn local_relay_value_and_description_match_url() {
        let items = build_items(Some("wss://my-local"));
        match &items[0] {
            RelayItem::Choice { name, value, description } => {
                assert_eq!(name, "Local relay");
                assert_eq!(value, "wss://my-local");
                assert_eq!(description, "wss://my-local");
            }
            _ => panic!("expected Choice"),
        }
    }

    #[test]
    fn community_relay_value_pinned_to_tenex_chat() {
        // Sanity-check the hardcoded community relay value (`:1356`).
        let items = build_items(None);
        match &items[0] {
            RelayItem::Choice { value, description, .. } => {
                assert_eq!(value, "wss://tenex.chat");
                assert_eq!(description, "wss://tenex.chat");
            }
            _ => panic!("expected Choice"),
        }
    }
}

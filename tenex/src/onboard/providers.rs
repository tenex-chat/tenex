//! Onboarding Screen 3 (sub-step B): interactive provider setup.
//!
//! Source: `src/llm/utils/provider-setup.ts:25-110`. Wraps the bespoke
//! [`crate::tui::custom_prompts::provider_select_prompt`] in a loop that
//! handles the password-resume cycle: when the user toggles a provider on
//! (or asks to add another key), the bespoke prompt emits a
//! [`ProviderSelectResult::NeedKey`], this driver opens the appropriate
//! input/password prompt, appends the result to the in-memory state, and
//! re-enters the bespoke prompt with `mode = return_to`.
//!
//! On `Done`, the driver mirrors the in-memory state back into the
//! [`ProvidersDoc`] (preserving every non-`apiKey` field for unchanged
//! provider entries — that's important: `baseUrl`, `timeout`, and `options`
//! must round-trip without loss) and returns the doc for the caller to
//! persist.
//!
//! The auto-detected hints map (e.g. `via claude setup-token` for Anthropic
//! when only the Claude CLI is present) is threaded through unchanged.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;

use crate::store::providers::ProvidersDoc;
use crate::tui::custom_prompts::{
    provider_select_prompt, ApiKeyValue, ProviderCredentialsLite, ProviderMode,
    ProviderSelectResult, ProviderState,
};
use crate::tui::prompts;

const PROVIDER_ID_OLLAMA: &str = "ollama";

/// Fixed catalog of provider IDs in display order. Source:
/// `src/llm/types.ts:28-35` `AI_SDK_PROVIDERS`. Mirrored here verbatim.
pub const PROVIDER_IDS: &[&str] = &[
    "openrouter",
    "anthropic",
    "openai",
    "ollama",
    "codex",
    "claude-code",
];

/// Result of running the provider setup loop.
#[derive(Debug, Clone)]
pub enum ProviderSetupResult {
    /// User confirmed Done; `doc` carries the new state.
    Configured(ProvidersDoc),
    /// User pressed Ctrl-C / Esc.
    Cancelled,
}

/// Drive the loop until the user confirms Done or cancels.
pub fn run(
    starting_doc: ProvidersDoc,
    provider_hints: HashMap<String, String>,
) -> Result<ProviderSetupResult> {
    let provider_ids: Vec<String> = PROVIDER_IDS.iter().map(|s| (*s).to_owned()).collect();
    let hints: IndexMap<String, String> = provider_hints.into_iter().collect();

    let mut starting_doc = starting_doc;
    let mut resume_state: Option<ProviderState> = Some(state_from_doc(&starting_doc));

    loop {
        let result = provider_select_prompt(
            "Configure providers:",
            &provider_ids,
            &hints,
            resume_state.take(),
        )
        .map_err(|e| anyhow!("provider-select prompt I/O: {e}"))?;

        match result {
            ProviderSelectResult::Cancelled => return Ok(ProviderSetupResult::Cancelled),
            ProviderSelectResult::Done(providers_map) => {
                let final_doc = mirror_into_doc(starting_doc, &providers_map);
                return Ok(ProviderSetupResult::Configured(final_doc));
            }
            ProviderSelectResult::NeedKey {
                state,
                provider_id,
                return_to,
            } => {
                let display_name = display_name_for(&provider_id);
                let hint = hints.get(&provider_id).map(String::as_str);
                let entered = ask_for_key(&provider_id, &display_name, hint)?;

                let mut next_state = state;
                if let Some(serialized) = entered {
                    append_key(&mut next_state.providers, &provider_id, serialized);
                }

                next_state.mode = return_to;
                next_state.keys_target = match return_to {
                    ProviderMode::Keys => Some(provider_id),
                    ProviderMode::Browse => None,
                };
                next_state.keys_active = 0;

                // The bespoke prompt's resume entry-point persists `providers`
                // on its own. The starting doc only matters when the user
                // confirms Done — we mirror at that point.
                starting_doc = mirror_into_doc(starting_doc, &next_state.providers);
                resume_state = Some(next_state);
            }
        }
    }
}

/// Convert the persistence-layer doc into the prompt's owned in-memory
/// state. Drops `baseUrl`/`timeout`/`options` — the bespoke prompt only
/// mutates `api_key`; we re-attach the full credential shape on Done via
/// [`mirror_into_doc`].
fn state_from_doc(doc: &ProvidersDoc) -> ProviderState {
    let mut providers: IndexMap<String, ProviderCredentialsLite> = IndexMap::new();
    for pid in doc.provider_ids() {
        let entry = match doc.get(&pid) {
            Some(e) => e,
            None => continue,
        };
        let keys = entry.api_keys();
        let api_key = if keys.len() == 1 {
            ApiKeyValue::Single(keys.into_iter().next().expect("len == 1"))
        } else if keys.is_empty() {
            // Preserve "" / "none" sentinel values verbatim so toggling
            // codex/claude-code in the prompt sees the existing entry.
            let raw_first = entry
                .raw()
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ApiKeyValue::Single(raw_first.to_owned())
        } else {
            ApiKeyValue::Multiple(keys)
        };
        providers.insert(pid, ProviderCredentialsLite { api_key });
    }
    ProviderState::new(providers)
}

/// Apply the prompt's in-memory state back to the persistence doc.
///
/// - Providers in `state` but not in `doc` → inserted via `set_api_keys`.
/// - Providers in `state` AND in `doc` → `set_api_keys` (which preserves
///   `baseUrl`, `timeout`, `options` field positions).
/// - Providers in `doc` but not in `state` → removed.
fn mirror_into_doc(
    mut doc: ProvidersDoc,
    state: &IndexMap<String, ProviderCredentialsLite>,
) -> ProvidersDoc {
    let existing: Vec<String> = doc.provider_ids();
    for pid in &existing {
        if !state.contains_key(pid) {
            doc.remove(pid);
        }
    }
    for (pid, creds) in state {
        let keys = match &creds.api_key {
            ApiKeyValue::Single(s) => vec![s.clone()],
            ApiKeyValue::Multiple(v) => v.clone(),
        };
        doc.set_api_keys(pid, keys);
    }
    doc
}

fn append_key(
    providers: &mut IndexMap<String, ProviderCredentialsLite>,
    provider_id: &str,
    serialized: String,
) {
    let existing = providers
        .shift_remove(provider_id)
        .map(|c| c.api_key)
        .unwrap_or_else(|| ApiKeyValue::Multiple(Vec::new()));

    let mut entries: Vec<String> = match existing {
        ApiKeyValue::Single(s) if s.is_empty() => Vec::new(),
        ApiKeyValue::Single(s) => vec![s],
        ApiKeyValue::Multiple(v) => v,
    };
    // Strip "" / "none" sentinels so a real key replaces them rather than
    // joining a multi-key list — matches `getApiKeyEntries` filtering at
    // `src/llm/providers/key-manager.ts:312-313`.
    entries.retain(|e| {
        let head = e.split_whitespace().next().unwrap_or("");
        !head.is_empty() && head != "none"
    });
    entries.push(serialized);

    let api_key = if entries.len() == 1 {
        ApiKeyValue::Single(entries.into_iter().next().expect("len==1"))
    } else {
        ApiKeyValue::Multiple(entries)
    };
    providers.insert(
        provider_id.to_owned(),
        ProviderCredentialsLite { api_key },
    );
}

fn display_name_for(provider_id: &str) -> String {
    crate::tui::custom_prompts::provider_select_prompt::provider_display_name(provider_id)
        .to_owned()
}

/// TS at `provider-setup.ts:89` emits:
///
/// ```ts
/// console.log(chalk.dim(`  Run ${chalk.bold("claude setup-token")} in another terminal, then paste the key (sk-ant-...) here.`))
/// ```
///
/// Chalk's literal output is
/// `\x1b[2m  Run \x1b[1mclaude setup-token\x1b[22m in another terminal, then paste the key (sk-ant-...) here.\x1b[22m`
/// — `chalk.bold`'s close (`\x1b[22m`) is the SGR-22 reset that turns
/// OFF both bold AND dim, so the trailing tail after `claude setup-token`
/// renders plain (not dim) and the outer `chalk.dim` close is a no-op.
/// Mirror byte-for-byte.
fn format_claude_setup_token_hint() -> String {
    use crate::tui::theme::{BOLD_CLOSE, BOLD_OPEN, DIM_CLOSE, DIM_OPEN};
    format!(
        "{DIM_OPEN}  Run {BOLD_OPEN}claude setup-token{BOLD_CLOSE} in another terminal, then paste the key (sk-ant-...) here.{DIM_CLOSE}",
    )
}

/// TS at `provider-setup.ts:105` emits:
///
/// ```ts
/// message: `${displayName} label ${chalk.dim("(optional)")}:`
/// ```
///
/// The parenthesised hint is the only dim-wrapped portion; everything
/// else is plain. Mirror byte-for-byte: `<displayName> label \x1b[2m(optional)\x1b[22m:`.
fn format_label_prompt(display_name: &str) -> String {
    use crate::tui::theme::{DIM_CLOSE, DIM_OPEN};
    format!("{display_name} label {DIM_OPEN}(optional){DIM_CLOSE}:")
}

/// Open the appropriate input prompt for `provider_id`. Returns
/// `Some(serialized)` if the user entered a value (key + optional label
/// joined by a single space, per `serializeApiKeyEntry`), or `None` if the
/// user left the key blank.
///
/// Source: `src/llm/utils/provider-setup.ts:77-110`.
pub fn ask_for_key(
    provider_id: &str,
    display_name: &str,
    hint: Option<&str>,
) -> Result<Option<String>> {
    let value: Option<String> = if provider_id == PROVIDER_ID_OLLAMA {
        let msg = format!("{display_name} URL:");
        let raw = prompts::input(&msg)
            .with_default("http://localhost:11434")
            .prompt()
            .map_err(|e| anyhow!("ollama URL prompt: {e}"))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    } else {
        if let Some(_h) = hint {
            println!("{}", format_claude_setup_token_hint());
        }
        let msg = format!("{display_name} API key:");
        let raw = prompts::password(&msg)
            .prompt()
            .map_err(|e| anyhow!("{display_name} api-key prompt: {e}"))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    };

    let Some(value) = value else { return Ok(None) };

    // TS at provider-setup.ts:105 emits:
    //   message: `${displayName} label ${chalk.dim("(optional)")}:`
    // — the parenthesised hint is dim while the rest of the prompt is
    // plain. Mirror byte-for-byte by embedding the dim escapes.
    let label_msg = format_label_prompt(display_name);
    let label_raw = prompts::input(&label_msg)
        .prompt()
        .map_err(|e| anyhow!("{display_name} label prompt: {e}"))?;
    let label = label_raw.trim();

    Ok(Some(crate::store::api_keys::serialize_api_key_entry(
        &value,
        Some(label),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_with(providers: &[(&str, &[&str])]) -> ProvidersDoc {
        let mut d = ProvidersDoc::new();
        for (pid, keys) in providers {
            let owned: Vec<String> = keys.iter().map(|s| (*s).to_owned()).collect();
            d.set_api_keys(pid, owned);
        }
        d
    }

    fn state(providers: &[(&str, ApiKeyValue)]) -> IndexMap<String, ProviderCredentialsLite> {
        let mut m = IndexMap::new();
        for (pid, ak) in providers {
            m.insert(
                (*pid).to_owned(),
                ProviderCredentialsLite { api_key: ak.clone() },
            );
        }
        m
    }

    #[test]
    fn provider_ids_match_ai_sdk_providers_order() {
        // `src/llm/types.ts:28-35` — the canonical 6-provider list.
        assert_eq!(
            PROVIDER_IDS,
            &["openrouter", "anthropic", "openai", "ollama", "codex", "claude-code"]
        );
    }

    // serialize_api_key_entry tests live in `store::api_keys::tests` —
    // this module no longer has its own copy of the function.

    #[test]
    fn state_from_doc_lifts_single_key_into_apikeyvalue_single() {
        let doc = doc_with(&[("anthropic", &["sk-1"])]);
        let st = state_from_doc(&doc);
        let entry = st.providers.get("anthropic").unwrap();
        assert_eq!(entry.api_key, ApiKeyValue::Single("sk-1".to_owned()));
    }

    #[test]
    fn state_from_doc_lifts_multiple_keys_into_apikeyvalue_multiple() {
        let doc = doc_with(&[("anthropic", &["sk-1", "sk-2"])]);
        let st = state_from_doc(&doc);
        let entry = st.providers.get("anthropic").unwrap();
        assert_eq!(
            entry.api_key,
            ApiKeyValue::Multiple(vec!["sk-1".to_owned(), "sk-2".to_owned()])
        );
    }

    #[test]
    fn state_from_doc_preserves_none_sentinel_for_codex() {
        let doc = doc_with(&[("codex", &["none"])]);
        let st = state_from_doc(&doc);
        let entry = st.providers.get("codex").unwrap();
        // Sentinel rendered as Single("none") so the bespoke prompt sees the
        // entry as "enabled, no real key" (entries() filters it out internally).
        assert_eq!(entry.api_key, ApiKeyValue::Single("none".to_owned()));
    }

    #[test]
    fn mirror_into_doc_inserts_new_provider() {
        let doc = ProvidersDoc::new();
        let st = state(&[(
            "anthropic",
            ApiKeyValue::Single("sk-1".to_owned()),
        )]);
        let updated = mirror_into_doc(doc, &st);
        let entry = updated.get("anthropic").unwrap();
        assert_eq!(entry.api_keys(), vec!["sk-1".to_owned()]);
    }

    #[test]
    fn mirror_into_doc_removes_provider_absent_from_state() {
        let doc = doc_with(&[
            ("anthropic", &["sk-1"]),
            ("openai", &["sk-o"]),
        ]);
        let st = state(&[(
            "anthropic",
            ApiKeyValue::Single("sk-1".to_owned()),
        )]);
        let updated = mirror_into_doc(doc, &st);
        assert!(updated.get("openai").is_none());
        assert!(updated.get("anthropic").is_some());
    }

    #[test]
    fn mirror_into_doc_collapses_array_to_string_when_one_remains() {
        let doc = doc_with(&[("anthropic", &["k1", "k2", "k3"])]);
        let st = state(&[(
            "anthropic",
            ApiKeyValue::Multiple(vec!["only".to_owned()]),
        )]);
        let updated = mirror_into_doc(doc, &st);
        let entry = updated.get("anthropic").unwrap();
        // The persistence layer collapses 1 key to a bare string.
        assert_eq!(entry.api_keys(), vec!["only".to_owned()]);
    }

    #[test]
    fn append_key_to_empty_provider_inserts_single() {
        let mut providers = state(&[]);
        append_key(&mut providers, "anthropic", "sk-new".into());
        match &providers["anthropic"].api_key {
            ApiKeyValue::Single(s) => assert_eq!(s, "sk-new"),
            other => panic!("expected Single, got {other:?}"),
        }
    }

    #[test]
    fn append_key_to_provider_with_one_key_promotes_to_multiple() {
        let mut providers = state(&[(
            "anthropic",
            ApiKeyValue::Single("sk-old".to_owned()),
        )]);
        append_key(&mut providers, "anthropic", "sk-new".into());
        match &providers["anthropic"].api_key {
            ApiKeyValue::Multiple(v) => {
                assert_eq!(v, &vec!["sk-old".to_owned(), "sk-new".to_owned()]);
            }
            other => panic!("expected Multiple, got {other:?}"),
        }
    }

    #[test]
    fn append_key_strips_none_sentinel_before_appending() {
        let mut providers = state(&[(
            "codex",
            ApiKeyValue::Single("none".to_owned()),
        )]);
        append_key(&mut providers, "codex", "sk-real".into());
        match &providers["codex"].api_key {
            ApiKeyValue::Single(s) => assert_eq!(s, "sk-real"),
            other => panic!("expected Single after sentinel strip, got {other:?}"),
        }
    }

    #[test]
    fn append_key_appends_to_existing_array() {
        let mut providers = state(&[(
            "anthropic",
            ApiKeyValue::Multiple(vec!["k1".into(), "k2".into()]),
        )]);
        append_key(&mut providers, "anthropic", "k3".into());
        match &providers["anthropic"].api_key {
            ApiKeyValue::Multiple(v) => {
                assert_eq!(v, &vec!["k1".to_owned(), "k2".to_owned(), "k3".to_owned()]);
            }
            other => panic!("expected Multiple, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_state_preserves_disk_order_of_providers() {
        // `provider_ids()` already preserves insertion order on the doc;
        // confirm the lift+mirror path keeps it stable.
        let doc = doc_with(&[
            ("openrouter", &["a"]),
            ("ollama", &["http://localhost:11434"]),
            ("anthropic", &["b"]),
        ]);
        let st = state_from_doc(&doc);
        let order: Vec<String> = st.providers.keys().cloned().collect();
        assert_eq!(order, vec!["openrouter", "ollama", "anthropic"]);

        // And mirror back — output should preserve the same order.
        let updated = mirror_into_doc(ProvidersDoc::new(), &st.providers);
        assert_eq!(updated.provider_ids(), vec!["openrouter", "ollama", "anthropic"]);
    }

    /// Pin the `claude setup-token` hint line byte-for-byte against the
    /// chalk output of `provider-setup.ts:89`.
    #[test]
    fn claude_setup_token_hint_matches_ts_chalk_byte_sequence() {
        let s = format_claude_setup_token_hint();
        assert_eq!(
            s,
            "\x1b[2m  Run \x1b[1mclaude setup-token\x1b[22m in another terminal, then paste the key (sk-ant-...) here.\x1b[22m",
        );
    }

    #[test]
    fn claude_setup_token_hint_ansi_stripped_text_is_verbatim_ts() {
        use console::strip_ansi_codes;
        let s = format_claude_setup_token_hint();
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(
            plain,
            "  Run claude setup-token in another terminal, then paste the key (sk-ant-...) here.",
        );
    }

    /// Pin the per-provider label prompt against TS chalk output of
    /// `provider-setup.ts:105`. The dim wrap is on `(optional)` only.
    #[test]
    fn label_prompt_dim_wraps_only_the_optional_hint() {
        let s = format_label_prompt("Anthropic");
        assert_eq!(s, "Anthropic label \x1b[2m(optional)\x1b[22m:");
    }

    #[test]
    fn label_prompt_ansi_stripped_text_is_verbatim_ts() {
        use console::strip_ansi_codes;
        let s = format_label_prompt("OpenRouter");
        let plain = strip_ansi_codes(&s).into_owned();
        assert_eq!(plain, "OpenRouter label (optional):");
    }
}

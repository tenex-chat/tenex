use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use indexmap::IndexMap;
use inquire::Select;
use nostr::Filter;
use nostr::Kind;
use nostr_sdk::nips::nip19::{FromBech32, Nip19};
use nostr_sdk::Client;
use serde_json::Value;

use crate::store::providers::ProvidersDoc;
use crate::store::tenex_config::TenexConfigDoc;
use tenex_agent_registry::{generate_nsec_bech32, AgentDoc, AgentStorage};

const KIND_AGENT_DEFINITION: u16 = 4199;
const KIND_TEAM_DEFINITION: u16 = 34199;
const FETCH_TIMEOUT_SECS: u64 = 8;

pub async fn run(base_dir: &std::path::Path, nevent: &str) -> Result<()> {
    // 1. Decode nevent1 bech32 → event_id + relay hints
    let decoded =
        Nip19::from_bech32(nevent).with_context(|| format!("invalid bech32: {nevent}"))?;

    let (event_id, hint_relays) = match decoded {
        Nip19::Event(nev) => {
            let hints: Vec<String> = nev.relays.iter().map(|r| r.to_string()).collect();
            (nev.event_id, hints)
        }
        other => {
            let name = match &other {
                Nip19::Pubkey(_) => "npub",
                Nip19::Profile(_) => "nprofile",
                Nip19::EventId(_) => "note",
                Nip19::Coordinate(_) => "naddr",
                Nip19::Secret(_) => "nsec",
                Nip19::Event(_) => unreachable!(),
            };
            bail!("expected nevent1, got {name}");
        }
    };

    // 2. Build relay list: hints ∪ configured relays
    let config = TenexConfigDoc::load(base_dir)?;
    let configured = {
        let r = config.relays();
        if r.is_empty() {
            vec!["wss://relay.tenex.chat".to_string()]
        } else {
            r
        }
    };
    let mut relays: Vec<String> = hint_relays;
    for r in &configured {
        if !relays.contains(r) {
            relays.push(r.clone());
        }
    }

    // 3. Connect to relays
    let keys = crate::nostr_pub::backend_signer::ensure_backend_keys(base_dir)
        .context("loading relay signer")?;
    let client = Client::new(keys);
    for relay in &relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add relay {relay}"))?;
    }
    client.connect().await;

    // 4. Fetch the root event — no kind filter so we can route on it
    let filter = Filter::new().id(event_id).limit(1);
    let events = client
        .fetch_events(filter, Duration::from_secs(FETCH_TIMEOUT_SECS))
        .await
        .context("fetch root event")?;

    let event = events
        .first()
        .ok_or_else(|| anyhow!("event not found: {}", event_id.to_hex()))?;

    let kind = event.kind.as_u16();

    match kind {
        KIND_AGENT_DEFINITION => {
            let pubkey = install_agent(base_dir, event, &client, &relays).await?;
            let _ = pubkey;
        }
        KIND_TEAM_DEFINITION => {
            install_team(base_dir, event, &client, &relays).await?;
        }
        other => {
            client.disconnect().await;
            bail!("expected kind:{KIND_AGENT_DEFINITION} or kind:{KIND_TEAM_DEFINITION}, got kind:{other}");
        }
    }

    client.disconnect().await;

    // 5. Best-effort inventory publish
    if let Err(e) =
        crate::nostr_pub::installed_agents::publish_installed_agents_inventory(base_dir).await
    {
        eprintln!(
            "{}",
            crate::tui::theme::chalk_yellow(&format!(
                "Warning: failed to publish agent inventory: {e}"
            ))
        );
    }

    Ok(())
}

/// Install a single kind:4199 agent definition event.
/// Returns the installed agent's pubkey.
async fn install_agent(
    base_dir: &std::path::Path,
    event: &nostr::Event,
    _client: &Client,
    _relays: &[String],
) -> Result<String> {
    let get_tag = |name: &str| -> Option<String> {
        event.tags.iter().find_map(|t| {
            let parts: Vec<String> = t.clone().to_vec();
            if parts.first().map(|s| s.as_str()) == Some(name) {
                parts.get(1).filter(|v| !v.is_empty()).map(|v| v.clone())
            } else {
                None
            }
        })
    };

    let title = get_tag("title")
        .ok_or_else(|| anyhow!("agent definition event missing required 'title' tag"))?;
    let description = get_tag("description").unwrap_or_default();
    let role = get_tag("role").unwrap_or_else(|| "assistant".to_string());
    let instructions = get_tag("instructions").unwrap_or_default();
    let use_criteria = get_tag("use-criteria").unwrap_or_default();
    let category = get_tag("category");
    let d_tag = get_tag("d");

    // Prefer d-tag as slug; fall back to kebab-case of title
    let slug = d_tag.clone().unwrap_or_else(|| to_kebab_case(&title));
    let event_id_hex = event.id.to_hex();

    let mut storage = AgentStorage::open(base_dir)?;

    // Fix: idempotent reinstall — return existing pubkey if same event already installed
    if let Some(existing_pubkey) = storage.index().by_event_id().get(&event_id_hex).cloned() {
        println!(
            "{}",
            crate::tui::theme::chalk_dim(&format!(
                "Already installed: '{title}' ({slug}) — pubkey: {existing_pubkey}"
            ))
        );
        return Ok(existing_pubkey);
    }

    // Check for slug conflict (different event, same slug)
    if storage.slug_exists(&slug) {
        let existing = storage.get_agent_by_slug(&slug)?;
        if let Some(existing_agent) = existing {
            let existing_instructions = existing_agent.instructions().unwrap_or("").to_string();
            let resolution = resolve_slug_conflict(
                base_dir,
                &slug,
                existing_agent.name().unwrap_or(&slug),
                &existing_instructions,
                &title,
                &instructions,
                &event_id_hex,
            )
            .await?;

            match resolution {
                SlugResolution::Skip => {
                    println!(
                        "{}",
                        crate::tui::theme::chalk_yellow(&format!("Skipped '{title}' ({slug})"))
                    );
                    let pubkey = storage
                        .index()
                        .by_slug()
                        .get(&slug)
                        .map(|e| e.pubkey.clone())
                        .unwrap_or_default();
                    return Ok(pubkey);
                }
                SlugResolution::Overwrite => {
                    if let Some(old_pubkey) = storage
                        .index()
                        .by_slug()
                        .get(&slug)
                        .map(|e| e.pubkey.clone())
                    {
                        storage.delete_agent(&old_pubkey)?;
                    }
                }
                SlugResolution::Rename(new_slug) => {
                    // Fix: validate the renamed slug is non-empty and unoccupied
                    if new_slug.is_empty() {
                        bail!("slug cannot be empty");
                    }
                    if storage.slug_exists(&new_slug) {
                        bail!("slug '{new_slug}' is already in use");
                    }
                    drop(storage);
                    return install_agent_with_slug(
                        base_dir,
                        event,
                        &title,
                        &new_slug,
                        &description,
                        &role,
                        &instructions,
                        &use_criteria,
                        category.as_deref(),
                        d_tag.as_deref(),
                        &event_id_hex,
                        event.pubkey.to_hex(),
                        event.created_at.as_secs(),
                    );
                }
            }
        }
    }
    drop(storage);

    install_agent_with_slug(
        base_dir,
        event,
        &title,
        &slug,
        &description,
        &role,
        &instructions,
        &use_criteria,
        category.as_deref(),
        d_tag.as_deref(),
        &event_id_hex,
        event.pubkey.to_hex(),
        event.created_at.as_secs(),
    )
}

#[allow(clippy::too_many_arguments)]
fn install_agent_with_slug(
    base_dir: &std::path::Path,
    _event: &nostr::Event,
    title: &str,
    slug: &str,
    description: &str,
    role: &str,
    instructions: &str,
    use_criteria: &str,
    category: Option<&str>,
    d_tag: Option<&str>,
    event_id_hex: &str,
    definition_author: String,
    definition_created_at: u64,
) -> Result<String> {
    let nsec = generate_nsec_bech32().context("generate nsec")?;

    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String(nsec));
    raw.insert("slug".into(), Value::String(slug.to_owned()));
    raw.insert("name".into(), Value::String(title.to_owned()));
    raw.insert("role".into(), Value::String(role.to_owned()));
    raw.insert("status".into(), Value::String("active".into()));

    if !description.is_empty() {
        raw.insert("description".into(), Value::String(description.to_owned()));
    }
    if !instructions.is_empty() {
        raw.insert(
            "instructions".into(),
            Value::String(instructions.to_owned()),
        );
    }
    if !use_criteria.is_empty() {
        raw.insert("useCriteria".into(), Value::String(use_criteria.to_owned()));
    }
    if let Some(cat) = category {
        raw.insert("category".into(), Value::String(cat.to_owned()));
    }

    // Definition provenance for future upgrade tracking
    raw.insert("eventId".into(), Value::String(event_id_hex.to_owned()));
    if let Some(dtag) = d_tag {
        raw.insert("definitionDTag".into(), Value::String(dtag.to_owned()));
    }
    raw.insert("definitionAuthor".into(), Value::String(definition_author));
    raw.insert(
        "definitionCreatedAt".into(),
        Value::Number(definition_created_at.into()),
    );

    let mut storage = AgentStorage::open(base_dir)?;
    let pubkey = storage.save_agent(&AgentDoc::from_raw(raw))?;

    println!(
        "{}",
        crate::tui::theme::chalk_green(&format!(
            "✓ Installed '{title}' ({slug}) — pubkey: {pubkey}"
        ))
    );

    Ok(pubkey)
}

/// Install a kind:34199 team definition event.
/// Fetches each referenced 4199 event and installs them in order.
/// The first `e`-tagged agent is the team default.
async fn install_team(
    base_dir: &std::path::Path,
    event: &nostr::Event,
    client: &Client,
    relays: &[String],
) -> Result<()> {
    let title = event.tags.iter().find_map(|t| {
        let parts: Vec<String> = t.clone().to_vec();
        if parts.first().map(|s| s.as_str()) == Some("title") {
            parts.get(1).filter(|v| !v.is_empty()).map(|v| v.clone())
        } else {
            None
        }
    });

    // Extract all e-tags: (event_id, optional relay hint)
    let agent_refs: Vec<(String, Option<String>)> = event
        .tags
        .iter()
        .filter_map(|t| {
            let parts: Vec<String> = t.clone().to_vec();
            if parts.first().map(|s| s.as_str()) != Some("e") {
                return None;
            }
            let event_id = parts.get(1)?.clone();
            if event_id.is_empty() {
                return None;
            }
            let relay_hint = parts.get(2).filter(|r| !r.is_empty()).map(|r| r.clone());
            Some((event_id, relay_hint))
        })
        .collect();

    if agent_refs.is_empty() {
        bail!("team definition event has no agent references (no e-tags)");
    }

    if let Some(ref t) = title {
        println!(
            "{}",
            crate::tui::theme::chalk_blue(&format!("Installing team '{t}'…"))
        );
    }

    // Fetch and install each agent in order; first one is the default
    for (i, (agent_event_id, relay_hint)) in agent_refs.iter().enumerate() {
        let event_id = nostr::EventId::from_hex(agent_event_id)
            .with_context(|| format!("invalid event id in team e-tag: {agent_event_id}"))?;

        // Fix: add relay hint from the e-tag before fetching so member agents
        // on hint-only relays are reachable
        if let Some(hint) = relay_hint {
            let _ = client.add_relay(hint.as_str()).await;
        }

        let filter = Filter::new()
            .id(event_id)
            .kind(Kind::Custom(KIND_AGENT_DEFINITION))
            .limit(1);

        let events = client
            .fetch_events(filter, Duration::from_secs(FETCH_TIMEOUT_SECS))
            .await
            .with_context(|| format!("fetch agent event {agent_event_id}"))?;

        match events.first() {
            None => {
                eprintln!(
                    "{}",
                    crate::tui::theme::chalk_yellow(&format!(
                        "Warning: agent event {agent_event_id} not found on relays — skipping"
                    ))
                );
            }
            Some(agent_event) => {
                if i == 0 {
                    println!("{}", crate::tui::theme::chalk_blue("  (default agent)"));
                }
                install_agent(base_dir, agent_event, client, relays).await?;
            }
        }
    }

    Ok(())
}

enum SlugResolution {
    Skip,
    Overwrite,
    Rename(String),
}

/// Present the slug conflict UI and return the user's chosen resolution.
async fn resolve_slug_conflict(
    base_dir: &std::path::Path,
    slug: &str,
    existing_name: &str,
    existing_instructions: &str,
    new_name: &str,
    new_instructions: &str,
    new_event_id: &str,
) -> Result<SlugResolution> {
    println!(
        "{}",
        crate::tui::theme::chalk_yellow(&format!(
            "Slug conflict: '{slug}' already exists (agent '{existing_name}')"
        ))
    );
    println!(
        "{}",
        crate::tui::theme::chalk_yellow(&format!("New agent:      '{new_name}' ({new_event_id})")),
    );

    // Show a diff of the system prompts (LLM-generated if key available, text otherwise)
    let diff_text = generate_instructions_diff(
        base_dir,
        existing_name,
        existing_instructions,
        new_name,
        new_instructions,
    )
    .await;

    println!("\n{diff_text}\n");

    let options = vec![
        "Skip — keep existing agent, discard new one",
        "Overwrite — replace existing agent with new one",
        "Rename — install new agent under a different slug",
    ];

    let choice = Select::new("How should this conflict be resolved?", options)
        .prompt()
        .map_err(|e| anyhow!("prompt cancelled: {e}"))?;

    if choice.starts_with("Skip") {
        Ok(SlugResolution::Skip)
    } else if choice.starts_with("Overwrite") {
        Ok(SlugResolution::Overwrite)
    } else {
        let new_slug = inquire::Text::new(&format!("New slug for '{new_name}':"))
            .with_initial_value(&format!("{slug}-2"))
            .prompt()
            .map_err(|e| anyhow!("prompt cancelled: {e}"))?;
        Ok(SlugResolution::Rename(new_slug.trim().to_string()))
    }
}

/// Generate a human-readable comparison of two sets of agent instructions.
/// Uses the configured OpenRouter key for an LLM summary when available;
/// falls back to a plain-text excerpt comparison.
async fn generate_instructions_diff(
    base_dir: &std::path::Path,
    existing_name: &str,
    existing_instructions: &str,
    new_name: &str,
    new_instructions: &str,
) -> String {
    if existing_instructions == new_instructions {
        return "System prompts are identical.".to_string();
    }

    // Try LLM-generated diff via OpenRouter
    if let Ok(providers) = ProvidersDoc::load(base_dir) {
        if let Some(entry) = providers.get("openrouter") {
            if let Some(key) = entry.api_keys().into_iter().next() {
                if !key.is_empty() && key != "none" {
                    if let Ok(summary) = llm_diff_summary(
                        &key,
                        existing_name,
                        existing_instructions,
                        new_name,
                        new_instructions,
                    )
                    .await
                    {
                        return summary;
                    }
                }
            }
        }
    }

    // Plain-text fallback: show abbreviated excerpts
    plain_text_diff(
        existing_name,
        existing_instructions,
        new_name,
        new_instructions,
    )
}

/// Ask OpenRouter (haiku-class model for speed) to summarize the differences
/// between two agent system prompts.
async fn llm_diff_summary(
    api_key: &str,
    existing_name: &str,
    existing_instructions: &str,
    new_name: &str,
    new_instructions: &str,
) -> Result<String> {
    let prompt = format!(
        "Compare these two AI agent system prompts and give a concise 2–3 sentence summary \
        of how they differ in focus, behavior, or capability. Be specific.\n\n\
        EXISTING AGENT '{existing_name}':\n{existing_instructions}\n\n\
        NEW AGENT '{new_name}':\n{new_instructions}"
    );

    let body = serde_json::json!({
        "model": "anthropic/claude-haiku-4-5",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}]
    });

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("build reqwest client")?
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .context("call OpenRouter")?;

    if !response.status().is_success() {
        bail!("OpenRouter returned {}", response.status());
    }

    let json: serde_json::Value = response.json().await.context("parse OpenRouter response")?;
    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("unexpected OpenRouter response shape"))?
        .trim()
        .to_string();

    Ok(format!("Diff summary:\n{content}"))
}

/// Abbreviated side-by-side text comparison (no LLM required).
fn plain_text_diff(
    existing_name: &str,
    existing_instructions: &str,
    new_name: &str,
    new_instructions: &str,
) -> String {
    const PREVIEW_CHARS: usize = 300;

    let existing_preview = if existing_instructions.chars().count() > PREVIEW_CHARS {
        format!("{}…", char_truncate(existing_instructions, PREVIEW_CHARS))
    } else {
        existing_instructions.to_string()
    };

    let new_preview = if new_instructions.chars().count() > PREVIEW_CHARS {
        format!("{}…", char_truncate(new_instructions, PREVIEW_CHARS))
    } else {
        new_instructions.to_string()
    };

    format!(
        "Existing '{existing_name}' instructions:\n{existing_preview}\n\n\
        New '{new_name}' instructions:\n{new_preview}"
    )
}

/// Truncate to exactly `n` Unicode scalar values, returning a valid &str slice.
fn char_truncate(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((byte_pos, _)) => &s[..byte_pos],
        None => s,
    }
}

/// Convert a string to kebab-case: lowercase, non-alphanumeric chars become
/// hyphens, consecutive hyphens collapsed, leading/trailing hyphens stripped.
fn to_kebab_case(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut last_was_hyphen = true;
    for c in s.chars() {
        if c.is_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_hyphen = false;
        } else if !last_was_hyphen {
            result.push('-');
            last_was_hyphen = true;
        }
    }
    if result.ends_with('-') {
        result.pop();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::to_kebab_case;

    #[test]
    fn kebab_case_simple() {
        assert_eq!(to_kebab_case("My Agent"), "my-agent");
    }

    #[test]
    fn kebab_case_multiple_spaces() {
        assert_eq!(to_kebab_case("Hello  World"), "hello-world");
    }

    #[test]
    fn kebab_case_special_chars() {
        assert_eq!(to_kebab_case("Agent (v2)"), "agent-v2");
    }

    #[test]
    fn kebab_case_already_kebab() {
        assert_eq!(to_kebab_case("my-agent"), "my-agent");
    }

    #[test]
    fn kebab_case_leading_trailing_punct() {
        assert_eq!(to_kebab_case("(agent)"), "agent");
    }
}

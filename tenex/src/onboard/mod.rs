//! `tenex onboard` — initial setup wizard.
//!
//! Description: "Initial setup wizard for TENEX" (matches TS
//! `src/commands/onboard.ts:1535`).
//!
//! 7-step state machine. Per-screen modules implement the interactive flow;
//! this module wires them together and produces the final `~/.tenex/config.json`.
//!
//! Per spec doc 01 the steps are:
//!
//! 1. Identity         — [`identity::run`] (this module)
//! 2. Communication    — relays
//! 3. AI Providers
//! 4. Models
//! 5. Roles
//! 6. Project          — bootstrap
//! 7. Agents           — installation
//!
//! Each step's port is a concrete module; partial-screen stubs are not
//! shipped (per CLAUDE.md absolute rules). Steps that haven't been ported
//! yet cause `run` to return early with a status message — never with a
//! pretend-done state.

pub mod add_configuration;
pub mod auto_detect;
pub mod auto_select_roles;
pub mod claude_code_models;
pub mod commit;
pub mod embeddings;
pub mod identity;
pub mod llm_editor;
pub mod llm_test_hints;
pub mod llm_test_request;
pub mod providers;
pub mod random;
pub mod relays;
pub mod role_assignment;
pub mod seed_llms;

use std::collections::HashMap;

use anyhow::{Context, Result};
use clap::Parser;

use nostr_sdk::{PublicKey, ToBech32};

use crate::store::llms::LlmsDoc;
use crate::store::providers::ProvidersDoc;
use crate::tui::display;

#[derive(Parser, Clone)]
pub struct OnboardArgs {
    /// Pubkeys to whitelist (npub, nprofile, or hex). Repeatable.
    #[arg(long = "pubkey", value_name = "PUBKEY")]
    pub pubkey: Vec<String>,

    /// URL of a running local relay to offer as an option.
    #[arg(long = "local-relay-url", value_name = "URL")]
    pub local_relay_url: Option<String>,

    /// Output configuration as JSON (suppresses banners and interactive prompts
    /// where CLI alternatives exist).
    #[arg(long)]
    pub json: bool,
}

pub async fn run(args: OnboardArgs) -> Result<()> {
    let json_mode = args.json;

    if !json_mode {
        display::welcome();
        display::step(1, 7, "Identity");
        display::context(
            "Your identity is how your agents know you, and how others can reach you.",
        );
        display::blank();
    }

    if !args.pubkey.is_empty() {
        // `--pubkey` mode skips the entire identity flow per spec 01 §"Screen 1".
        // The remaining 6 steps need their own ports before this branch can land
        // the user back at a fully-configured state — surface that explicitly so
        // the operator sees a clear message rather than a half-flow.
        eprintln!(
            "onboard: --pubkey mode requires steps 2-7 (relays, providers, models, \
             roles, project, agents). Those screens have not been ported yet."
        );
        return Ok(());
    }

    let identity = identity::run(json_mode)?;

    // Screen 2: Communication / relays.
    let chosen_relay = relays::run(json_mode, args.local_relay_url.as_deref())?;
    let Some(relay) = chosen_relay else {
        // User cancelled the relay prompt — abort cleanly.
        eprintln!("onboard: cancelled at relay step.");
        return Ok(());
    };

    // Screens 1.E + 1.F (no UI) + Save: apply daemon-key default,
    // projects-dir default, write `config.json`, ensure projects dir.
    let base_dir = crate::store::resolve_base_dir(None);
    let committed = commit::commit(
        &base_dir,
        commit::InitialConfig {
            whitelisted_pubkeys: identity.whitelisted_pubkeys.clone(),
            relay: relay.clone(),
        },
    )?;

    // Screen 3: AI Providers — auto-detection + interactive setup + save.
    //
    // Post-Screen-2 NDK side-effects (background agent discovery + fire-and-
    // forget kind:0 profile publish) require a full NDK setup and are
    // deferred to their own iteration. Auto-detect runs synchronously here
    // even without NDK.
    let starting_providers = ProvidersDoc::load(&base_dir)
        .with_context(|| format!("loading providers.json from {}", base_dir.display()))?;
    let env = capture_provider_env();
    let detection = auto_detect::auto_detect_providers(
        starting_providers,
        &env,
        &auto_detect::SystemProbes,
    );

    if !json_mode {
        for source in &detection.detected_sources {
            display::success(&format!("Detected: {source}"));
        }
        if !detection.detected_sources.is_empty() {
            display::blank();
        }
        display::step(3, 7, "AI Providers");
        display::context(
            "Connect the AI services your agents will use. You need at least one.",
        );
        display::blank();
    }

    let hints = detection.provider_hints();
    let claude_hint_present =
        hints.contains_key(crate::onboard::providers::PROVIDER_IDS[1]); // "anthropic"
    let setup_result = providers::run(detection.doc, hints)?;

    let providers_doc = match setup_result {
        providers::ProviderSetupResult::Configured(doc) => doc,
        providers::ProviderSetupResult::Cancelled => {
            eprintln!("onboard: cancelled at provider step.");
            return Ok(());
        }
    };

    providers_doc
        .save(&base_dir)
        .with_context(|| format!("saving providers.json to {}", base_dir.display()))?;
    if !json_mode {
        display::success("Provider credentials saved");
    }

    // Step 4 (sub-step A): seed default LLM configurations.
    // The interactive LLM editor (`LLMConfigEditor.showMainMenu`) is the
    // remaining piece of Screen 4 and is deferred until the editor's bespoke
    // prompt is ported in its own iteration.
    let configured_provider_ids = providers_doc.provider_ids();
    let mut llms_doc = LlmsDoc::load(&base_dir)
        .with_context(|| format!("loading llms.json from {}", base_dir.display()))?;
    let seeded = seed_llms::seed_default_llm_configs(&configured_provider_ids, &mut llms_doc);

    if !seeded.is_empty() {
        llms_doc
            .save(&base_dir)
            .with_context(|| format!("saving llms.json to {}", base_dir.display()))?;
        if !json_mode {
            for entry in &seeded {
                display::success(&format!("Seeded: {} ({})", entry.name, entry.detail));
            }
        }
    }

    let mut llm_editor_done = false;
    if !configured_provider_ids.is_empty() {
        if !json_mode {
            display::step(4, 7, "Models");
            display::context("Configure which models your agents will use.");
            display::blank();
        }
        // Step 4 (sub-step B): interactive LLM config editor.
        // The `addConfiguration` and per-config detail-edit sub-flows are
        // their own subsystems (each requires a separate provider-list API:
        // OpenRouter, Ollama, Codex, models.dev). Until those are ported the
        // editor lets the user view, delete, or accept the seeded configs.
        match llm_editor::run(&base_dir)? {
            llm_editor::LlmEditorResult::Done => {
                llm_editor_done = true;
            }
            llm_editor::LlmEditorResult::Cancelled => {
                eprintln!("onboard: cancelled at LLM editor.");
                return Ok(());
            }
        }
    }

    // Step 5: Roles. The TS path (`:1455-1457`) only renders this when at
    // least one provider was configured; mirror that.
    let mut role_assignment_done = false;
    if !configured_provider_ids.is_empty() {
        if !json_mode {
            display::step(5, 7, "Model Roles");
        }
        let outcome = role_assignment::run(
            &base_dir,
            &auto_select_roles::EmptyModelInfoSource,
        )?;
        match outcome {
            role_assignment::RoleAssignmentResult::Configured => {
                role_assignment_done = true;
            }
            role_assignment::RoleAssignmentResult::Cancelled => {
                eprintln!("onboard: cancelled at role assignment.");
                return Ok(());
            }
        }
    }

    // Step 6: Embeddings. Same gate as Step 5 — only when at least one
    // provider was configured (otherwise there's nothing to recommend).
    let mut embedding_choice: Option<embeddings::EmbeddingChoice> = None;
    if !configured_provider_ids.is_empty() {
        if !json_mode {
            display::step(6, 7, "Embeddings");
            display::context("Choose an embedding model for semantic search and RAG.");
            display::blank();
        }
        match embeddings::run(&base_dir, &configured_provider_ids)? {
            embeddings::EmbeddingsResult::Configured(choice) => {
                embedding_choice = Some(choice);
            }
            embeddings::EmbeddingsResult::Cancelled => {
                eprintln!("onboard: cancelled at embedding step.");
                return Ok(());
            }
        }
    }

    // End-of-flow summary. Step 7 (Project & Agents) still pending — needs
    // NDK setup, agent discovery via Nostr, and project-event creation. We
    // do NOT call `display::setup_complete` while Step 7 is unported (the
    // "Setup complete!" banner would mislead); a hint surfaces the pending
    // work explicitly. The summary lines themselves are TS-faithful.
    let npub = encode_npub(&identity.whitelisted_pubkeys[0])?;

    if json_mode {
        emit_json_summary(
            &npub,
            &identity.whitelisted_pubkeys[0],
            &committed.projects_base,
            &[relay.clone()],
            identity.generated_nsec.as_deref(),
            identity.new_identity_username.as_deref(),
            &providers_doc.provider_ids(),
            &seeded.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
            llm_editor_done,
            role_assignment_done,
            embedding_choice.as_ref(),
        );
    } else {
        emit_text_summary(
            &npub,
            identity.generated_nsec.as_deref(),
            &committed.projects_base,
            &[relay.clone()],
        );
        let _ = (
            claude_hint_present,
            llm_editor_done,
            role_assignment_done,
            embedding_choice,
            providers_doc,
            seeded,
        );
    }
    Ok(())
}

fn encode_npub(pubkey_hex: &str) -> Result<String> {
    let pk = PublicKey::from_hex(pubkey_hex)
        .with_context(|| format!("decoding pubkey hex {pubkey_hex}"))?;
    pk.to_bech32().context("encoding npub")
}

fn emit_text_summary(
    npub: &str,
    generated_nsec: Option<&str>,
    projects_base: &std::path::Path,
    relays: &[String],
) {
    display::blank();
    display::hint(
        "Onboarding incomplete — Step 7 (Project & Agents) is pending port.",
    );
    display::blank();
    display::summary_line("Identity", npub);
    if let Some(nsec) = generated_nsec {
        display::summary_line("nsec", nsec);
    }
    display::summary_line("Projects", &projects_base.to_string_lossy());
    display::summary_line("Relays", &relays.join(", "));
    display::blank();
}

#[allow(clippy::too_many_arguments)]
fn emit_json_summary(
    npub: &str,
    pubkey_hex: &str,
    projects_base: &std::path::Path,
    relays: &[String],
    generated_nsec: Option<&str>,
    new_identity_username: Option<&str>,
    providers: &[String],
    seeded_llms: &[String],
    llm_editor_done: bool,
    roles_assigned: bool,
    embedding_choice: Option<&embeddings::EmbeddingChoice>,
) {
    let mut output = serde_json::Map::new();
    output.insert(
        "stage".into(),
        serde_json::Value::String("step-7-pending".into()),
    );
    output.insert("npub".into(), serde_json::Value::String(npub.to_owned()));
    output.insert(
        "pubkey".into(),
        serde_json::Value::String(pubkey_hex.to_owned()),
    );
    output.insert(
        "projectsBase".into(),
        serde_json::Value::String(projects_base.to_string_lossy().into_owned()),
    );
    output.insert(
        "relays".into(),
        serde_json::Value::Array(
            relays
                .iter()
                .map(|r| serde_json::Value::String(r.clone()))
                .collect(),
        ),
    );
    if let Some(nsec) = generated_nsec {
        output.insert("nsec".into(), serde_json::Value::String(nsec.to_owned()));
    }
    if let Some(name) = new_identity_username {
        output.insert(
            "newIdentityUsername".into(),
            serde_json::Value::String(name.to_owned()),
        );
    }
    output.insert(
        "providers".into(),
        serde_json::Value::Array(
            providers
                .iter()
                .map(|p| serde_json::Value::String(p.clone()))
                .collect(),
        ),
    );
    output.insert(
        "seededLLMs".into(),
        serde_json::Value::Array(
            seeded_llms
                .iter()
                .map(|n| serde_json::Value::String(n.clone()))
                .collect(),
        ),
    );
    output.insert(
        "llmEditorDone".into(),
        serde_json::Value::Bool(llm_editor_done),
    );
    output.insert(
        "rolesAssigned".into(),
        serde_json::Value::Bool(roles_assigned),
    );
    if let Some(choice) = embedding_choice {
        let mut emb = serde_json::Map::new();
        emb.insert(
            "provider".into(),
            serde_json::Value::String(choice.provider.clone()),
        );
        emb.insert(
            "model".into(),
            serde_json::Value::String(choice.model.clone()),
        );
        output.insert("embedding".into(), serde_json::Value::Object(emb));
    }
    output.insert(
        "remaining".into(),
        serde_json::Value::Array(vec![serde_json::Value::String(
            "project-agents".into(),
        )]),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::Value::Object(output))
            .unwrap_or_else(|_| String::from("{}"))
    );
}

/// Capture the four canonical provider env vars into a snapshot for
/// [`auto_detect::auto_detect_providers`]. Only these four are read — every
/// other env var is ignored, matching `autoDetectProviders` exactly.
fn capture_provider_env() -> HashMap<String, String> {
    [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ]
    .into_iter()
    .filter_map(|k| {
        std::env::var(k)
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| (k.to_owned(), v))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_provider_env_only_includes_known_keys() {
        // Capture is read-only — assert it produces a HashMap of the four
        // canonical env vars (or fewer when unset). Unrelated env vars
        // (e.g. PATH, HOME) must not leak in.
        let captured = capture_provider_env();
        for key in captured.keys() {
            assert!(
                matches!(
                    key.as_str(),
                    "ANTHROPIC_API_KEY"
                        | "OPENAI_API_KEY"
                        | "OPENROUTER_API_KEY"
                        | "ANTHROPIC_AUTH_TOKEN"
                ),
                "leaked env var: {key}",
            );
        }
    }

    #[test]
    fn capture_provider_env_drops_empty_values() {
        // The runtime filters out empty values (matches the JS truthiness
        // check at `:627`). This test inspects the closure's behaviour
        // by simulating: the captured snapshot should never carry "".
        let captured = capture_provider_env();
        for (k, v) in &captured {
            assert!(!v.is_empty(), "empty value leaked for {k}");
        }
    }
}

use std::path::Path;

use dialoguer::{Confirm, Input, Password, Select, theme::ColorfulTheme};
use serde_json::{Map, Value, json};
use url::Url;

use crate::backend_config::{read_backend_config, write_backend_config_fields};
use crate::llms_config::{LLMsConfig, read_llms_config, write_llms_config};
use crate::providers_config::{
    ProviderEntry, ProvidersConfig, read_providers_config, write_providers_config,
};

use super::display;

pub struct ConfigTuiOptions {
    pub subcommand: Option<String>,
}

pub fn run_config(options: ConfigTuiOptions, base_dir: &Path) -> anyhow::Result<()> {
    let theme = display::amber_theme();

    match options.subcommand.as_deref() {
        Some("providers") => run_providers(&theme, base_dir),
        Some("llm") => run_llm(&theme, base_dir),
        Some("roles") => run_roles(&theme, base_dir),
        Some("relays") => run_relays(&theme, base_dir),
        Some("identity") => run_identity(&theme, base_dir),
        Some("summarization") => run_summarization(&theme, base_dir),
        Some("logging") => run_logging(&theme, base_dir),
        Some("paths") => run_paths(&theme, base_dir),
        None => run_main_menu(&theme, base_dir),
        Some(other) => {
            eprintln!("Unknown config subcommand: {other}");
            eprintln!(
                "Available: providers, llm, roles, relays, identity, summarization, logging, paths"
            );
            std::process::exit(2);
        }
    }
}

// ── Main menu ─────────────────────────────────────────────────────────────────

fn run_main_menu(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    type RunFn = fn(&ColorfulTheme, &Path) -> anyhow::Result<()>;

    struct Entry {
        label: &'static str,
        description: &'static str,
        run: RunFn,
    }

    struct Section {
        header: &'static str,
        entries: &'static [Entry],
    }

    static SECTIONS: &[Section] = &[
        Section {
            header: "AI",
            entries: &[
                Entry {
                    label: "Providers",
                    description: "API keys and connections",
                    run: run_providers,
                },
                Entry {
                    label: "LLMs",
                    description: "Model configurations",
                    run: run_llm,
                },
                Entry {
                    label: "Roles",
                    description: "Which model handles what task",
                    run: run_roles,
                },
            ],
        },
        Section {
            header: "Network",
            entries: &[Entry {
                label: "Relays",
                description: "Nostr relay connections",
                run: run_relays,
            }],
        },
        Section {
            header: "Conversations",
            entries: &[Entry {
                label: "Summarization",
                description: "Auto-summary timing",
                run: run_summarization,
            }],
        },
        Section {
            header: "Advanced",
            entries: &[
                Entry {
                    label: "Identity",
                    description: "Authorized pubkeys",
                    run: run_identity,
                },
                Entry {
                    label: "System Prompt",
                    description: "Global prompt for all projects",
                    run: run_system_prompt,
                },
                Entry {
                    label: "Paths",
                    description: "File paths and storage",
                    run: run_paths,
                },
                Entry {
                    label: "Logging",
                    description: "Log level and file path",
                    run: run_logging,
                },
            ],
        },
    ];

    loop {
        display::blank();

        // Interleave section headers (non-selectable-looking strings) and entries.
        // We track which indices are real entries vs headers.
        let mut items: Vec<String> = Vec::new();
        let mut runners: Vec<Option<RunFn>> = Vec::new();

        for section in SECTIONS {
            items.push(format!("── {} ──", section.header));
            runners.push(None);

            for entry in section.entries {
                items.push(format!("  {:<16}  {}", entry.label, entry.description));
                runners.push(Some(entry.run));
            }
        }

        items.push("──────────────────────────────".to_string());
        runners.push(None);

        // Find first real entry to use as default
        let first_entry = runners.iter().position(|r| r.is_some()).unwrap_or(0);

        let selection = Select::with_theme(theme)
            .with_prompt("Settings  (Esc to exit)")
            .items(&items)
            .default(first_entry)
            .interact_opt()?;

        match selection {
            None => break, // Esc
            Some(idx) => {
                if let Some(run) = runners[idx] {
                    display::blank();
                    run(theme, base_dir)?;
                }
            }
        }
    }

    Ok(())
}

// ── Providers ─────────────────────────────────────────────────────────────────

fn run_providers(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let mut providers = read_providers_config(base_dir)?;

    loop {
        display::blank();
        let names: Vec<String> = providers.providers.keys().cloned().collect();

        let mut items: Vec<String> = names.iter().map(|n| format!("  {n}")).collect();
        items.push("  Add provider".to_string());

        let selection = Select::with_theme(theme)
            .with_prompt("Providers  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        let Some(selection) = selection else { break };
        let add_idx = items.len() - 1;

        if selection == add_idx {
            add_provider(theme, &mut providers)?;
            write_providers_config(base_dir, &providers)?;
            display::success("Provider saved");
            continue;
        }

        let name = names[selection].clone();
        let action_items = vec!["Update API key", "Remove"];
        let action = Select::with_theme(theme)
            .with_prompt(&name)
            .items(&action_items)
            .interact_opt()?;

        match action {
            Some(0) => {
                let key: String = Password::with_theme(theme)
                    .with_prompt("New API key")
                    .interact()?;
                if let Some(entry) = providers.providers.get_mut(&name) {
                    entry.api_key = key.trim().to_string();
                }
                write_providers_config(base_dir, &providers)?;
                display::success("API key updated");
            }
            Some(1) => {
                providers.providers.remove(&name);
                write_providers_config(base_dir, &providers)?;
                display::success(&format!("Removed {name}"));
            }
            _ => {}
        }
    }

    Ok(())
}

fn add_provider(theme: &ColorfulTheme, providers: &mut ProvidersConfig) -> anyhow::Result<()> {
    let known = [
        ("anthropic", "Anthropic"),
        ("openai", "OpenAI"),
        ("openrouter", "OpenRouter"),
        ("ollama", "Ollama"),
    ];

    let mut items: Vec<String> = known.iter().map(|(_, l)| l.to_string()).collect();
    items.push("Custom".to_string());

    let Some(selection) = Select::with_theme(theme)
        .with_prompt("Provider")
        .items(&items)
        .interact_opt()?
    else {
        return Ok(());
    };

    let provider_id = if selection < known.len() {
        known[selection].0.to_string()
    } else {
        let id: String = Input::with_theme(theme)
            .with_prompt("Provider ID")
            .interact_text()?;
        id.trim().to_string()
    };

    let api_key: String = if provider_id == "ollama" {
        Input::with_theme(theme)
            .with_prompt("Ollama base URL")
            .default("http://localhost:11434".to_string())
            .interact_text()?
    } else {
        Password::with_theme(theme)
            .with_prompt("API key")
            .interact()?
    };

    providers.providers.insert(
        provider_id,
        ProviderEntry {
            api_key: api_key.trim().to_string(),
            base_url: None,
        },
    );

    Ok(())
}

// ── LLMs ──────────────────────────────────────────────────────────────────────

fn run_llm(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let mut llms = read_llms_config(base_dir)?;

    loop {
        display::blank();
        let names: Vec<String> = llms.configurations.keys().cloned().collect();

        let mut items: Vec<String> = names
            .iter()
            .map(|n| {
                if llms.default.as_deref() == Some(n) {
                    format!("  {n}  [default]")
                } else {
                    format!("  {n}")
                }
            })
            .collect();
        items.push("  Add LLM configuration".to_string());

        let selection = Select::with_theme(theme)
            .with_prompt("LLM Configurations  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        let Some(selection) = selection else { break };
        let add_idx = items.len() - 1;

        if selection == add_idx {
            add_llm_config(theme, &mut llms)?;
            write_llms_config(base_dir, &llms)?;
            display::success("LLM configuration saved");
            continue;
        }

        let name = names[selection].clone();
        let action_items = vec!["Set as default", "Edit", "Remove"];
        let action = Select::with_theme(theme)
            .with_prompt(&name)
            .items(&action_items)
            .interact_opt()?;

        match action {
            Some(0) => {
                llms.default = Some(name.clone());
                write_llms_config(base_dir, &llms)?;
                display::success(&format!("{name} is now the default"));
            }
            Some(1) => {
                edit_llm_config(theme, &mut llms, &name)?;
                write_llms_config(base_dir, &llms)?;
                display::success("Configuration updated");
            }
            Some(2) => {
                llms.configurations.shift_remove(&name);
                if llms.default.as_deref() == Some(&name) {
                    llms.default = llms.configurations.keys().next().cloned();
                }
                write_llms_config(base_dir, &llms)?;
                display::success(&format!("Removed {name}"));
            }
            _ => {}
        }
    }

    Ok(())
}

fn add_llm_config(theme: &ColorfulTheme, llms: &mut LLMsConfig) -> anyhow::Result<()> {
    let name: String = Input::with_theme(theme)
        .with_prompt("Configuration name (e.g. Sonnet)")
        .interact_text()?;
    let name = name.trim().to_string();

    let provider: String = Input::with_theme(theme)
        .with_prompt("Provider (anthropic / openai / openrouter / ollama)")
        .interact_text()?;

    let model: String = Input::with_theme(theme)
        .with_prompt("Model name")
        .interact_text()?;

    llms.configurations.insert(
        name,
        json!({
            "provider": provider.trim(),
            "model":    model.trim()
        }),
    );

    if llms.default.is_none() {
        llms.default = llms.configurations.keys().next().cloned();
    }

    Ok(())
}

fn edit_llm_config(theme: &ColorfulTheme, llms: &mut LLMsConfig, name: &str) -> anyhow::Result<()> {
    let existing = llms.configurations.get(name).cloned().unwrap_or_default();
    let cur_provider = existing
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cur_model = existing
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let provider: String = Input::with_theme(theme)
        .with_prompt("Provider")
        .default(cur_provider)
        .interact_text()?;

    let model: String = Input::with_theme(theme)
        .with_prompt("Model name")
        .default(cur_model)
        .interact_text()?;

    llms.configurations.insert(
        name.to_string(),
        json!({
            "provider": provider.trim(),
            "model":    model.trim()
        }),
    );

    Ok(())
}

// ── Roles — table-style overview, Enter to edit each row ─────────────────────

struct RoleEntry {
    key: &'static str,
    label: &'static str,
    recommendation: &'static str,
}

const ROLES: &[RoleEntry] = &[
    RoleEntry {
        key: "default",
        label: "Default",
        recommendation: "All-rounder — used by every agent",
    },
    RoleEntry {
        key: "summarization",
        label: "Summarization",
        recommendation: "Cheap + large context, for conversation metadata",
    },
    RoleEntry {
        key: "supervision",
        label: "Supervision",
        recommendation: "Strongest reasoning, evaluates agent work",
    },
    RoleEntry {
        key: "promptCompilation",
        label: "Prompt Compilation",
        recommendation: "Smart + large context, distils lessons",
    },
    RoleEntry {
        key: "categorization",
        label: "Categorization",
        recommendation: "Cheap + fast, classifies agent roles",
    },
];

fn get_role<'a>(llms: &'a LLMsConfig, key: &str) -> Option<&'a str> {
    match key {
        "default" => llms.default.as_deref(),
        "summarization" => llms.summarization.as_deref(),
        "supervision" => llms.supervision.as_deref(),
        "promptCompilation" => llms.prompt_compilation.as_deref(),
        "categorization" => llms.categorization.as_deref(),
        _ => None,
    }
}

fn set_role(llms: &mut LLMsConfig, key: &str, value: String) {
    match key {
        "default" => llms.default = Some(value),
        "summarization" => llms.summarization = Some(value),
        "supervision" => llms.supervision = Some(value),
        "promptCompilation" => llms.prompt_compilation = Some(value),
        "categorization" => llms.categorization = Some(value),
        _ => {}
    }
}

fn run_roles(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let mut llms = read_llms_config(base_dir)?;

    if llms.configurations.is_empty() {
        display::hint("No LLM configurations found. Add one via 'tenex config llm' first.");
        return Ok(());
    }

    let names: Vec<String> = llms.configurations.keys().cloned().collect();
    let label_width = ROLES.iter().map(|r| r.label.len()).max().unwrap_or(0);

    loop {
        display::blank();

        // Build items: each role shows its current assignment inline
        let fallback = names[0].clone();
        let mut items: Vec<String> = ROLES
            .iter()
            .map(|role| {
                let assigned = get_role(&llms, role.key).unwrap_or(&fallback);
                format!(
                    "  {:<width$}  {}",
                    role.label,
                    assigned,
                    width = label_width
                )
            })
            .collect();
        items.push(display::done_label());

        let done_idx = items.len() - 1;

        let selection = Select::with_theme(theme)
            .with_prompt("Model Roles  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        match selection {
            None => break,
            Some(idx) if idx == done_idx => {
                write_llms_config(base_dir, &llms)?;
                display::success("Model roles saved");
                break;
            }
            Some(idx) => {
                let role = &ROLES[idx];
                // Show model picker for this role
                display::context(role.recommendation);
                display::blank();

                let current = get_role(&llms, role.key).unwrap_or(&fallback).to_string();
                let default_idx = names.iter().position(|n| n == &current).unwrap_or(0);

                let picked = Select::with_theme(theme)
                    .with_prompt(role.label)
                    .items(&names)
                    .default(default_idx)
                    .interact_opt()?;

                if let Some(i) = picked {
                    set_role(&mut llms, role.key, names[i].clone());
                }
            }
        }
    }

    Ok(())
}

// ── Relays ────────────────────────────────────────────────────────────────────

fn run_relays(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    loop {
        let relays = load_relays(base_dir);
        display::blank();

        let mut items: Vec<String> = relays.iter().map(|r| format!("  {r}")).collect();
        items.push("  Add relay".to_string());

        let selection = Select::with_theme(theme)
            .with_prompt("Relays  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        let Some(selection) = selection else { break };
        let add_idx = items.len() - 1;

        if selection == add_idx {
            let url = prompt_relay_url_input(theme)?;
            let mut updated = relays;
            updated.push(url);
            save_relays(base_dir, &updated)?;
            display::success("Relay added");
            continue;
        }

        let relay = relays[selection].clone();
        let action = Select::with_theme(theme)
            .with_prompt(&relay)
            .items(&["Remove"])
            .interact_opt()?;

        if action == Some(0) {
            let mut updated = relays;
            updated.remove(selection);
            save_relays(base_dir, &updated)?;
            display::success("Relay removed");
        }
    }

    Ok(())
}

fn load_relays(base_dir: &Path) -> Vec<String> {
    read_backend_config(base_dir)
        .map(|s| s.relays)
        .unwrap_or_default()
}

fn save_relays(base_dir: &Path, relays: &[String]) -> anyhow::Result<()> {
    let mut fields = Map::new();
    fields.insert("relays".to_string(), json!(relays));
    write_backend_config_fields(base_dir, &fields)?;
    Ok(())
}

fn prompt_relay_url_input(theme: &ColorfulTheme) -> anyhow::Result<String> {
    loop {
        let input: String = Input::with_theme(theme)
            .with_prompt("Relay URL (wss://...)")
            .interact_text()?;
        let input = input.trim().to_string();
        if let Ok(u) = Url::parse(&input) {
            if matches!(u.scheme(), "ws" | "wss") && u.host().is_some() {
                return Ok(input);
            }
        }
        eprintln!("  Must start with ws:// or wss://");
    }
}

// ── Identity ──────────────────────────────────────────────────────────────────

fn run_identity(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    loop {
        let pubkeys = load_pubkeys(base_dir);
        display::blank();

        let mut items: Vec<String> = pubkeys.iter().map(|p| format!("  {p}")).collect();
        items.push("  Add pubkey".to_string());

        let selection = Select::with_theme(theme)
            .with_prompt("Whitelisted pubkeys  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        let Some(selection) = selection else { break };
        let add_idx = items.len() - 1;

        if selection == add_idx {
            let pubkey: String = Input::with_theme(theme)
                .with_prompt("Pubkey (npub or hex)")
                .interact_text()?;
            let mut updated = pubkeys;
            updated.push(pubkey.trim().to_string());
            save_pubkeys(base_dir, &updated)?;
            display::success("Pubkey added");
            continue;
        }

        let pubkey = pubkeys[selection].clone();
        let action = Select::with_theme(theme)
            .with_prompt("Action")
            .items(&["Remove"])
            .interact_opt()?;

        if action == Some(0) {
            let mut updated = pubkeys;
            updated.remove(selection);
            save_pubkeys(base_dir, &updated)?;
            display::success(&format!("Removed {pubkey}"));
        }
    }

    Ok(())
}

fn load_pubkeys(base_dir: &Path) -> Vec<String> {
    read_backend_config(base_dir)
        .map(|s| s.whitelisted_pubkeys)
        .unwrap_or_default()
}

fn save_pubkeys(base_dir: &Path, pubkeys: &[String]) -> anyhow::Result<()> {
    let mut fields = Map::new();
    fields.insert("whitelistedPubkeys".to_string(), json!(pubkeys));
    write_backend_config_fields(base_dir, &fields)?;
    Ok(())
}

// ── Summarization ─────────────────────────────────────────────────────────────

fn run_summarization(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let current: u64 = load_json_field(base_dir, &["summarization", "inactivityTimeoutSeconds"])
        .and_then(|v| v.as_u64())
        .unwrap_or(300);

    display::context(&format!("Current inactivity timeout: {current}s"));
    display::blank();

    let input: String = Input::with_theme(theme)
        .with_prompt("Inactivity timeout (seconds)")
        .default(current.to_string())
        .interact_text()?;

    let timeout: u64 = input.trim().parse().unwrap_or(300);
    let mut fields = Map::new();
    fields.insert(
        "summarization".to_string(),
        json!({ "inactivityTimeoutSeconds": timeout }),
    );
    write_backend_config_fields(base_dir, &fields)?;
    display::success(&format!("Summarization timeout set to {timeout}s"));

    Ok(())
}

// ── System Prompt ─────────────────────────────────────────────────────────────

fn run_system_prompt(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let cur_enabled = load_json_field(base_dir, &["globalSystemPrompt", "enabled"])
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cur_content = load_json_field(base_dir, &["globalSystemPrompt", "content"])
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let enabled = Confirm::with_theme(theme)
        .with_prompt("Enable global system prompt?")
        .default(cur_enabled)
        .interact()?;

    if enabled {
        let content: String = Input::with_theme(theme)
            .with_prompt("System prompt content")
            .default(cur_content)
            .allow_empty(true)
            .interact_text()?;

        let mut fields = Map::new();
        fields.insert(
            "globalSystemPrompt".to_string(),
            json!({ "enabled": true, "content": content }),
        );
        write_backend_config_fields(base_dir, &fields)?;
        display::success("Global system prompt enabled");
    } else {
        let mut fields = Map::new();
        fields.insert(
            "globalSystemPrompt".to_string(),
            json!({ "enabled": false }),
        );
        write_backend_config_fields(base_dir, &fields)?;
        display::success("Global system prompt disabled");
    }

    Ok(())
}

// ── Paths ─────────────────────────────────────────────────────────────────────

fn run_paths(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let current = read_backend_config(base_dir)
        .ok()
        .and_then(|s| s.projects_base)
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(|h| format!("{h}/tenex"))
                .unwrap_or_else(|_| "/tmp/tenex".to_string())
        });

    display::context(&format!("Current projects base: {current}"));
    display::blank();

    let new_path: String = Input::with_theme(theme)
        .with_prompt("Projects base directory")
        .default(current)
        .interact_text()?;

    let mut fields = Map::new();
    fields.insert("projectsBase".to_string(), json!(new_path.trim()));
    write_backend_config_fields(base_dir, &fields)?;
    display::success("Projects base updated");

    Ok(())
}

// ── Logging ───────────────────────────────────────────────────────────────────

fn run_logging(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let cur_level = load_json_field(base_dir, &["logging", "level"])
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "info".to_string());
    let cur_file = load_json_field(base_dir, &["logging", "logFile"])
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let levels = ["silent", "error", "warn", "info", "debug"];
    let default_idx = levels.iter().position(|&l| l == cur_level).unwrap_or(3);

    let level_sel = Select::with_theme(theme)
        .with_prompt("Log level")
        .items(&levels)
        .default(default_idx)
        .interact_opt()?;

    let Some(level_sel) = level_sel else {
        return Ok(());
    };
    let level = levels[level_sel];

    let log_file: String = Input::with_theme(theme)
        .with_prompt("Log file path (leave empty for none)")
        .default(cur_file)
        .allow_empty(true)
        .interact_text()?;

    let log_value = if log_file.trim().is_empty() {
        json!({ "level": level })
    } else {
        json!({ "level": level, "logFile": log_file.trim() })
    };

    let mut fields = Map::new();
    fields.insert("logging".to_string(), log_value);
    write_backend_config_fields(base_dir, &fields)?;
    display::success(&format!("Log level set to {level}"));

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn load_json_field(base_dir: &Path, path: &[&str]) -> Option<Value> {
    let content = std::fs::read_to_string(base_dir.join("config.json")).ok()?;
    let mut v: Value = serde_json::from_str(&content).ok()?;
    for key in path {
        v = v.get(key)?.clone();
    }
    Some(v)
}

use std::io::{self, Write};
use std::path::Path;

use crossterm::{
    cursor::{Hide, MoveUp, Show},
    event::{self, Event, KeyCode},
    execute, queue,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, Clear, ClearType, disable_raw_mode, enable_raw_mode},
};
use dialoguer::{Confirm, Input, Password, Select, theme::ColorfulTheme};
use serde_json::{Map, Value, json};
use url::Url;

use crate::backend_config::{read_backend_config, write_backend_config_fields};
use crate::llms_config::{LLMsConfig, read_llms_config, write_llms_config};
use crate::providers_config::{
    ProviderEntry, ProvidersConfig, read_providers_config, write_providers_config,
};

use super::agent_store;
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
        Some("telegram") => run_telegram(&theme, base_dir),
        None => run_main_menu(&theme, base_dir),
        Some(other) => {
            eprintln!("Unknown config subcommand: {other}");
            eprintln!(
                "Available: providers, llm, roles, relays, identity, summarization, logging, paths, telegram"
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
            header: "Integrations",
            entries: &[Entry {
                label: "Telegram",
                description: "Bot token per agent",
                run: run_telegram,
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
    let mut cursor: usize = 0;
    let mut rendered_lines: usize = 0;

    enable_raw_mode()?;
    execute!(io::stdout(), Hide)?;

    let result = (|| -> anyhow::Result<()> {
        loop {
            let names: Vec<String> = llms.configurations.keys().cloned().collect();
            if cursor > 0 && cursor >= names.len() {
                cursor = names.len().saturating_sub(1);
            }

            llm_erase(rendered_lines)?;
            rendered_lines = llm_render(&llms, &names, cursor)?;

            let Event::Key(key) = event::read()? else { continue };

            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => break,
                KeyCode::Up => {
                    if cursor > 0 {
                        cursor -= 1;
                    }
                }
                KeyCode::Down => {
                    if cursor + 1 < names.len() {
                        cursor += 1;
                    }
                }
                KeyCode::Char('a') => {
                    llm_suspend(&mut rendered_lines, || {
                        if add_llm_config(theme, base_dir, &mut llms)? {
                            write_llms_config(base_dir, &llms)?;
                            display::success("Configuration saved");
                        }
                        Ok(())
                    })?;
                }
                KeyCode::Char('d') => {
                    if names.is_empty() {
                        continue;
                    }
                    let name = names[cursor].clone();
                    llm_suspend(&mut rendered_lines, || {
                        let confirmed = Confirm::with_theme(theme)
                            .with_prompt(format!("Delete '{name}'?"))
                            .default(false)
                            .interact()?;
                        if confirmed {
                            llms.configurations.shift_remove(&name);
                            if llms.default.as_deref() == Some(name.as_str()) {
                                llms.default = llms.configurations.keys().next().cloned();
                            }
                            write_llms_config(base_dir, &llms)?;
                            display::success(&format!("Deleted '{name}'"));
                        }
                        Ok(())
                    })?;
                }
                KeyCode::Enter => {
                    if names.is_empty() {
                        continue;
                    }
                    let name = names[cursor].clone();
                    llm_suspend(&mut rendered_lines, || {
                        let action = Select::with_theme(theme)
                            .with_prompt(&name)
                            .items(&["Set as default", "Edit", "Back"])
                            .interact_opt()?;
                        match action {
                            Some(0) => {
                                llms.default = Some(name.clone());
                                write_llms_config(base_dir, &llms)?;
                                display::success(&format!("'{name}' is now the default"));
                            }
                            Some(1) => {
                                edit_llm_config(theme, base_dir, &mut llms, &name)?;
                                write_llms_config(base_dir, &llms)?;
                                display::success("Configuration updated");
                            }
                            _ => {}
                        }
                        Ok(())
                    })?;
                }
                _ => {}
            }
        }
        Ok(())
    })();

    llm_erase(rendered_lines).ok();
    execute!(io::stdout(), Show).ok();
    disable_raw_mode().ok();

    result
}

fn llm_render(llms: &LLMsConfig, names: &[String], cursor: usize) -> anyhow::Result<usize> {
    let mut out = io::stdout();
    let mut lines = 0;

    queue!(
        out,
        SetForegroundColor(Color::DarkGrey),
        Print(format!("  LLM Configurations ({})\r\n", names.len())),
        Print("  a add  ·  d delete  ·  enter edit  ·  esc quit\r\n"),
        Print("  ──────────────────────────────────────────────\r\n"),
        ResetColor,
    )?;
    lines += 3;

    let visible_rows =
        terminal::size().map(|(_, h)| (h as usize / 2).max(8)).unwrap_or(12);
    let offset = if names.len() <= visible_rows {
        0
    } else {
        let half = visible_rows / 2;
        let max_start = names.len() - visible_rows;
        cursor.saturating_sub(half).min(max_start)
    };
    let end = (offset + visible_rows).min(names.len());

    if offset > 0 {
        queue!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  ↑ {} more\r\n", offset)),
            ResetColor,
        )?;
        lines += 1;
    }

    if names.is_empty() {
        queue!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print("  No configurations yet  ·  press a to add one\r\n"),
            ResetColor,
        )?;
        lines += 1;
    } else {
        for (i, name) in names[offset..end].iter().enumerate() {
            let idx = offset + i;
            let is_cursor = idx == cursor;
            let is_default = llms.default.as_deref() == Some(name.as_str());
            let pfx = if is_cursor { ">" } else { " " };
            let default_tag = if is_default { "  [default]" } else { "" };
            let detail = llms
                .configurations
                .get(name)
                .and_then(|c| c.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            let line =
                format!("  {pfx} {:<42} {}{}\r\n", name, detail, default_tag);
            if is_cursor {
                queue!(out, SetForegroundColor(Color::Yellow), Print(line), ResetColor)?;
            } else {
                queue!(out, Print(line))?;
            }
            lines += 1;
        }
    }

    if end < names.len() {
        queue!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  ↓ {} more\r\n", names.len() - end)),
            ResetColor,
        )?;
        lines += 1;
    }

    out.flush()?;
    Ok(lines)
}

fn llm_erase(lines: usize) -> anyhow::Result<()> {
    if lines == 0 {
        return Ok(());
    }
    let mut out = io::stdout();
    queue!(out, MoveUp(lines as u16), Clear(ClearType::FromCursorDown))?;
    out.flush()?;
    Ok(())
}

fn llm_suspend<F>(rendered_lines: &mut usize, f: F) -> anyhow::Result<()>
where
    F: FnOnce() -> anyhow::Result<()>,
{
    llm_erase(*rendered_lines)?;
    *rendered_lines = 0;
    execute!(io::stdout(), Show)?;
    disable_raw_mode()?;
    let result = f();
    enable_raw_mode()?;
    execute!(io::stdout(), Hide)?;
    result
}

fn add_llm_config(
    theme: &ColorfulTheme,
    base_dir: &Path,
    llms: &mut LLMsConfig,
) -> anyhow::Result<bool> {
    let providers = read_providers_config(base_dir)?;
    let provider_ids: Vec<String> = providers.providers.keys().cloned().collect();

    if provider_ids.is_empty() {
        display::hint("No providers configured. Run 'tenex config providers' first.");
        return Ok(false);
    }

    let Some(provider_idx) = Select::with_theme(theme)
        .with_prompt("Provider")
        .items(&provider_ids)
        .interact_opt()?
    else {
        return Ok(false);
    };
    let provider = provider_ids[provider_idx].clone();

    let entry = providers.providers.get(&provider);
    let Some(model) = select_model(theme, &provider, entry)? else {
        return Ok(false);
    };

    let default_name = format!("{provider}/{model}");
    let name: String = Input::with_theme(theme)
        .with_prompt("Configuration name")
        .default(default_name)
        .interact_text()?;
    let name = name.trim().to_string();

    llms.configurations
        .insert(name.clone(), json!({ "provider": provider, "model": model }));

    if llms.default.is_none() {
        llms.default = Some(name);
    }

    Ok(true)
}

fn edit_llm_config(
    theme: &ColorfulTheme,
    base_dir: &Path,
    llms: &mut LLMsConfig,
    name: &str,
) -> anyhow::Result<()> {
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

    let providers = read_providers_config(base_dir)?;
    let provider_ids: Vec<String> = providers.providers.keys().cloned().collect();

    let default_idx = provider_ids
        .iter()
        .position(|p| p == &cur_provider)
        .unwrap_or(0);

    let Some(provider_idx) = Select::with_theme(theme)
        .with_prompt("Provider")
        .items(&provider_ids)
        .default(default_idx)
        .interact_opt()?
    else {
        return Ok(());
    };
    let provider = provider_ids[provider_idx].clone();

    let entry = providers.providers.get(&provider);
    let model = select_model_with_default(theme, &provider, entry, &cur_model)?
        .unwrap_or(cur_model);

    llms.configurations
        .insert(name.to_string(), json!({ "provider": provider, "model": model }));

    Ok(())
}

fn select_model(
    theme: &ColorfulTheme,
    provider: &str,
    entry: Option<&ProviderEntry>,
) -> anyhow::Result<Option<String>> {
    select_model_with_default(theme, provider, entry, "")
}

fn select_model_with_default(
    theme: &ColorfulTheme,
    provider: &str,
    entry: Option<&ProviderEntry>,
    current: &str,
) -> anyhow::Result<Option<String>> {
    use dialoguer::FuzzySelect;

    let models = fetch_provider_models(provider, entry);

    if let Some(mut models) = models {
        if !models.is_empty() {
            models.sort_unstable();
            let default_idx = models.iter().position(|m| m == current).unwrap_or(0);
            let sel = FuzzySelect::with_theme(theme)
                .with_prompt("Model  (type to filter)")
                .items(&models)
                .default(default_idx)
                .interact_opt()?;
            return Ok(sel.map(|i: usize| models[i].clone()));
        }
    }

    // Fallback: free text if fetch failed or provider unknown
    let model: String = Input::with_theme(theme)
        .with_prompt("Model ID")
        .default(current.to_string())
        .interact_text()?;
    Ok(Some(model.trim().to_string()))
}

fn fetch_provider_models(provider: &str, entry: Option<&ProviderEntry>) -> Option<Vec<String>> {
    match provider {
        "anthropic" => fetch_anthropic_models(entry?.api_key.as_str()),
        "openai" => fetch_openai_models(entry?.api_key.as_str()),
        "openrouter" => fetch_openrouter_models(entry.map(|e| e.api_key.as_str()).unwrap_or("")),
        "ollama" => fetch_ollama_models(entry?.api_key.as_str()),
        _ => None,
    }
}

fn fetch_anthropic_models(api_key: &str) -> Option<Vec<String>> {
    let resp = reqwest::blocking::Client::new()
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .ok()?;
    let json: Value = resp.json().ok()?;
    Some(
        json.get("data")?
            .as_array()?
            .iter()
            .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
            .collect(),
    )
}

fn fetch_openai_models(api_key: &str) -> Option<Vec<String>> {
    let resp = reqwest::blocking::Client::new()
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .ok()?;
    let json: Value = resp.json().ok()?;
    Some(
        json.get("data")?
            .as_array()?
            .iter()
            .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
            .collect(),
    )
}

fn fetch_openrouter_models(api_key: &str) -> Option<Vec<String>> {
    let mut req = reqwest::blocking::Client::new()
        .get("https://openrouter.ai/api/v1/models");
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().ok()?;
    let json: Value = resp.json().ok()?;
    Some(
        json.get("data")?
            .as_array()?
            .iter()
            .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
            .collect(),
    )
}

fn fetch_ollama_models(base_url: &str) -> Option<Vec<String>> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = reqwest::blocking::get(&url).ok()?;
    let json: Value = resp.json().ok()?;
    Some(
        json.get("models")?
            .as_array()?
            .iter()
            .filter_map(|m| m.get("name")?.as_str().map(|s| s.to_string()))
            .collect(),
    )
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

// ── Telegram ──────────────────────────────────────────────────────────────────

fn run_telegram(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let agents_dir = base_dir.join("agents");

    loop {
        let agents = agent_store::load_agents(&agents_dir)?;

        if agents.is_empty() {
            display::hint("No agents found in the agents directory.");
            return Ok(());
        }

        display::blank();

        let items: Vec<String> = agents
            .iter()
            .map(|a| {
                if a.doc.get("telegram").and_then(|t| t.get("botToken")).is_some() {
                    format!("  {}  [telegram]", a.name)
                } else {
                    format!("  {}", a.name)
                }
            })
            .collect();

        let selection = Select::with_theme(theme)
            .with_prompt("Agent Telegram Config  (Esc to go back)")
            .items(&items)
            .interact_opt()?;

        let Some(idx) = selection else { break };
        let agent = &agents[idx];
        configure_agent_telegram(theme, &agent.name.clone(), &agent.path.clone(), agent.doc.clone())?;
    }

    Ok(())
}

fn configure_agent_telegram(
    theme: &ColorfulTheme,
    agent_name: &str,
    path: &std::path::Path,
    mut doc: Value,
) -> anyhow::Result<()> {
    loop {
        display::blank();

        let tg = doc.get("telegram");
        let has_token = tg
            .and_then(|t| t.get("botToken"))
            .and_then(|t| t.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let allow_dms = tg
            .and_then(|t| t.get("allowDMs"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let pub_reasoning = tg
            .and_then(|t| t.get("publishReasoningToTelegram"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let pub_conversation = tg
            .and_then(|t| t.get("publishConversationToTelegram"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let token_status = if has_token { "[configured]" } else { "[not set]" };
        let mut items = vec![
            format!("  Set bot token          {token_status}"),
            format!("  Allow DMs              [{}]", if allow_dms { "on" } else { "off" }),
            format!("  Publish reasoning      [{}]", if pub_reasoning { "on" } else { "off" }),
            format!("  Publish conversation   [{}]", if pub_conversation { "on" } else { "off" }),
        ];

        let has_telegram = tg.is_some();
        if has_telegram {
            items.push("  Remove telegram config".to_string());
        }

        let selection = Select::with_theme(theme)
            .with_prompt(agent_name)
            .items(&items)
            .interact_opt()?;

        let Some(idx) = selection else { break };

        if has_telegram && idx == items.len() - 1 {
            if let Value::Object(ref mut root) = doc {
                root.remove("telegram");
            }
            agent_store::write_agent_file(path, &doc)?;
            display::success("Telegram config removed");
            break;
        }

        match idx {
            0 => {
                let token: String = Password::with_theme(theme)
                    .with_prompt("Bot token (from @BotFather)")
                    .interact()?;
                let token = token.trim().to_string();
                ensure_telegram_object(&mut doc);
                if let Some(tg) = doc.get_mut("telegram").and_then(|v| v.as_object_mut()) {
                    tg.insert("botToken".to_string(), json!(token));
                }
                agent_store::write_agent_file(path, &doc)?;
                display::success("Bot token saved");
            }
            1 => {
                ensure_telegram_object(&mut doc);
                if let Some(tg) = doc.get_mut("telegram").and_then(|v| v.as_object_mut()) {
                    tg.insert("allowDMs".to_string(), json!(!allow_dms));
                }
                agent_store::write_agent_file(path, &doc)?;
                display::success(&format!(
                    "Allow DMs {}",
                    if !allow_dms { "enabled" } else { "disabled" }
                ));
            }
            2 => {
                ensure_telegram_object(&mut doc);
                if let Some(tg) = doc.get_mut("telegram").and_then(|v| v.as_object_mut()) {
                    tg.insert("publishReasoningToTelegram".to_string(), json!(!pub_reasoning));
                }
                agent_store::write_agent_file(path, &doc)?;
                display::success(&format!(
                    "Publish reasoning {}",
                    if !pub_reasoning { "enabled" } else { "disabled" }
                ));
            }
            3 => {
                ensure_telegram_object(&mut doc);
                if let Some(tg) = doc.get_mut("telegram").and_then(|v| v.as_object_mut()) {
                    tg.insert(
                        "publishConversationToTelegram".to_string(),
                        json!(!pub_conversation),
                    );
                }
                agent_store::write_agent_file(path, &doc)?;
                display::success(&format!(
                    "Publish conversation {}",
                    if !pub_conversation { "enabled" } else { "disabled" }
                ));
            }
            _ => {}
        }
    }

    Ok(())
}

fn ensure_telegram_object(doc: &mut Value) {
    if let Value::Object(root) = doc {
        root.entry("telegram".to_string())
            .or_insert_with(|| json!({}));
    }
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

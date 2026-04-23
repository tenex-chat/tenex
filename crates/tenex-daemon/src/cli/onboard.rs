use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bech32::{FromBase32, ToBase32, Variant};
use dialoguer::{Confirm, Input, Password, Select, theme::ColorfulTheme};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde_json::{Map, json};

use crate::backend_config::{
    backend_config_path, read_backend_config, write_backend_config_fields,
};
use crate::backend_events::heartbeat::BackendSigner;
use crate::backend_signer::HexBackendSigner;
use crate::llms_config::{LLMsConfig, read_llms_config, write_llms_config};
use crate::nostr_event::build_signed_event;
use crate::providers_config::{
    ProviderEntry, ProvidersConfig, read_providers_config, write_providers_config,
};
use crate::relay_publisher::publish_signed_event_to_relay;

use super::display;

const TENEX_COMMUNITY_RELAY: &str = "wss://relay.tenex.chat";

const PROVIDER_ANTHROPIC: &str = "anthropic";
const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_OPENROUTER: &str = "openrouter";
const PROVIDER_OLLAMA: &str = "ollama";

pub struct OnboardOptions {
    pub pubkeys: Vec<String>,
    pub local_relay_url: Option<String>,
    pub json: bool,
}

struct Identity {
    user_privkey_hex: String,
    user_pubkey_hex: String,
    nsec: String,
    npub: String,
    username: Option<String>,
}

pub fn run_onboard(options: OnboardOptions, base_dir: &Path) -> anyhow::Result<()> {
    let theme = display::amber_theme();

    if !options.json {
        display::welcome();
    }

    // ── Step 1: Identity ─────────────────────────────────────────────────────
    if !options.json {
        display::step(1, 5, "Identity");
        display::context(
            "Your identity is how your agents know you, and how others can reach you.",
        );
        display::blank();
    }

    let identity = if !options.pubkeys.is_empty() {
        // Pubkeys provided via CLI flag — use them directly, no user private key for signing
        None
    } else {
        let choices = vec![
            "Create a new identity",
            "I have an existing one (import nsec)",
        ];
        let selection = Select::with_theme(&theme)
            .with_prompt("Identity")
            .items(&choices)
            .default(0)
            .interact()?;

        Some(if selection == 0 {
            create_new_identity(&theme)?
        } else {
            import_identity(&theme)?
        })
    };

    let (whitelisted_pubkeys, user_privkey_hex): (Vec<String>, Option<String>) =
        if let Some(ref id) = identity {
            if !options.json {
                display::blank();
                display::success("Identity created");
                display::blank();
                display::summary_line("username", id.username.as_deref().unwrap_or("(none)"));
                display::summary_line("npub", &id.npub);
                display::summary_line("nsec", &id.nsec);
                display::blank();
                display::hint("Save your nsec somewhere safe. You won't be able to recover it.");
                display::blank();
            }
            (
                vec![id.user_pubkey_hex.clone()],
                Some(id.user_privkey_hex.clone()),
            )
        } else {
            let pubkeys = options
                .pubkeys
                .iter()
                .filter_map(|pk| decode_to_pubkey_hex(pk).ok())
                .collect();
            (pubkeys, None)
        };

    // Auto-generate daemon key if not present
    let daemon_key = ensure_daemon_key(base_dir)?;

    // ── Step 2: Relay ─────────────────────────────────────────────────────────
    if !options.json {
        display::step(2, 5, "Communication");
        display::context("Choose a relay for your agents to communicate through.");
        display::blank();
    }

    let relay = pick_relay(&theme, options.local_relay_url.as_deref())?;
    let relays = vec![relay.clone()];

    // ── Auto-detect providers ─────────────────────────────────────────────────
    let existing_providers = read_providers_config(base_dir)?;
    let (detected_providers, detected_labels) = auto_detect_providers(&existing_providers);

    if !options.json && !detected_labels.is_empty() {
        for label in &detected_labels {
            display::success(&format!("Detected: {label}"));
        }
        display::blank();
    }

    // ── Step 3: Providers ─────────────────────────────────────────────────────
    if !options.json {
        display::step(3, 5, "AI Providers");
        display::context("Connect the AI services your agents will use. You need at least one.");
        display::blank();
    }

    let providers = configure_providers(&theme, detected_providers)?;

    // ── Step 4: LLM seeding ───────────────────────────────────────────────────
    if !options.json {
        display::step(4, 5, "Models");
        display::blank();
    }

    let mut llms = read_llms_config(base_dir)?;
    if llms.configurations.is_empty() {
        seed_llm_configs(&mut llms, &providers);
        if !options.json {
            for name in llms.configurations.keys() {
                display::success(&format!("Seeded model: {name}"));
            }
            display::blank();
        }
    }

    // Auto-assign roles if only one config
    if llms.configurations.len() == 1 {
        let name = llms.configurations.keys().next().unwrap().clone();
        llms.default = Some(name.clone());
        llms.summarization = Some(name.clone());
        llms.supervision = Some(name.clone());
        llms.prompt_compilation = Some(name.clone());
        llms.categorization = Some(name);
    } else if llms.configurations.len() > 1 {
        // ── Step 5: Model roles ───────────────────────────────────────────────
        if !options.json {
            display::step(5, 5, "Model Roles");
            display::blank();
        }
        configure_roles(&theme, &mut llms)?;
    }

    // ── Meta project (optional) ───────────────────────────────────────────────
    if let Some(ref privkey_hex) = user_privkey_hex {
        if !options.json {
            display::blank();
            let create = Confirm::with_theme(&theme)
                .with_prompt("Create a \"Meta\" project?")
                .default(true)
                .interact()?;

            if create {
                publish_meta_project(privkey_hex, &relay, identity.as_ref())?;
                display::success("Published \"Meta\" project to relay.");
            }
        }
    }

    // ── Save all config ───────────────────────────────────────────────────────
    let projects_base = dirs_home().join("tenex");
    std::fs::create_dir_all(&projects_base)?;

    let mut fields = Map::new();
    fields.insert("whitelistedPubkeys".to_string(), json!(whitelisted_pubkeys));
    fields.insert("tenexPrivateKey".to_string(), json!(daemon_key));
    fields.insert("relays".to_string(), json!(relays));
    fields.insert(
        "projectsBase".to_string(),
        json!(projects_base.to_string_lossy().as_ref()),
    );
    write_backend_config_fields(base_dir, &fields)?;

    write_providers_config(base_dir, &providers)?;
    write_llms_config(base_dir, &llms)?;

    // ── Output ────────────────────────────────────────────────────────────────
    if options.json {
        let mut output = serde_json::Map::new();
        if let Some(ref id) = identity {
            output.insert("npub".to_string(), json!(id.npub));
            output.insert("pubkey".to_string(), json!(id.user_pubkey_hex));
            output.insert("nsec".to_string(), json!(id.nsec));
        } else if let Some(pk) = whitelisted_pubkeys.first() {
            output.insert("pubkey".to_string(), json!(pk));
        }
        output.insert(
            "projectsBase".to_string(),
            json!(projects_base.to_string_lossy().as_ref()),
        );
        output.insert("relays".to_string(), json!(relays));
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        display::setup_complete();
        if let Some(ref id) = identity {
            display::summary_line("Identity", &id.npub);
            display::summary_line("nsec", &id.nsec);
        } else if let Some(pk) = whitelisted_pubkeys.first() {
            display::summary_line("Identity", pk);
        }
        display::summary_line("Projects", &projects_base.to_string_lossy());
        display::summary_line("Relay", &relay);
        display::blank();
    }

    Ok(())
}

// ── Identity helpers ──────────────────────────────────────────────────────────

fn create_new_identity(theme: &ColorfulTheme) -> anyhow::Result<Identity> {
    let secp = Secp256k1::new();
    let (secret_key, keypair) = loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("key generation failed: {e}"))?;
        if let Ok(sk) = SecretKey::from_byte_array(bytes) {
            let kp = Keypair::from_secret_key(&secp, &sk);
            break (sk, kp);
        }
    };

    let privkey_bytes = secret_key.secret_bytes();
    let nsec = bech32::encode("nsec", privkey_bytes.to_base32(), Variant::Bech32)?;

    let (xonly, _) = keypair.x_only_public_key();
    let pubkey_bytes = xonly.serialize();
    let npub = bech32::encode("npub", pubkey_bytes.to_base32(), Variant::Bech32)?;
    let pubkey_hex = hex::encode(pubkey_bytes);
    let privkey_hex = hex::encode(privkey_bytes);

    let random_name = random_username();
    let username: String = Input::with_theme(theme)
        .with_prompt("Username (how agents and other Nostr users see you)")
        .default(random_name)
        .interact_text()?;

    Ok(Identity {
        user_privkey_hex: privkey_hex,
        user_pubkey_hex: pubkey_hex,
        nsec,
        npub,
        username: Some(username.trim().to_string()),
    })
}

fn import_identity(theme: &ColorfulTheme) -> anyhow::Result<Identity> {
    loop {
        let nsec_input: String = Password::with_theme(theme)
            .with_prompt("Paste your nsec (hidden)")
            .interact()?;
        let nsec_input = nsec_input.trim().to_string();

        match bech32::decode(&nsec_input) {
            Ok((hrp, data, _)) if hrp == "nsec" => {
                let privkey_bytes =
                    Vec::<u8>::from_base32(&data).map_err(|e| anyhow::anyhow!("{e}"))?;
                if privkey_bytes.len() != 32 {
                    eprintln!("Invalid nsec length");
                    continue;
                }
                let privkey_arr: [u8; 32] = privkey_bytes.try_into().unwrap();
                let sk = SecretKey::from_byte_array(privkey_arr)
                    .map_err(|e| anyhow::anyhow!("invalid key: {e}"))?;
                let secp = Secp256k1::new();
                let kp = Keypair::from_secret_key(&secp, &sk);
                let (xonly, _) = kp.x_only_public_key();
                let pubkey_bytes = xonly.serialize();
                let npub = bech32::encode("npub", pubkey_bytes.to_base32(), Variant::Bech32)?;

                display::blank();
                display::success("Identity imported");
                display::summary_line("npub", &npub);
                display::blank();

                return Ok(Identity {
                    user_privkey_hex: hex::encode(privkey_arr),
                    user_pubkey_hex: hex::encode(pubkey_bytes),
                    nsec: nsec_input,
                    npub,
                    username: None,
                });
            }
            _ => {
                eprintln!("  Invalid nsec. Please try again.");
            }
        }
    }
}

fn decode_to_pubkey_hex(identifier: &str) -> anyhow::Result<String> {
    // Raw hex pubkey
    if identifier.len() == 64 && identifier.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(identifier.to_string());
    }
    let (hrp, data, _) = bech32::decode(identifier)?;
    let bytes = Vec::<u8>::from_base32(&data)?;
    match hrp.as_str() {
        "npub" => Ok(hex::encode(bytes)),
        "nprofile" => {
            // nprofile TLV: type 0 = pubkey (32 bytes)
            if bytes.len() >= 34 && bytes[0] == 0 && bytes[1] == 32 {
                Ok(hex::encode(&bytes[2..34]))
            } else {
                Err(anyhow::anyhow!("cannot parse nprofile pubkey"))
            }
        }
        _ => Err(anyhow::anyhow!("unsupported bech32 type: {hrp}")),
    }
}

fn ensure_daemon_key(base_dir: &Path) -> anyhow::Result<String> {
    // If config exists and has a key, use it
    let config_path = backend_config_path(base_dir);
    if config_path.exists() {
        if let Ok(snapshot) = read_backend_config(base_dir) {
            if let Some(key) = snapshot.tenex_private_key {
                if !key.trim().is_empty() {
                    return Ok(key);
                }
            }
        }
    }
    // Generate a new one
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("key gen failed: {e}"))?;
        if SecretKey::from_byte_array(bytes).is_ok() {
            return Ok(hex::encode(bytes));
        }
    }
}

// ── Relay selection ───────────────────────────────────────────────────────────

fn pick_relay(theme: &ColorfulTheme, local_relay_url: Option<&str>) -> anyhow::Result<String> {
    let mut items: Vec<String> = Vec::new();

    if let Some(local) = local_relay_url {
        items.push(format!("Local relay ({local})"));
    }
    items.push(format!("TENEX Community Relay ({})", TENEX_COMMUNITY_RELAY));
    items.push("Enter a custom relay URL".to_string());

    let local_offset = if local_relay_url.is_some() { 1 } else { 0 };
    let custom_idx = items.len() - 1;

    let selection = Select::with_theme(theme)
        .with_prompt("Relay")
        .items(&items)
        .default(0)
        .interact()?;

    if local_relay_url.is_some() && selection == 0 {
        return Ok(local_relay_url.unwrap().to_string());
    }
    if selection == local_offset {
        return Ok(TENEX_COMMUNITY_RELAY.to_string());
    }
    if selection == custom_idx {
        return prompt_relay_url(theme);
    }
    Ok(TENEX_COMMUNITY_RELAY.to_string())
}

fn prompt_relay_url(theme: &ColorfulTheme) -> anyhow::Result<String> {
    loop {
        let input: String = Input::with_theme(theme)
            .with_prompt("Relay URL (wss://...)")
            .interact_text()?;
        let input = input.trim().to_string();
        match url::Url::parse(&input) {
            Ok(u) if matches!(u.scheme(), "ws" | "wss") && u.host().is_some() => {
                return Ok(input);
            }
            _ => {
                eprintln!("  Invalid relay URL. Must start with ws:// or wss://");
            }
        }
    }
}

// ── Provider detection & setup ────────────────────────────────────────────────

fn auto_detect_providers(existing: &ProvidersConfig) -> (ProvidersConfig, Vec<String>) {
    let mut result = existing.clone();
    let mut labels = Vec::new();

    let env_map = [
        (
            "ANTHROPIC_API_KEY",
            PROVIDER_ANTHROPIC,
            "Anthropic (from ANTHROPIC_API_KEY)",
        ),
        (
            "OPENAI_API_KEY",
            PROVIDER_OPENAI,
            "OpenAI (from OPENAI_API_KEY)",
        ),
        (
            "OPENROUTER_API_KEY",
            PROVIDER_OPENROUTER,
            "OpenRouter (from OPENROUTER_API_KEY)",
        ),
    ];
    for (var, provider_id, label) in env_map {
        if let Ok(key) = std::env::var(var) {
            if !key.is_empty() && !result.providers.contains_key(provider_id) {
                result.providers.insert(
                    provider_id.to_string(),
                    ProviderEntry {
                        api_key: key,
                        base_url: None,
                    },
                );
                labels.push(label.to_string());
            }
        }
    }
    // Anthropic OAuth token
    if let Ok(token) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
        if token.starts_with("sk-ant-oat") && !result.providers.contains_key(PROVIDER_ANTHROPIC) {
            result.providers.insert(
                PROVIDER_ANTHROPIC.to_string(),
                ProviderEntry {
                    api_key: token,
                    base_url: None,
                },
            );
            labels.push("Anthropic (from ANTHROPIC_AUTH_TOKEN)".to_string());
        }
    }

    // Ollama
    if !result.providers.contains_key(PROVIDER_OLLAMA) && ollama_reachable() {
        result.providers.insert(
            PROVIDER_OLLAMA.to_string(),
            ProviderEntry {
                api_key: "http://localhost:11434".to_string(),
                base_url: None,
            },
        );
        labels.push("Ollama (localhost:11434)".to_string());
    }

    (result, labels)
}

fn ollama_reachable() -> bool {
    match Command::new("sh")
        .args(["-c", "command -v ollama"])
        .output()
    {
        Ok(o) if o.status.success() => {}
        _ => return false,
    }
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|c| c.get("http://localhost:11434/api/tags").send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn configure_providers(
    theme: &ColorfulTheme,
    mut detected: ProvidersConfig,
) -> anyhow::Result<ProvidersConfig> {
    let provider_menu = [
        (PROVIDER_ANTHROPIC, "Anthropic (Claude models)"),
        (PROVIDER_OPENAI, "OpenAI (GPT-4o, etc.)"),
        (PROVIDER_OPENROUTER, "OpenRouter (many models)"),
        (PROVIDER_OLLAMA, "Ollama (local models)"),
    ];

    let pre_checked: Vec<bool> = provider_menu
        .iter()
        .map(|(id, _)| detected.providers.contains_key(*id))
        .collect();

    let items: Vec<String> = provider_menu
        .iter()
        .zip(pre_checked.iter())
        .map(|((_, label), checked)| {
            if *checked {
                format!("{label} [detected]")
            } else {
                label.to_string()
            }
        })
        .collect();

    let selections = dialoguer::MultiSelect::with_theme(theme)
        .with_prompt("Select AI providers (space to toggle, enter to confirm)")
        .items(&items)
        .defaults(&pre_checked)
        .interact()?;

    // Prompt API keys for selected providers that don't have one yet
    for &i in &selections {
        let (provider_id, _) = provider_menu[i];
        if detected.providers.contains_key(provider_id) {
            continue;
        }
        let entry = if provider_id == PROVIDER_OLLAMA {
            let base_url: String = Input::with_theme(theme)
                .with_prompt("Ollama base URL")
                .default("http://localhost:11434".to_string())
                .interact_text()?;
            ProviderEntry {
                api_key: "http://localhost:11434".to_string(),
                base_url: Some(base_url),
            }
        } else {
            let key: String = Password::with_theme(theme)
                .with_prompt(format!("{} API key", provider_menu[i].1))
                .interact()?;
            ProviderEntry {
                api_key: key.trim().to_string(),
                base_url: None,
            }
        };
        detected.providers.insert(provider_id.to_string(), entry);
    }

    // Remove providers not selected
    let selected_ids: Vec<&str> = selections.iter().map(|&i| provider_menu[i].0).collect();
    detected
        .providers
        .retain(|id, _| selected_ids.contains(&id.as_str()));

    Ok(detected)
}

// ── LLM seeding ───────────────────────────────────────────────────────────────

fn seed_llm_configs(llms: &mut LLMsConfig, providers: &ProvidersConfig) {
    let has_anthropic = providers.providers.contains_key(PROVIDER_ANTHROPIC);
    let has_openai = providers.providers.contains_key(PROVIDER_OPENAI);

    if has_anthropic {
        llms.configurations.insert(
            "Sonnet".to_string(),
            json!({
                "provider": "anthropic",
                "model": "claude-sonnet-4-6"
            }),
        );
        llms.configurations.insert(
            "Opus".to_string(),
            json!({
                "provider": "anthropic",
                "model": "claude-opus-4-6"
            }),
        );
        llms.configurations.insert(
            "Auto".to_string(),
            json!({
                "provider": "meta",
                "variants": {
                    "fast": {
                        "model": "Sonnet",
                        "keywords": ["quick", "fast"],
                        "description": "Fast, lightweight tasks"
                    },
                    "powerful": {
                        "model": "Opus",
                        "keywords": ["think", "ultrathink", "ponder"],
                        "description": "Most capable, complex reasoning"
                    }
                },
                "default": "fast"
            }),
        );
        llms.default = Some("Auto".to_string());
    }

    if has_openai {
        llms.configurations.insert(
            "GPT-4o".to_string(),
            json!({
                "provider": "openai",
                "model": "gpt-4o"
            }),
        );
        if llms.default.is_none() {
            llms.default = Some("GPT-4o".to_string());
        }
    }
}

// ── Model role assignment ─────────────────────────────────────────────────────

struct RoleSpec {
    key: &'static str,
    label: &'static str,
}

const ROLES: &[RoleSpec] = &[
    RoleSpec {
        key: "default",
        label: "Default (all-rounder)",
    },
    RoleSpec {
        key: "summarization",
        label: "Summarization (cheap + large context)",
    },
    RoleSpec {
        key: "supervision",
        label: "Supervision (strongest reasoning)",
    },
    RoleSpec {
        key: "promptCompilation",
        label: "Prompt compilation (smart + large context)",
    },
    RoleSpec {
        key: "categorization",
        label: "Categorization (cheap + fast)",
    },
];

fn configure_roles(theme: &ColorfulTheme, llms: &mut LLMsConfig) -> anyhow::Result<()> {
    let names: Vec<String> = llms.configurations.keys().cloned().collect();

    for role in ROLES {
        let current = match role.key {
            "default" => llms.default.clone(),
            "summarization" => llms.summarization.clone(),
            "supervision" => llms.supervision.clone(),
            "promptCompilation" => llms.prompt_compilation.clone(),
            "categorization" => llms.categorization.clone(),
            _ => None,
        }
        .unwrap_or_else(|| names[0].clone());

        let default_idx = names.iter().position(|n| n == &current).unwrap_or(0);
        let selected = Select::with_theme(theme)
            .with_prompt(role.label)
            .items(&names)
            .default(default_idx)
            .interact()?;

        let chosen = names[selected].clone();
        match role.key {
            "default" => llms.default = Some(chosen),
            "summarization" => llms.summarization = Some(chosen),
            "supervision" => llms.supervision = Some(chosen),
            "promptCompilation" => llms.prompt_compilation = Some(chosen),
            "categorization" => llms.categorization = Some(chosen),
            _ => {}
        }
    }

    Ok(())
}

// ── Meta project publication ──────────────────────────────────────────────────

fn publish_meta_project(
    user_privkey_hex: &str,
    relay: &str,
    identity: Option<&Identity>,
) -> anyhow::Result<()> {
    let signer = HexBackendSigner::from_private_key_hex(user_privkey_hex)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let pubkey_hex = signer.pubkey_hex().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let timeout = Duration::from_secs(10);

    // Publish kind:0 profile if we have a username
    if let Some(id) = identity {
        if let Some(ref username) = id.username {
            let avatar_style_idx = u64::from_str_radix(&pubkey_hex[..8], 16).unwrap_or(0) % 6;
            let avatar_styles = [
                "lorelei",
                "miniavs",
                "dylan",
                "pixel-art",
                "rings",
                "avataaars",
            ];
            let style = avatar_styles[avatar_style_idx as usize];
            let avatar_url = format!("https://api.dicebear.com/7.x/{style}/png?seed={pubkey_hex}");

            let profile_content = serde_json::json!({
                "name": username,
                "picture": avatar_url
            });

            let profile_event = build_signed_event(
                0,
                serde_json::to_string(&profile_content)?,
                vec![],
                &pubkey_hex,
                now,
                |digest| signer.sign_schnorr(digest),
            )?;

            let _ = publish_signed_event_to_relay(relay, &profile_event, timeout);
        }
    }

    // Publish kind:31933 Meta project
    let project_tags = vec![
        vec!["d".to_string(), "meta".to_string()],
        vec!["title".to_string(), "Meta".to_string()],
        vec!["client".to_string(), "tenex-setup".to_string()],
    ];

    let project_event = build_signed_event(
        31933,
        String::new(),
        project_tags,
        &pubkey_hex,
        now,
        |digest| signer.sign_schnorr(digest),
    )?;

    let _ = publish_signed_event_to_relay(relay, &project_event, timeout);

    Ok(())
}

// ── Utilities ─────────────────────────────────────────────────────────────────

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
}

fn random_username() -> String {
    const ADJECTIVES: &[&str] = &[
        "swift", "bright", "calm", "bold", "keen", "warm", "wild", "cool", "fair", "glad", "brave",
        "clever", "deft", "eager", "fierce", "gentle", "happy", "jolly", "kind", "lively",
    ];
    const NOUNS: &[&str] = &[
        "fox", "owl", "bear", "wolf", "hawk", "deer", "lynx", "crow", "hare", "wren", "otter",
        "raven", "crane", "finch", "panda", "tiger", "eagle", "cobra", "bison", "whale",
    ];
    let mut seed = [0u8; 4];
    let _ = getrandom::fill(&mut seed);
    let adj_idx = u32::from_le_bytes(seed) as usize % ADJECTIVES.len();
    let _ = getrandom::fill(&mut seed);
    let noun_idx = u32::from_le_bytes(seed) as usize % NOUNS.len();
    format!("{}-{}", ADJECTIVES[adj_idx], NOUNS[noun_idx])
}

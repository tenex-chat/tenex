use std::fs;
use std::io;
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bech32::{ToBase32, Variant};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, connect};

use crate::agent_definition_watcher::{
    AGENT_DEFINITION_WATCHER_SCHEMA_VERSION, AGENT_DEFINITION_WATCHER_WRITER, AgentDefinitionEntry,
    AgentDefinitionSnapshot, AgentDefinitionWatcherError, read_agent_definitions,
    write_agent_definitions,
};
use crate::nostr_event::SignedNostrEvent;

const KIND_AGENT_DEFINITION: u64 = 4199;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_SUBSCRIPTION_ID: &str = "tenex-agent-install";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallOutcome {
    pub agent_pubkey: String,
    pub slug: String,
    pub definition_event_id: String,
    pub already_installed: bool,
}

#[derive(Debug, Error)]
pub enum AgentInstallError {
    #[error("agent create event has no e-tag referencing the definition event")]
    MissingDefinitionEventId,
    #[error("agent definition event {event_id} not found on any relay")]
    DefinitionNotFound { event_id: String },
    #[error("agent definition event {event_id} is missing a title tag")]
    MissingTitle { event_id: String },
    #[error("agent definition event {event_id} has an empty slug (d tag)")]
    EmptySlug { event_id: String },
    #[error("relay url {url:?} is not a valid websocket url")]
    InvalidRelayUrl { url: String },
    #[error("websocket error while fetching definition: {0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("key generation failed: {0}")]
    KeyGeneration(String),
    #[error("io error writing agent file: {0}")]
    Io(#[from] io::Error),
    #[error("agent definitions index error: {0}")]
    DefinitionWatcher(#[from] AgentDefinitionWatcherError),
}

pub fn install_agent_from_nostr(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    create_event: &SignedNostrEvent,
    relay_urls: &[String],
    writer_version: &str,
    timestamp: u64,
) -> Result<AgentInstallOutcome, AgentInstallError> {
    let definition_event_id = extract_definition_event_id(create_event)?;

    // Check if already installed by looking at agent-definitions.json
    if let Some(existing) = find_existing_entry(daemon_dir, &definition_event_id) {
        return Ok(AgentInstallOutcome {
            agent_pubkey: existing.agent_pubkey,
            slug: existing.slug,
            definition_event_id,
            already_installed: true,
        });
    }

    let definition = fetch_definition_event(&definition_event_id, relay_urls)?;
    let parsed = parse_definition_event(&definition)?;
    let (secret_key, pubkey_hex) = generate_keypair()?;
    let nsec = encode_nsec(&secret_key);

    write_agent_config(tenex_base_dir, &pubkey_hex, &nsec, &parsed)?;
    upsert_agent_definitions(
        daemon_dir,
        &pubkey_hex,
        &parsed,
        &definition_event_id,
        writer_version,
        timestamp,
    )?;

    Ok(AgentInstallOutcome {
        agent_pubkey: pubkey_hex,
        slug: parsed.slug,
        definition_event_id,
        already_installed: false,
    })
}

fn extract_definition_event_id(event: &SignedNostrEvent) -> Result<String, AgentInstallError> {
    for tag in &event.tags {
        if tag.first().map(String::as_str) == Some("e") {
            if let Some(event_id) = tag.get(1) {
                if !event_id.is_empty() {
                    return Ok(event_id.clone());
                }
            }
        }
    }
    Err(AgentInstallError::MissingDefinitionEventId)
}

fn find_existing_entry(
    daemon_dir: &Path,
    definition_event_id: &str,
) -> Option<AgentDefinitionEntry> {
    let snapshot = read_agent_definitions(daemon_dir).ok()??;
    snapshot
        .definitions
        .into_iter()
        .find(|entry| entry.event_id == definition_event_id)
}

struct ParsedDefinition {
    slug: String,
    title: String,
    role: Option<String>,
    instructions: Option<String>,
    use_criteria: Option<String>,
    category: Option<String>,
    tools: Vec<String>,
    created_at: u64,
    author_pubkey: String,
}

fn parse_definition_event(event: &SignedNostrEvent) -> Result<ParsedDefinition, AgentInstallError> {
    let title = event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some("title"))
        .and_then(|tag| tag.get(1))
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| AgentInstallError::MissingTitle {
            event_id: event.id.clone(),
        })?;

    let slug_from_d_tag = event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some("d"))
        .and_then(|tag| tag.get(1))
        .filter(|v| !v.is_empty())
        .cloned();

    let slug = slug_from_d_tag.unwrap_or_else(|| to_kebab_case(&title));

    if slug.is_empty() {
        return Err(AgentInstallError::EmptySlug {
            event_id: event.id.clone(),
        });
    }

    let role = tag_value(event, "role");
    let instructions = tag_value(event, "instructions");
    let use_criteria = tag_value(event, "use-criteria");
    let category = tag_value(event, "category");

    let tools = event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("tool"))
        .filter_map(|tag| tag.get(1).cloned())
        .filter(|v| !v.is_empty())
        .collect();

    Ok(ParsedDefinition {
        slug,
        title,
        role,
        instructions,
        use_criteria,
        category,
        tools,
        created_at: event.created_at,
        author_pubkey: event.pubkey.clone(),
    })
}

fn tag_value(event: &SignedNostrEvent, name: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.get(1))
        .filter(|v| !v.is_empty())
        .cloned()
}

fn to_kebab_case(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut prev_was_separator = true;
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            result.push(ch.to_lowercase().next().unwrap_or(ch));
            prev_was_separator = false;
        } else if !prev_was_separator {
            result.push('-');
            prev_was_separator = true;
        }
    }
    result.trim_end_matches('-').to_string()
}

fn generate_keypair() -> Result<(SecretKey, String), AgentInstallError> {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| AgentInstallError::KeyGeneration(error.to_string()))?;
        if let Ok(secret) = SecretKey::from_byte_array(bytes) {
            let secp = Secp256k1::new();
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            let pubkey_hex = hex::encode(xonly.serialize());
            return Ok((secret, pubkey_hex));
        }
    }
}

fn encode_nsec(secret: &SecretKey) -> String {
    bech32::encode("nsec", secret.secret_bytes().to_base32(), Variant::Bech32)
        .expect("valid secret key must encode as nsec bech32")
}

fn write_agent_config(
    tenex_base_dir: &Path,
    pubkey_hex: &str,
    nsec: &str,
    parsed: &ParsedDefinition,
) -> Result<(), AgentInstallError> {
    let agents_dir = tenex_base_dir.join("agents");
    fs::create_dir_all(&agents_dir)?;

    let mut doc = serde_json::Map::new();
    doc.insert("nsec".to_string(), Value::String(nsec.to_string()));
    doc.insert("slug".to_string(), Value::String(parsed.slug.clone()));
    doc.insert("name".to_string(), Value::String(parsed.title.clone()));
    doc.insert("status".to_string(), Value::String("active".to_string()));

    if let Some(ref role) = parsed.role {
        doc.insert("role".to_string(), Value::String(role.clone()));
    }
    if let Some(ref instructions) = parsed.instructions {
        doc.insert(
            "instructions".to_string(),
            Value::String(instructions.clone()),
        );
    }
    if let Some(ref use_criteria) = parsed.use_criteria {
        doc.insert(
            "useCriteria".to_string(),
            Value::String(use_criteria.clone()),
        );
    }
    if let Some(ref category) = parsed.category {
        doc.insert("category".to_string(), Value::String(category.clone()));
    }

    let mut default_config = serde_json::Map::new();
    if !parsed.tools.is_empty() {
        default_config.insert(
            "tools".to_string(),
            Value::Array(
                parsed
                    .tools
                    .iter()
                    .map(|t| Value::String(t.clone()))
                    .collect(),
            ),
        );
    }
    if !default_config.is_empty() {
        doc.insert("default".to_string(), Value::Object(default_config));
    }

    let agent_file = agents_dir.join(format!("{pubkey_hex}.json"));
    let tmp_path = agent_file.with_extension(format!("json.tmp.{}", std::process::id()));
    let serialized = serde_json::to_string_pretty(&Value::Object(doc))?;
    fs::write(&tmp_path, serialized)?;
    fs::rename(&tmp_path, &agent_file)?;

    Ok(())
}

fn upsert_agent_definitions(
    daemon_dir: &Path,
    agent_pubkey: &str,
    parsed: &ParsedDefinition,
    definition_event_id: &str,
    writer_version: &str,
    timestamp: u64,
) -> Result<(), AgentInstallError> {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(timestamp / 1_000);

    let mut existing =
        read_agent_definitions(daemon_dir)?.unwrap_or_else(|| AgentDefinitionSnapshot {
            schema_version: AGENT_DEFINITION_WATCHER_SCHEMA_VERSION,
            writer: AGENT_DEFINITION_WATCHER_WRITER.to_string(),
            writer_version: writer_version.to_string(),
            updated_at: now_secs,
            definitions: Vec::new(),
        });

    let new_entry = AgentDefinitionEntry {
        event_id: definition_event_id.to_string(),
        author_pubkey: parsed.author_pubkey.clone(),
        agent_pubkey: agent_pubkey.to_string(),
        slug: parsed.slug.clone(),
        name: Some(parsed.title.clone()),
        description: None,
        instructions: parsed.instructions.clone(),
        tools: parsed.tools.clone(),
        skills: Vec::new(),
        mcp_servers: Vec::new(),
        created_at: parsed.created_at,
        last_observed_at: now_secs,
    };

    // Replace existing entry for this definition event ID if present, otherwise append.
    let replaced = existing
        .definitions
        .iter()
        .any(|entry| entry.event_id == definition_event_id);
    if replaced {
        existing
            .definitions
            .retain(|entry| entry.event_id != definition_event_id);
    }
    existing.definitions.push(new_entry);
    existing.writer = AGENT_DEFINITION_WATCHER_WRITER.to_string();
    existing.writer_version = writer_version.to_string();
    existing.updated_at = now_secs;

    write_agent_definitions(daemon_dir, &existing)?;

    Ok(())
}

fn fetch_definition_event(
    definition_event_id: &str,
    relay_urls: &[String],
) -> Result<SignedNostrEvent, AgentInstallError> {
    for relay_url in relay_urls {
        if let Some(event) = try_fetch_from_relay(relay_url, definition_event_id)? {
            return Ok(event);
        }
    }
    Err(AgentInstallError::DefinitionNotFound {
        event_id: definition_event_id.to_string(),
    })
}

fn try_fetch_from_relay(
    relay_url: &str,
    event_id: &str,
) -> Result<Option<SignedNostrEvent>, AgentInstallError> {
    if !relay_url.starts_with("ws://") && !relay_url.starts_with("wss://") {
        return Err(AgentInstallError::InvalidRelayUrl {
            url: relay_url.to_string(),
        });
    }

    let (mut socket, _) = connect(relay_url)?;
    set_stream_timeouts(socket.get_mut(), FETCH_TIMEOUT);

    let req = json!(["REQ", FETCH_SUBSCRIPTION_ID, {
        "kinds": [KIND_AGENT_DEFINITION],
        "ids": [event_id],
        "limit": 1
    }]);
    socket.send(Message::text(serde_json::to_string(&req)?))?;

    let mut found: Option<SignedNostrEvent> = None;

    loop {
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(io_err))
                if io_err.kind() == io::ErrorKind::WouldBlock
                    || io_err.kind() == io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(error) => return Err(error.into()),
        };

        match message {
            Message::Text(text) => {
                let value: Value = match serde_json::from_str(text.as_str()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let frame = match value.as_array() {
                    Some(f) => f,
                    None => continue,
                };
                match frame.first().and_then(Value::as_str) {
                    Some("EVENT") => {
                        if let Some(event_value) = frame.get(2) {
                            if let Ok(event) =
                                serde_json::from_value::<SignedNostrEvent>(event_value.clone())
                            {
                                if event.id == event_id && event.kind == KIND_AGENT_DEFINITION {
                                    found = Some(event);
                                }
                            }
                        }
                    }
                    Some("EOSE") => break,
                    Some("CLOSED") => break,
                    _ => {}
                }
            }
            Message::Close(_) => break,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    let _ = socket.close(None);
    Ok(found)
}

fn set_stream_timeouts(stream: &mut MaybeTlsStream<TcpStream>, timeout: Duration) {
    match stream {
        MaybeTlsStream::Plain(tcp) => {
            let _ = tcp.set_read_timeout(Some(timeout));
            let _ = tcp.set_write_timeout(Some(timeout));
        }
        MaybeTlsStream::Rustls(tls) => {
            let tcp = tls.get_mut();
            let _ = tcp.set_read_timeout(Some(timeout));
            let _ = tcp.set_write_timeout(Some(timeout));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};

    fn pubkey_hex(fill_byte: u8) -> String {
        let secp = Secp256k1::new();
        let secret = SecretKey::from_byte_array([fill_byte; 32]).expect("valid secret");
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn event_id_hex(fill_byte: u8) -> String {
        format!("{fill_byte:02x}").repeat(32)
    }

    fn signed_event(kind: u64, tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: event_id_hex(0xab),
            pubkey: pubkey_hex(0x11),
            created_at: 1_710_000_000,
            kind,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: String::new(),
            sig: "0".repeat(128),
        }
    }

    #[test]
    fn extracts_definition_event_id_from_e_tag() {
        let event_id = event_id_hex(0xcc);
        let event = signed_event(24001, vec![vec!["e", event_id.as_str()]]);
        let extracted = extract_definition_event_id(&event).expect("e tag must be extracted");
        assert_eq!(extracted, event_id);
    }

    #[test]
    fn missing_e_tag_returns_error() {
        let event = signed_event(24001, vec![vec!["p", pubkey_hex(0x22).as_str()]]);
        assert!(matches!(
            extract_definition_event_id(&event),
            Err(AgentInstallError::MissingDefinitionEventId)
        ));
    }

    #[test]
    fn parses_definition_event_with_all_tags() {
        let event_id = event_id_hex(0xdd);
        let author = pubkey_hex(0x33);
        let def_event = SignedNostrEvent {
            id: event_id.clone(),
            pubkey: author.clone(),
            created_at: 1_710_001_000,
            kind: KIND_AGENT_DEFINITION,
            tags: vec![
                vec!["title".to_string(), "My Agent".to_string()],
                vec!["d".to_string(), "my-agent".to_string()],
                vec!["role".to_string(), "assistant".to_string()],
                vec!["instructions".to_string(), "Be helpful.".to_string()],
                vec!["use-criteria".to_string(), "when you need help".to_string()],
                vec!["category".to_string(), "worker".to_string()],
                vec!["tool".to_string(), "fs_read".to_string()],
                vec!["tool".to_string(), "shell".to_string()],
            ],
            content: String::new(),
            sig: "0".repeat(128),
        };

        let parsed = parse_definition_event(&def_event).expect("parse must succeed");

        assert_eq!(parsed.slug, "my-agent");
        assert_eq!(parsed.title, "My Agent");
        assert_eq!(parsed.role.as_deref(), Some("assistant"));
        assert_eq!(parsed.instructions.as_deref(), Some("Be helpful."));
        assert_eq!(parsed.use_criteria.as_deref(), Some("when you need help"));
        assert_eq!(parsed.category.as_deref(), Some("worker"));
        assert_eq!(
            parsed.tools,
            vec!["fs_read".to_string(), "shell".to_string()]
        );
        assert_eq!(parsed.created_at, 1_710_001_000);
        assert_eq!(parsed.author_pubkey, author);
    }

    #[test]
    fn slug_falls_back_to_kebab_case_of_title_when_d_tag_absent() {
        let def_event = SignedNostrEvent {
            id: event_id_hex(0xee),
            pubkey: pubkey_hex(0x44),
            created_at: 1_710_002_000,
            kind: KIND_AGENT_DEFINITION,
            tags: vec![vec!["title".to_string(), "My Fancy Agent!".to_string()]],
            content: String::new(),
            sig: "0".repeat(128),
        };

        let parsed = parse_definition_event(&def_event).expect("parse must succeed");
        assert_eq!(parsed.slug, "my-fancy-agent");
    }

    #[test]
    fn missing_title_returns_error() {
        let def_event = SignedNostrEvent {
            id: event_id_hex(0xff),
            pubkey: pubkey_hex(0x55),
            created_at: 1_710_003_000,
            kind: KIND_AGENT_DEFINITION,
            tags: vec![vec!["d".to_string(), "some-slug".to_string()]],
            content: String::new(),
            sig: "0".repeat(128),
        };

        assert!(matches!(
            parse_definition_event(&def_event),
            Err(AgentInstallError::MissingTitle { .. })
        ));
    }

    #[test]
    fn generate_keypair_returns_valid_secp256k1_keys() {
        let (secret, pubkey_hex_str) = generate_keypair().expect("keypair must generate");
        assert_eq!(pubkey_hex_str.len(), 64);
        assert!(pubkey_hex_str.chars().all(|c| c.is_ascii_hexdigit()));
        let nsec = encode_nsec(&secret);
        assert!(nsec.starts_with("nsec1"));
    }

    #[test]
    fn to_kebab_case_converts_title_to_slug() {
        assert_eq!(to_kebab_case("My Fancy Agent"), "my-fancy-agent");
        assert_eq!(to_kebab_case("  Spaces  "), "spaces");
        assert_eq!(to_kebab_case("CamelCase"), "camelcase");
        assert_eq!(to_kebab_case("A B C"), "a-b-c");
        assert_eq!(to_kebab_case("hello!@# world"), "hello-world");
    }

    #[test]
    fn write_agent_config_creates_valid_json_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let (secret, pubkey) = generate_keypair().expect("keypair");
        let nsec = encode_nsec(&secret);

        let parsed = ParsedDefinition {
            slug: "test-agent".to_string(),
            title: "Test Agent".to_string(),
            role: Some("assistant".to_string()),
            instructions: Some("Be helpful.".to_string()),
            use_criteria: None,
            category: Some("worker".to_string()),
            tools: vec!["fs_read".to_string()],
            created_at: 1_710_000_000,
            author_pubkey: pubkey_hex(0x22),
        };

        write_agent_config(base_dir, &pubkey, &nsec, &parsed)
            .expect("agent config write must succeed");

        let agent_file = base_dir.join("agents").join(format!("{pubkey}.json"));
        assert!(agent_file.exists());

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&agent_file).unwrap()).unwrap();
        assert_eq!(value["nsec"], nsec.as_str());
        assert_eq!(value["slug"], "test-agent");
        assert_eq!(value["name"], "Test Agent");
        assert_eq!(value["status"], "active");
        assert_eq!(value["role"], "assistant");
        assert_eq!(value["instructions"], "Be helpful.");
        assert_eq!(value["category"], "worker");
        assert_eq!(value["default"]["tools"], serde_json::json!(["fs_read"]));
        assert!(value.get("useCriteria").is_none());
    }
}

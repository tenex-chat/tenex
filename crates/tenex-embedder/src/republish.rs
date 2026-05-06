//! Publish local conversation history to a Nostr relay so the embedder
//! can index it.
//!
//! Two local storage formats are handled:
//!
//! **New format** (`messages` field): TypeScript-era files where each message
//! is `{messageType, pubkey, content, timestamp}`. We create new kind:1 events
//! and sign them (agent key if available, else backend key).
//!
//! **Old format** (`history` field): older files where each history entry is a
//! JSON-encoded 8-element array `[0, pubkey, created_at, kind, tags, content,
//! sig, id]` — a complete signed Nostr event. These are republished verbatim
//! without re-signing, preserving original authorship.
//!
//! **Rust SQLite** (`conversation.db`): `messages` table. We create new kind:1
//! events (same signing logic as the new JSON format).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use nostr::event::Tag;
use nostr::{Event, EventBuilder, Keys, Kind, Timestamp};
use nostr_sdk::{Client, ClientOptions};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::backfill::relays_from_config;
use crate::scope;

pub struct RepublishOptions {
    pub relays: Option<Vec<String>>,
    pub rate_per_sec: f64,
    pub dry_run: bool,
}

pub async fn run(opts: RepublishOptions) -> Result<()> {
    let base = crate::paths::base_dir();
    let scope = scope::derive(&base).context("derive owner scope")?;
    if scope.projects.is_empty() {
        anyhow::bail!("no user-owned projects found");
    }

    let relays = opts.relays.unwrap_or_else(|| relays_from_config(&base));
    if relays.is_empty() {
        anyhow::bail!("no relays configured");
    }

    let backend_keys = tenex_backend_keys::ensure(&base).context("load backend key")?;
    let agent_keys = load_agent_keys(&base.join("agents"));

    info!(
        projects = scope.projects.len(),
        agents_with_keys = agent_keys.len(),
        relays = relays.len(),
        rate_per_sec = opts.rate_per_sec,
        dry_run = opts.dry_run,
        "republish-local starting"
    );

    let client = if !opts.dry_run {
        let c = Client::builder()
            .signer(backend_keys.clone())
            .opts(ClientOptions::new().automatic_authentication(true))
            .build();
        for url in &relays {
            c.add_relay(url.as_str())
                .await
                .with_context(|| format!("add relay {url}"))?;
        }
        c.connect().await;
        Some(c)
    } else {
        None
    };

    let interval = Duration::from_secs_f64(1.0 / opts.rate_per_sec.max(0.1));
    let mut total_published: u64 = 0;
    let mut total_skipped: u64 = 0;
    let mut last_tick = tokio::time::Instant::now();

    for project in &scope.projects {
        let project_dir = base.join("projects").join(&project.d_tag);

        let conversations_dir = project_dir.join("conversations");
        if conversations_dir.exists() {
            let (pub_, skip) = publish_json_conversations(
                &conversations_dir,
                project,
                &agent_keys,
                &backend_keys,
                client.as_ref(),
                interval,
                &mut last_tick,
                opts.dry_run,
            )
            .await
            .with_context(|| format!("JSON conversations for {}", project.d_tag))?;
            total_published += pub_;
            total_skipped += skip;
        }

        let db_path = project_dir.join("conversation.db");
        if db_path.exists() {
            let (pub_, skip) = publish_sqlite_conversations(
                &db_path,
                project,
                &agent_keys,
                &backend_keys,
                client.as_ref(),
                interval,
                &mut last_tick,
                opts.dry_run,
            )
            .await
            .with_context(|| format!("SQLite conversation.db for {}", project.d_tag))?;
            total_published += pub_;
            total_skipped += skip;
        }
    }

    info!(published = total_published, skipped = total_skipped, "republish-local complete");
    if opts.dry_run {
        eprintln!("\ndry-run: would publish {total_published} events ({total_skipped} skipped)");
    } else {
        eprintln!("\npublished {total_published} events ({total_skipped} skipped)");
    }
    Ok(())
}

// ── JSON source ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct NewFormatConversation {
    messages: Vec<NewFormatMessage>,
}

#[derive(Deserialize)]
struct NewFormatMessage {
    #[serde(rename = "messageType")]
    message_type: String,
    #[serde(default)]
    pubkey: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    timestamp: Option<u64>,
}

enum ConvFormat {
    New(NewFormatConversation),
    Old(Vec<Value>),
    Unknown,
}

fn detect_format(bytes: &[u8]) -> ConvFormat {
    let v: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return ConvFormat::Unknown,
    };
    if let Some(arr) = v.get("history").and_then(|h| h.as_array()) {
        return ConvFormat::Old(arr.clone());
    }
    if let Ok(c) = serde_json::from_value::<NewFormatConversation>(v) {
        return ConvFormat::New(c);
    }
    ConvFormat::Unknown
}

async fn publish_json_conversations(
    dir: &Path,
    project: &scope::OwnedProject,
    agent_keys: &HashMap<String, Keys>,
    backend_keys: &Keys,
    client: Option<&Client>,
    interval: Duration,
    last_tick: &mut tokio::time::Instant,
    dry_run: bool,
) -> Result<(u64, u64)> {
    let mut published = 0u64;
    let mut skipped = 0u64;

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok((0, 0)),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.len() != 64 || !stem.chars().all(|c| c.is_ascii_hexdigit()) {
            debug!(path = %path.display(), "skipping non-event-id named file");
            skipped += 1;
            continue;
        }
        let root_id = stem;

        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "read failed");
                skipped += 1;
                continue;
            }
        };

        match detect_format(&bytes) {
            ConvFormat::New(conv) => {
                let tags = build_tags(&root_id, &project.a_tag);
                for msg in &conv.messages {
                    if msg.message_type != "text" || msg.content.trim().is_empty() {
                        skipped += 1;
                        continue;
                    }
                    let ts = msg.timestamp.unwrap_or_else(now_secs);
                    let signer = agent_keys.get(&msg.pubkey).unwrap_or(backend_keys);
                    match build_and_send(
                        &msg.content, ts, tags.clone(), signer, client, interval, last_tick, dry_run,
                    )
                    .await
                    {
                        Ok(()) => published += 1,
                        Err(e) => warn!(error = %e, "send failed"),
                    }
                }
            }
            ConvFormat::Old(history) => {
                for entry in &history {
                    let s = match entry.as_str() {
                        Some(s) => s,
                        None => { skipped += 1; continue; }
                    };
                    match parse_history_event(s, &project.a_tag) {
                        Some(ev) => {
                            match send_raw(ev, client, interval, last_tick, dry_run).await {
                                Ok(()) => published += 1,
                                Err(e) => warn!(error = %e, "raw send failed"),
                            }
                        }
                        None => { skipped += 1; }
                    }
                }
            }
            ConvFormat::Unknown => {
                debug!(path = %path.display(), "unrecognised format; skipping");
                skipped += 1;
            }
        }
    }
    Ok((published, skipped))
}

/// Parse an 8-element history entry `[0, pubkey, created_at, kind, tags,
/// content, sig, id]` into a signed `nostr::Event`. Returns `None` for
/// tool/intent/reasoning/error events or empty content.
fn parse_history_event(raw: &str, project_a_tag: &str) -> Option<Event> {
    let arr: Value = serde_json::from_str(raw).ok()?;
    let arr = arr.as_array()?;
    if arr.len() < 8 {
        return None;
    }
    let tags_val = arr[4].as_array()?;
    let content = arr[5].as_str()?;

    if content.trim().is_empty() {
        return None;
    }

    for tag in tags_val {
        if let Some(head) = tag.as_array().and_then(|t| t.first()).and_then(|v| v.as_str()) {
            if matches!(head, "tool" | "intent" | "reasoning" | "error") {
                return None;
            }
        }
    }

    // Reconstruct the Nostr event JSON object from the array.
    // Array layout: [0, pubkey, created_at, kind, tags, content, sig, id]
    let mut obj = serde_json::Map::new();
    obj.insert("id".into(), arr[7].clone());
    obj.insert("pubkey".into(), arr[1].clone());
    obj.insert("created_at".into(), arr[2].clone());
    obj.insert("kind".into(), arr[3].clone());
    obj.insert("content".into(), arr[5].clone());
    obj.insert("sig".into(), arr[6].clone());

    // Inject project #a tag if absent; otherwise use original tags.
    let has_a = tags_val.iter().any(|t| {
        t.as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            == Some("a")
    });
    let mut tags = arr[4].clone();
    if !has_a {
        if let Some(arr) = tags.as_array_mut() {
            arr.push(serde_json::json!(["a", project_a_tag]));
        }
    }
    obj.insert("tags".into(), tags);

    let event: Event = serde_json::from_value(Value::Object(obj)).ok()?;
    Some(event)
}

// ── SQLite source ─────────────────────────────────────────────────────────────

async fn publish_sqlite_conversations(
    db_path: &PathBuf,
    project: &scope::OwnedProject,
    agent_keys: &HashMap<String, Keys>,
    backend_keys: &Keys,
    client: Option<&Client>,
    interval: Duration,
    last_tick: &mut tokio::time::Instant,
    dry_run: bool,
) -> Result<(u64, u64)> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("open {}", db_path.display()))?;

    let mut stmt = conn.prepare(
        "SELECT conversation_id, author_pubkey, content, timestamp \
         FROM messages \
         WHERE message_type = 'text' AND content != '' \
         ORDER BY conversation_id, sequence",
    )?;

    struct Row {
        conversation_id: String,
        author_pubkey: String,
        content: String,
        timestamp: Option<u64>,
    }

    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok(Row {
                conversation_id: r.get(0)?,
                author_pubkey: r.get(1)?,
                content: r.get(2)?,
                timestamp: r.get::<_, Option<i64>>(3)?.map(|t| t as u64),
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut published = 0u64;
    let mut skipped = 0u64;
    for row in rows {
        if row.content.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let ts = row.timestamp.unwrap_or_else(now_secs);
        let signer = agent_keys.get(&row.author_pubkey).unwrap_or(backend_keys);
        let tags = build_tags(&row.conversation_id, &project.a_tag);
        match build_and_send(&row.content, ts, tags, signer, client, interval, last_tick, dry_run).await {
            Ok(()) => published += 1,
            Err(e) => warn!(error = %e, "sqlite send failed"),
        }
    }
    Ok((published, skipped))
}

// ── Shared helpers ────────────────────────────────────────────────────────────

fn build_tags(root_id: &str, a_tag: &str) -> Vec<Tag> {
    vec![
        Tag::parse(["a", a_tag]).expect("build a tag"),
        Tag::parse(["e", root_id, "", "root"]).expect("build e root tag"),
    ]
}

async fn build_and_send(
    content: &str,
    created_at_secs: u64,
    tags: Vec<Tag>,
    signer: &Keys,
    client: Option<&Client>,
    interval: Duration,
    last_tick: &mut tokio::time::Instant,
    dry_run: bool,
) -> Result<()> {
    let event = EventBuilder::new(Kind::TextNote, content)
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at_secs))
        .sign_with_keys(signer)
        .context("sign event")?;
    send_raw(event, client, interval, last_tick, dry_run).await
}

async fn send_raw(
    event: Event,
    client: Option<&Client>,
    interval: Duration,
    last_tick: &mut tokio::time::Instant,
    dry_run: bool,
) -> Result<()> {
    if dry_run {
        debug!(id = %event.id, "dry-run: would publish");
        return Ok(());
    }
    let elapsed = last_tick.elapsed();
    if elapsed < interval {
        tokio::time::sleep(interval - elapsed).await;
    }
    *last_tick = tokio::time::Instant::now();
    client
        .expect("client present when not dry_run")
        .send_event(&event)
        .await
        .context("send_event")?;
    Ok(())
}

fn load_agent_keys(agents_dir: &Path) -> HashMap<String, Keys> {
    let mut map = HashMap::new();
    let entries = match std::fs::read_dir(agents_dir) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let doc: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let nsec = match doc.get("nsec").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        match Keys::parse(&nsec) {
            Ok(keys) => {
                let pubkey = keys.public_key().to_hex();
                map.insert(pubkey, keys);
            }
            Err(e) => debug!(path = %path.display(), error = %e, "skip invalid nsec"),
        }
    }
    map
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

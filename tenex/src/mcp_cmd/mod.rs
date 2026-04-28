//! `tenex mcp` — manage project-level `.mcp.json`.
//!
//! Mirrors the `claude mcp` subcommands that write to `.mcp.json` in the
//! current working directory (`--scope project` in Claude Code).
//!
//! Schema observed from `claude mcp add --scope project`:
//!   - Top-level key: `mcpServers`
//!   - stdio:  { "type":"stdio", "command":"...", "args":[...], "env":{} }
//!   - http:   { "type":"http",  "url":"...", "headers":{...} }  (headers omitted when empty)
//!   - sse:    { "type":"sse",   "url":"..." }

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::store::atomic;

const FILE_NAME: &str = ".mcp.json";
const SERVERS_KEY: &str = "mcpServers";

#[derive(Parser)]
pub struct McpArgs {
    #[command(subcommand)]
    command: McpCommand,
}

#[derive(Subcommand)]
enum McpCommand {
    /// Add an MCP server to .mcp.json.
    Add(AddArgs),
    /// Add an MCP server using a raw JSON config string.
    #[command(name = "add-json")]
    AddJson(AddJsonArgs),
    /// List all configured MCP servers.
    List,
    /// Show details for a single MCP server.
    Get {
        /// Server name.
        name: String,
    },
    /// Remove an MCP server.
    Remove {
        /// Server name.
        name: String,
    },
}

#[derive(Parser)]
struct AddArgs {
    /// Server name.
    name: String,
    /// Command executable (stdio) or URL (http/sse).
    command_or_url: String,
    /// Arguments passed to the command (stdio only). Use `--` to separate
    /// server flags from command flags: `tenex mcp add srv -- cmd --flag`.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
    /// Transport type: stdio (default), http, or sse.
    #[arg(short = 't', long = "transport")]
    transport: Option<String>,
    /// Environment variable (KEY=VALUE). Repeatable. stdio only.
    #[arg(short = 'e', long = "env")]
    env: Vec<String>,
    /// HTTP header ("Key: Value"). Repeatable. http/sse only.
    #[arg(short = 'H', long = "header")]
    header: Vec<String>,
}

#[derive(Parser)]
struct AddJsonArgs {
    /// Server name.
    name: String,
    /// Server config as a JSON object string.
    json: String,
}

pub async fn run(args: McpArgs) -> Result<()> {
    match args.command {
        McpCommand::Add(a) => cmd_add(a),
        McpCommand::AddJson(a) => cmd_add_json(a),
        McpCommand::List => cmd_list(),
        McpCommand::Get { name } => cmd_get(&name),
        McpCommand::Remove { name } => cmd_remove(&name),
    }
}

// ---- subcommand handlers -------------------------------------------------

fn cmd_add(args: AddArgs) -> Result<()> {
    let transport = args.transport.as_deref().unwrap_or("stdio");
    let entry = match transport {
        "stdio" => build_stdio_entry(&args.command_or_url, &args.args, &args.env)?,
        "http" | "sse" => build_url_entry(transport, &args.command_or_url, &args.header, &args.env)?,
        other => bail!("unknown transport: {other:?} (expected stdio, http, or sse)"),
    };
    let mut doc = load_doc()?;
    servers_mut(&mut doc).insert(args.name.clone(), entry);
    save_doc(&doc)?;
    println!("Added {transport} MCP server {} to project config", args.name);
    Ok(())
}

fn cmd_add_json(args: AddJsonArgs) -> Result<()> {
    let value: Value = serde_json::from_str(&args.json)
        .with_context(|| format!("parsing JSON for server {:?}", args.name))?;
    if !value.is_object() {
        bail!("server config must be a JSON object");
    }
    let mut doc = load_doc()?;
    servers_mut(&mut doc).insert(args.name.clone(), value);
    save_doc(&doc)?;
    println!("Added MCP server {} to project config", args.name);
    Ok(())
}

fn cmd_list() -> Result<()> {
    let doc = load_doc()?;
    let Some(servers) = doc.get(SERVERS_KEY).and_then(Value::as_object) else {
        println!("No MCP servers configured.");
        return Ok(());
    };
    if servers.is_empty() {
        println!("No MCP servers configured.");
        return Ok(());
    }
    for (name, cfg) in servers {
        let transport = cfg.get("type").and_then(Value::as_str).unwrap_or("stdio");
        let target = if transport == "stdio" {
            cfg.get("command").and_then(Value::as_str).unwrap_or("?").to_owned()
        } else {
            cfg.get("url").and_then(Value::as_str).unwrap_or("?").to_owned()
        };
        println!("{name} ({transport}): {target}");
    }
    Ok(())
}

fn cmd_get(name: &str) -> Result<()> {
    let doc = load_doc()?;
    let servers = doc
        .get(SERVERS_KEY)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("no MCP servers configured"))?;
    let cfg = servers
        .get(name)
        .ok_or_else(|| anyhow!("server {name:?} not found"))?;
    println!("{}", serde_json::to_string_pretty(cfg)?);
    Ok(())
}

fn cmd_remove(name: &str) -> Result<()> {
    let mut doc = load_doc()?;
    let servers = doc
        .get_mut(SERVERS_KEY)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("no MCP servers configured"))?;
    if servers.shift_remove(name).is_none() {
        bail!("server {name:?} not found");
    }
    save_doc(&doc)?;
    println!("Removed MCP server {name} from project config");
    Ok(())
}

// ---- entry builders ------------------------------------------------------

fn build_stdio_entry(command: &str, args: &[String], env_kv: &[String]) -> Result<Value> {
    let mut env = Map::new();
    for kv in env_kv {
        let (k, v) = split_kv(kv, '=', "env variable")?;
        env.insert(k, Value::String(v));
    }
    let mut m = Map::new();
    m.insert("type".into(), Value::String("stdio".into()));
    m.insert("command".into(), Value::String(command.to_owned()));
    m.insert(
        "args".into(),
        Value::Array(args.iter().map(|s| Value::String(s.clone())).collect()),
    );
    m.insert("env".into(), Value::Object(env));
    Ok(Value::Object(m))
}

fn build_url_entry(transport: &str, url: &str, header_kv: &[String], env_kv: &[String]) -> Result<Value> {
    if !env_kv.is_empty() {
        bail!("--env is not supported for {transport} transport");
    }
    let mut headers = Map::new();
    for h in header_kv {
        let (k, v) = split_kv(h, ':', "header")?;
        headers.insert(k, Value::String(v));
    }
    let mut m = Map::new();
    m.insert("type".into(), Value::String(transport.to_owned()));
    m.insert("url".into(), Value::String(url.to_owned()));
    if !headers.is_empty() {
        m.insert("headers".into(), Value::Object(headers));
    }
    Ok(Value::Object(m))
}

// ---- I/O helpers ---------------------------------------------------------

fn mcp_path() -> PathBuf {
    PathBuf::from(FILE_NAME)
}

fn load_doc() -> Result<IndexMap<String, Value>> {
    let path = mcp_path();
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<IndexMap<String, Value>>(&bytes)
            .with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IndexMap::new()),
        Err(e) => Err(anyhow!(e)).with_context(|| format!("reading {}", path.display())),
    }
}

fn save_doc(doc: &IndexMap<String, Value>) -> Result<()> {
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    serde::Serialize::serialize(doc, &mut ser).context("serialize .mcp.json")?;
    atomic::write(&mcp_path(), &buf)
}

fn servers_mut(doc: &mut IndexMap<String, Value>) -> &mut Map<String, Value> {
    if !doc.contains_key(SERVERS_KEY) {
        doc.insert(SERVERS_KEY.into(), Value::Object(Map::new()));
    }
    doc.get_mut(SERVERS_KEY)
        .and_then(Value::as_object_mut)
        .expect("mcpServers just inserted")
}

fn split_kv(s: &str, sep: char, context: &str) -> Result<(String, String)> {
    let mut parts = s.splitn(2, sep);
    let key = parts.next().unwrap_or("").trim().to_owned();
    let val = parts.next().unwrap_or("").trim().to_owned();
    if key.is_empty() {
        bail!("empty key in {context}: {s:?}");
    }
    Ok((key, val))
}

//! `~/.tenex/mcp.json` reader/writer.
//!
//! Schema source: `TenexMCPSchema` at `src/services/config/types.ts:466-469`
//! and `MCPServerConfigSchema` at `:457-464`.
//!
//! Per spec doc 09 (§1, §2):
//!
//! - **stdio-only.** No HTTP / SSE transport exists in TS — emitting `transport`,
//!   `url`, or `type` fields would corrupt the file. The Rust port enforces this
//!   schema on write.
//! - **No per-server enable flag.** `enabled` is file-level (whole MCP system on
//!   or off); disabling a single server means deleting it.
//! - **Default `enabled: true`** when the field is missing
//!   (`MCPServerConfigSchema:468`).
//!
//! Servers are typically added/removed by `mcpInstaller.ts` consuming kind:4200
//! Nostr events; manual editing is also supported. Round-trip is byte-identical
//! when only typed fields change (insertion order preserved via `IndexMap` + the
//! serde_json `preserve_order` feature wired in `Cargo.toml`).

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::atomic;

const FILE_NAME: &str = "mcp.json";
const SERVERS_KEY: &str = "servers";
const ENABLED_KEY: &str = "enabled";

const SERVER_FIELD_ORDER: &[&str] = &[
    "command",
    "args",
    "env",
    "description",
    "allowedPaths",
    "eventId",
];

/// On-disk representation of `mcp.json`. Lossless round-trip.
#[derive(Debug, Clone, Default)]
pub struct McpDoc {
    raw: IndexMap<String, Value>,
}

impl McpDoc {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(base_dir: &Path) -> Result<Self> {
        let path = base_dir.join(FILE_NAME);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let raw: IndexMap<String, Value> = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing {}", path.display()))?;
                Ok(Self { raw })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(anyhow!(e)).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, base_dir: &Path) -> Result<()> {
        let path = base_dir.join(FILE_NAME);
        let bytes = serialize(&self.raw)?;
        atomic::write(&path, &bytes)
    }

    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    pub fn raw_mut(&mut self) -> &mut IndexMap<String, Value> {
        &mut self.raw
    }

    // ---- typed accessors -------------------------------------------------

    /// File-level enabled flag. Defaults to `true` when the key is absent
    /// (`MCPServerConfigSchema:468`).
    pub fn enabled(&self) -> bool {
        self.raw
            .get(ENABLED_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.raw.insert(ENABLED_KEY.into(), Value::Bool(enabled));
    }

    /// Server names in disk order.
    pub fn server_names(&self) -> Vec<String> {
        self.servers_obj()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Borrowed view of one server's config.
    pub fn get(&self, name: &str) -> Option<ServerEntry<'_>> {
        let obj = self.servers_obj()?.get(name)?.as_object()?;
        Some(ServerEntry { obj })
    }

    /// Insert or replace a server. Field ordering on disk follows
    /// [`SERVER_FIELD_ORDER`] for fresh entries; existing entries preserve
    /// their on-disk order for fields the spec already knows about.
    pub fn upsert_server(&mut self, name: &str, config: ServerConfig) {
        let servers = self.ensure_servers_obj_mut();
        let mut entry: Map<String, Value> = servers
            .get(name)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        // Apply typed fields. None values clear the slot.
        set_or_clear(&mut entry, "command", Some(Value::String(config.command)));
        set_or_clear(
            &mut entry,
            "args",
            Some(Value::Array(
                config.args.into_iter().map(Value::String).collect(),
            )),
        );
        set_or_clear(
            &mut entry,
            "env",
            config.env.map(|e| {
                let mut m = Map::new();
                for (k, v) in e {
                    m.insert(k, Value::String(v));
                }
                Value::Object(m)
            }),
        );
        set_or_clear(
            &mut entry,
            "description",
            config.description.map(Value::String),
        );
        set_or_clear(
            &mut entry,
            "allowedPaths",
            config
                .allowed_paths
                .map(|paths| Value::Array(paths.into_iter().map(Value::String).collect())),
        );
        set_or_clear(&mut entry, "eventId", config.event_id.map(Value::String));

        // Re-emit in the canonical schema order, dropping unknown extras to
        // strictly enforce the schema (per spec 09: no transport/url/type).
        let normalised = reorder_canonical(entry);

        servers.insert(name.to_owned(), Value::Object(normalised));
    }

    pub fn remove(&mut self, name: &str) {
        if let Some(servers) = self.servers_obj_mut() {
            servers.shift_remove(name);
        }
    }

    /// Remove every server installed from a given Nostr event id (matches
    /// `removeMCPServerByEventId` at `src/services/mcp/mcpInstaller.ts:110-130`).
    pub fn remove_by_event_id(&mut self, event_id: &str) -> usize {
        let Some(servers) = self.servers_obj_mut() else {
            return 0;
        };
        let to_remove: Vec<String> = servers
            .iter()
            .filter_map(|(name, v)| {
                v.as_object()
                    .and_then(|o| o.get("eventId"))
                    .and_then(Value::as_str)
                    .filter(|id| *id == event_id)
                    .map(|_| name.clone())
            })
            .collect();
        for name in &to_remove {
            servers.shift_remove(name);
        }
        to_remove.len()
    }

    // ---- internals -------------------------------------------------------

    fn servers_obj(&self) -> Option<&Map<String, Value>> {
        self.raw.get(SERVERS_KEY).and_then(Value::as_object)
    }

    fn servers_obj_mut(&mut self) -> Option<&mut Map<String, Value>> {
        self.raw.get_mut(SERVERS_KEY).and_then(Value::as_object_mut)
    }

    fn ensure_servers_obj_mut(&mut self) -> &mut Map<String, Value> {
        if !self.raw.contains_key(SERVERS_KEY) {
            // Place servers before enabled if enabled already exists, to match
            // the natural TS shape `{servers, enabled}`.
            self.raw.shift_insert(0, SERVERS_KEY.into(), json!({}));
        }
        self.raw
            .get_mut(SERVERS_KEY)
            .and_then(Value::as_object_mut)
            .expect("servers key just inserted as object")
    }
}

/// Owned construction shape for [`McpDoc::upsert_server`].
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<Vec<(String, String)>>,
    pub description: Option<String>,
    pub allowed_paths: Option<Vec<String>>,
    pub event_id: Option<String>,
}

impl ServerConfig {
    /// Minimal stdio server: command + args, nothing else.
    pub fn stdio<S: Into<String>>(command: S, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
            env: None,
            description: None,
            allowed_paths: None,
            event_id: None,
        }
    }
}

/// Borrowed view of one server's config object.
pub struct ServerEntry<'a> {
    obj: &'a Map<String, Value>,
}

impl ServerEntry<'_> {
    pub fn command(&self) -> Option<&str> {
        self.obj.get("command").and_then(Value::as_str)
    }

    pub fn args(&self) -> Vec<String> {
        self.obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn env(&self) -> Vec<(String, String)> {
        self.obj
            .get("env")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn description(&self) -> Option<&str> {
        self.obj.get("description").and_then(Value::as_str)
    }

    pub fn allowed_paths(&self) -> Vec<String> {
        self.obj
            .get("allowedPaths")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn event_id(&self) -> Option<&str> {
        self.obj.get("eventId").and_then(Value::as_str)
    }

    pub fn raw(&self) -> &Map<String, Value> {
        self.obj
    }
}

// ---- helpers -------------------------------------------------------------

fn set_or_clear(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            map.insert(key.into(), v);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

fn reorder_canonical(entry: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for &k in SERVER_FIELD_ORDER {
        if let Some(v) = entry.get(k) {
            out.insert(k.to_owned(), v.clone());
        }
    }
    // Surface any extra keys that aren't in the schema, last — round-trip
    // preservation for fields a future schema version might add. Anything
    // explicitly forbidden by the spec is filtered here.
    for (k, v) in &entry {
        if SERVER_FIELD_ORDER.contains(&k.as_str()) {
            continue;
        }
        if matches!(k.as_str(), "transport" | "url" | "type") {
            // Schema-enforced drop: spec doc 09 §1 forbids these fields.
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    out
}

fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize mcp.json")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> McpDoc {
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        McpDoc { raw }
    }

    #[test]
    fn defaults_to_enabled_true_when_field_absent() {
        let doc = parse(br#"{"servers":{}}"#);
        assert!(doc.enabled());
    }

    #[test]
    fn enabled_false_respected() {
        let doc = parse(br#"{"servers":{},"enabled":false}"#);
        assert!(!doc.enabled());
    }

    #[test]
    fn server_names_preserve_disk_order() {
        let doc = parse(
            br#"{"servers":{"chrome":{"command":"a","args":[]},"sequential":{"command":"b","args":[]},"peekaboo":{"command":"c","args":[]}}}"#,
        );
        assert_eq!(doc.server_names(), vec!["chrome", "sequential", "peekaboo"]);
    }

    #[test]
    fn reads_command_args_env_paths_eventid() {
        let doc = parse(
            br#"{"servers":{"x":{"command":"node","args":["s.js"],"env":{"K":"v"},"description":"d","allowedPaths":["/p"],"eventId":"e1"}}}"#,
        );
        let e = doc.get("x").unwrap();
        assert_eq!(e.command(), Some("node"));
        assert_eq!(e.args(), vec!["s.js"]);
        assert_eq!(e.env(), vec![("K".to_owned(), "v".to_owned())]);
        assert_eq!(e.description(), Some("d"));
        assert_eq!(e.allowed_paths(), vec!["/p"]);
        assert_eq!(e.event_id(), Some("e1"));
    }

    #[test]
    fn upsert_canonicalises_field_order() {
        let mut doc = McpDoc::new();
        doc.upsert_server(
            "x",
            ServerConfig {
                command: "node".into(),
                args: vec!["s.js".into()],
                env: Some(vec![("A".into(), "1".into())]),
                description: Some("d".into()),
                allowed_paths: Some(vec!["/p".into()]),
                event_id: Some("e1".into()),
            },
        );
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        // command < args < env < description < allowedPaths < eventId
        let pos = |k: &str| s.find(k).unwrap_or_else(|| panic!("missing {k}"));
        assert!(pos("\"command\"") < pos("\"args\""));
        assert!(pos("\"args\"") < pos("\"env\""));
        assert!(pos("\"env\"") < pos("\"description\""));
        assert!(pos("\"description\"") < pos("\"allowedPaths\""));
        assert!(pos("\"allowedPaths\"") < pos("\"eventId\""));
    }

    #[test]
    fn upsert_drops_forbidden_transport_fields() {
        // Construct a document with a stray "transport" field, upsert through
        // the typed API, expect the forbidden field to be removed.
        let mut doc = parse(
            br#"{"servers":{"x":{"command":"node","args":[],"transport":"http","url":"http://"}}}"#,
        );
        doc.upsert_server("x", ServerConfig::stdio("node", vec!["s.js".into()]));
        let s = String::from_utf8(serialize(doc.raw()).unwrap()).unwrap();
        assert!(!s.contains("transport"), "expected transport stripped: {s}");
        assert!(!s.contains("\"url\""), "expected url stripped: {s}");
    }

    #[test]
    fn stdio_helper_writes_minimum_fields() {
        let mut doc = McpDoc::new();
        doc.upsert_server("x", ServerConfig::stdio("node", vec!["s.js".into()]));
        let e = doc.get("x").unwrap();
        assert_eq!(e.command(), Some("node"));
        assert_eq!(e.args(), vec!["s.js"]);
        assert!(e.env().is_empty());
        assert!(e.description().is_none());
        assert!(e.allowed_paths().is_empty());
        assert!(e.event_id().is_none());
    }

    #[test]
    fn remove_drops_named_server() {
        let mut doc =
            parse(br#"{"servers":{"a":{"command":"x","args":[]},"b":{"command":"y","args":[]}}}"#);
        doc.remove("a");
        assert_eq!(doc.server_names(), vec!["b"]);
    }

    #[test]
    fn remove_by_event_id_drops_only_matching() {
        let mut doc = parse(
            br#"{"servers":{
              "a":{"command":"x","args":[],"eventId":"e1"},
              "b":{"command":"y","args":[],"eventId":"e2"},
              "c":{"command":"z","args":[],"eventId":"e1"}
            }}"#,
        );
        let removed = doc.remove_by_event_id("e1");
        assert_eq!(removed, 2);
        assert_eq!(doc.server_names(), vec!["b"]);
    }

    #[test]
    fn round_trip_is_byte_identical_for_canonical_input() {
        let input = br#"{
  "servers": {
    "chrome-devtools-mcp": {
      "command": "node",
      "args": [
        "/srv/chrome.js"
      ],
      "env": {
        "PORT": "9222"
      }
    },
    "sequential-thinking": {
      "command": "/usr/local/bin/seq-think",
      "args": [],
      "description": "Sequential reasoning"
    }
  },
  "enabled": true
}"#;
        let raw: IndexMap<String, Value> = serde_json::from_slice(input).unwrap();
        let bytes = serialize(&raw).unwrap();
        assert_eq!(bytes.as_slice(), input.as_slice());
    }

    #[test]
    fn save_and_reload_roundtrips() {
        let tmp = std::env::temp_dir().join(format!("tenex-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut doc = McpDoc::new();
        doc.set_enabled(true);
        doc.upsert_server("x", ServerConfig::stdio("node", vec!["s.js".into()]));
        doc.save(&tmp).unwrap();
        let reloaded = McpDoc::load(&tmp).unwrap();
        assert_eq!(reloaded.server_names(), vec!["x"]);
        assert!(reloaded.enabled());
        let e = reloaded.get("x").unwrap();
        assert_eq!(e.command(), Some("node"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn missing_servers_object_yields_empty_list() {
        let doc = parse(b"{}");
        assert!(doc.server_names().is_empty());
        assert!(doc.get("x").is_none());
        assert!(doc.enabled()); // schema default
    }

    #[test]
    fn roundtrip_real_user_mcp_byte_identical() {
        // Brutal-verify against ~/.tenex/mcp.json if present (user has none
        // currently, so this skips on CI / fresh installs).
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => return,
        };
        let path = std::path::PathBuf::from(home).join(".tenex/mcp.json");
        let Ok(original) = std::fs::read(&path) else {
            return;
        };

        let raw: IndexMap<String, Value> = serde_json::from_slice(&original)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));
        let serialized = serialize(&raw).unwrap();

        if original != serialized {
            let orig_s = String::from_utf8_lossy(&original);
            let new_s = String::from_utf8_lossy(&serialized);
            for (i, (o, n)) in orig_s.lines().zip(new_s.lines()).enumerate() {
                if o != n {
                    panic!(
                        "byte-diff at line {i}:\n  orig: {o:?}\n  ours: {n:?}\n  (orig {} bytes, ours {} bytes)",
                        original.len(),
                        serialized.len(),
                    );
                }
            }
            panic!(
                "byte-diff past common prefix: orig={} ours={}",
                original.len(),
                serialized.len()
            );
        }
    }
}

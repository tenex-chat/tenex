use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::RwLock;

use crate::paths;

#[derive(Deserialize)]
struct GlobalConfig {
    #[serde(default, rename = "whitelistedPubkeys")]
    whitelisted_pubkeys: Vec<String>,
}

#[derive(Deserialize)]
struct RawEvent {
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

#[derive(Default)]
struct State {
    /// Pubkeys from `~/.tenex/config.json` `whitelistedPubkeys`.
    whitelist: HashSet<String>,
    /// Backend pubkeys, one hex per line, from `~/.tenex/whitelist/pubkeys.txt`.
    /// Written by the Rust supervisor, not by this daemon.
    backend: HashSet<String>,
    /// Union of `p` tags across all `~/.tenex/projects/*/event.json` files.
    p_tags: HashSet<String>,
}

pub struct TrustCache {
    inner: RwLock<State>,
}

pub struct Counts {
    pub whitelist: usize,
    pub backend: usize,
    pub p_tags: usize,
}

impl TrustCache {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(State::default()),
        }
    }

    pub fn reload_all(&self) -> Result<()> {
        self.reload_whitelist()?;
        self.reload_backend()?;
        self.reload_p_tags()?;
        Ok(())
    }

    pub fn reload_whitelist(&self) -> Result<()> {
        let set = read_whitelist(&paths::config_path())?;
        let mut state = self.inner.write().expect("trust cache poisoned");
        state.whitelist = set;
        Ok(())
    }

    pub fn reload_backend(&self) -> Result<()> {
        let set = read_pubkeys_txt(&paths::backend_pubkeys_path())?;
        let mut state = self.inner.write().expect("trust cache poisoned");
        state.backend = set;
        Ok(())
    }

    pub fn reload_p_tags(&self) -> Result<()> {
        let set = read_all_project_p_tags(&paths::projects_dir())?;
        let mut state = self.inner.write().expect("trust cache poisoned");
        state.p_tags = set;
        Ok(())
    }

    pub fn is_allowed(&self, pubkey: &str) -> bool {
        let state = self.inner.read().expect("trust cache poisoned");
        state.whitelist.contains(pubkey)
            || state.backend.contains(pubkey)
            || state.p_tags.contains(pubkey)
    }

    pub fn counts(&self) -> Counts {
        let state = self.inner.read().expect("trust cache poisoned");
        Counts {
            whitelist: state.whitelist.len(),
            backend: state.backend.len(),
            p_tags: state.p_tags.len(),
        }
    }
}

fn read_whitelist(path: &Path) -> Result<HashSet<String>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let cfg: GlobalConfig =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(cfg
        .whitelisted_pubkeys
        .into_iter()
        .filter_map(normalize_pubkey)
        .collect())
}

fn read_pubkeys_txt(path: &Path) -> Result<HashSet<String>> {
    let text = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    Ok(text
        .lines()
        .map(|l| l.trim().to_string())
        .filter_map(normalize_pubkey)
        .collect())
}

fn read_all_project_p_tags(projects_dir: &Path) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let entries = match fs::read_dir(projects_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e).with_context(|| format!("read {}", projects_dir.display())),
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let event_path = entry.path().join("event.json");
        if let Ok(set) = read_event_p_tags(&event_path) {
            out.extend(set);
        }
    }
    Ok(out)
}

fn read_event_p_tags(path: &Path) -> Result<HashSet<String>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let event: RawEvent =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    let mut set = HashSet::new();
    for tag in event.tags {
        if tag.len() >= 2 && tag[0] == "p" {
            if let Some(p) = normalize_pubkey(tag[1].clone()) {
                set.insert(p);
            }
        }
    }
    Ok(set)
}

fn normalize_pubkey(raw: String) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(s)
    } else {
        None
    }
}

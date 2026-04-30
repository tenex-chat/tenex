//! Derive the set of project `a`-tags whose conversations the user
//! owns.
//!
//! Source of truth:
//! - `~/.tenex/config.json::whitelistedPubkeys` — list of user identities
//!   authorized on this host. The owner pubkey on a project's `event.json`
//!   is one of these; `tenexPrivateKey` is the *backend signer*, NOT the
//!   user identity, so do not use it.
//! - `~/.tenex/projects/*/event.json::pubkey` matched against the
//!   whitelisted set.
//! - `event.json::tags` for the `d` tag.
//!
//! Output: a list of `31933:<owner_pubkey_hex>:<d_tag>` strings, ready
//! to drop into a Nostr `#a` filter. A single host may legitimately own
//! projects under multiple owner pubkeys (multi-account), so the scope
//! retains the per-project owner alongside its d-tag.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct OwnedProject {
    pub d_tag: String,
    pub owner_pubkey: String,
    pub a_tag: String,
}

#[derive(Debug, Clone)]
pub struct Scope {
    /// Distinct owner pubkeys observed across the projects directory.
    pub owner_pubkeys: Vec<String>,
    pub projects: Vec<OwnedProject>,
}

impl Scope {
    pub fn a_tags(&self) -> Vec<String> {
        self.projects.iter().map(|p| p.a_tag.clone()).collect()
    }
}

#[derive(Deserialize)]
struct ConfigDoc {
    #[serde(rename = "whitelistedPubkeys", default)]
    whitelisted_pubkeys: Vec<String>,
}

#[derive(Deserialize)]
struct EventDoc {
    pubkey: String,
    tags: Vec<Vec<String>>,
}

pub fn derive(base_dir: &Path) -> Result<Scope> {
    let config_path = base_dir.join("config.json");
    let config_bytes =
        std::fs::read(&config_path).with_context(|| format!("read {}", config_path.display()))?;
    let config: ConfigDoc = serde_json::from_slice(&config_bytes)
        .with_context(|| format!("parse {}", config_path.display()))?;
    if config.whitelisted_pubkeys.is_empty() {
        return Err(anyhow!(
            "config.json has no whitelistedPubkeys — cannot determine which \
             projects the user owns. Run `tenex onboard` to populate."
        ));
    }
    let allow: HashSet<String> = config.whitelisted_pubkeys.iter().cloned().collect();

    let projects_dir = base_dir.join("projects");
    let mut owned = Vec::new();
    let mut owners_seen: HashSet<String> = HashSet::new();
    if projects_dir.exists() {
        for entry in std::fs::read_dir(&projects_dir)
            .with_context(|| format!("read {}", projects_dir.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path().join("event.json");
            if !path.exists() {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let doc: EventDoc = match serde_json::from_slice(&bytes) {
                Ok(d) => d,
                Err(_) => continue,
            };
            if !allow.contains(&doc.pubkey) {
                continue;
            }
            let d_tag = doc
                .tags
                .iter()
                .find(|t| t.first().map(String::as_str) == Some("d"))
                .and_then(|t| t.get(1).cloned())
                .unwrap_or_default();
            if d_tag.is_empty() {
                continue;
            }
            let a_tag = format!("31933:{}:{}", doc.pubkey, d_tag);
            owners_seen.insert(doc.pubkey.clone());
            owned.push(OwnedProject {
                d_tag,
                owner_pubkey: doc.pubkey,
                a_tag,
            });
        }
    }
    owned.sort_by(|a, b| a.d_tag.cmp(&b.d_tag));
    let mut owner_pubkeys: Vec<String> = owners_seen.into_iter().collect();
    owner_pubkeys.sort();
    Ok(Scope {
        owner_pubkeys,
        projects: owned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_event(base: &Path, d_tag: &str, pubkey: &str) {
        let dir = base.join("projects").join(d_tag);
        fs::create_dir_all(&dir).unwrap();
        let body = serde_json::json!({
            "pubkey": pubkey,
            "tags": [["d", d_tag]],
        });
        fs::write(dir.join("event.json"), body.to_string()).unwrap();
    }

    #[test]
    fn includes_only_whitelisted_owners() {
        let dir = TempDir::new().unwrap();
        let owner = "11".repeat(32);
        let other = "22".repeat(32);
        let cfg = serde_json::json!({"whitelistedPubkeys": [owner]});
        fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();

        write_event(dir.path(), "mine-1", &owner);
        write_event(dir.path(), "mine-2", &owner);
        write_event(dir.path(), "not-mine", &other);

        let scope = derive(dir.path()).unwrap();
        assert_eq!(scope.owner_pubkeys, vec![owner.clone()]);
        let tags: Vec<&str> = scope.projects.iter().map(|p| p.d_tag.as_str()).collect();
        assert_eq!(tags, vec!["mine-1", "mine-2"]);
        assert!(scope
            .a_tags()
            .iter()
            .all(|t| t.starts_with(&format!("31933:{owner}:"))));
    }

    #[test]
    fn supports_multiple_whitelisted_owners() {
        let dir = TempDir::new().unwrap();
        let owner_a = "11".repeat(32);
        let owner_b = "22".repeat(32);
        let cfg = serde_json::json!({"whitelistedPubkeys": [owner_a, owner_b]});
        fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();

        write_event(dir.path(), "a1", &"11".repeat(32));
        write_event(dir.path(), "b1", &"22".repeat(32));
        let scope = derive(dir.path()).unwrap();
        assert_eq!(scope.projects.len(), 2);
        assert_eq!(scope.owner_pubkeys.len(), 2);
    }

    #[test]
    fn empty_when_no_projects_dir() {
        let dir = TempDir::new().unwrap();
        let cfg = serde_json::json!({"whitelistedPubkeys": ["11".repeat(32)]});
        fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();
        let scope = derive(dir.path()).unwrap();
        assert!(scope.projects.is_empty());
    }

    #[test]
    fn errors_when_no_whitelisted_pubkeys() {
        let dir = TempDir::new().unwrap();
        let cfg = serde_json::json!({});
        fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();
        let err = derive(dir.path()).unwrap_err();
        assert!(err.to_string().contains("whitelistedPubkeys"));
    }
}

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use serde_json::Value;
use thiserror::Error;

use crate::backend_events::installed_agent_list::InstalledAgentListAgent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInventoryReport {
    pub active_agents: Vec<InstalledAgentListAgent>,
    pub skipped_files: Vec<AgentInventorySkippedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInventorySkippedFile {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Error)]
pub enum AgentInventoryError {
    #[error("failed to read agents directory {path:?}: {source}")]
    ReadDirectory { path: PathBuf, source: io::Error },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentInventoryStatus {
    Active,
    Inactive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedAgentInventoryFile {
    pubkey: String,
    slug: String,
    status: AgentInventoryStatus,
}

pub fn read_installed_agent_list_agents(
    agents_dir: impl AsRef<Path>,
) -> Result<Vec<InstalledAgentListAgent>, AgentInventoryError> {
    Ok(read_installed_agent_inventory(agents_dir)?.active_agents)
}

pub fn read_installed_agent_inventory(
    agents_dir: impl AsRef<Path>,
) -> Result<AgentInventoryReport, AgentInventoryError> {
    let agents_dir = agents_dir.as_ref();
    let mut skipped_files = Vec::new();
    let mut parsed_files = Vec::new();

    let entries =
        fs::read_dir(agents_dir).map_err(|source| AgentInventoryError::ReadDirectory {
            path: agents_dir.to_path_buf(),
            source,
        })?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(source) => {
                skipped_files.push(AgentInventorySkippedFile {
                    path: agents_dir.to_path_buf(),
                    reason: format!("failed to read directory entry: {source}"),
                });
                continue;
            }
        };

        let path = entry.path();
        if !is_agent_inventory_candidate(&path) {
            continue;
        }

        match parse_agent_inventory_file(&path) {
            Ok(record) => parsed_files.push(record),
            Err(reason) => skipped_files.push(AgentInventorySkippedFile { path, reason }),
        }
    }

    parsed_files.sort_by(|left, right| {
        left.slug
            .cmp(&right.slug)
            .then_with(|| left.pubkey.cmp(&right.pubkey))
    });

    let active_agents = parsed_files
        .into_iter()
        .filter(|record| record.status == AgentInventoryStatus::Active)
        .map(|record| InstalledAgentListAgent {
            pubkey: record.pubkey,
            slug: record.slug,
        })
        .collect();

    Ok(AgentInventoryReport {
        active_agents,
        skipped_files,
    })
}

fn is_agent_inventory_candidate(path: &Path) -> bool {
    let file_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(file_name) => file_name,
        None => return false,
    };

    if file_name == "index.json" {
        return false;
    }

    path.extension().and_then(|extension| extension.to_str()) == Some("json")
}

fn parse_agent_inventory_file(path: &Path) -> Result<ParsedAgentInventoryFile, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "agent file name is not valid UTF-8".to_string())?;

    let pubkey = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| format!("{file_name} has no valid pubkey stem"))?;
    validate_filename_pubkey(pubkey)
        .map_err(|reason| format!("{file_name} has invalid pubkey stem {pubkey:?}: {reason}"))?;

    let content = fs::read_to_string(path)
        .map_err(|source| format!("failed to read {file_name}: {source}"))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|source| format!("failed to parse {file_name}: {source}"))?;

    let slug = read_required_string_field(&value, "slug")
        .map_err(|reason| format!("{file_name} has invalid slug: {reason}"))?;
    if slug.is_empty() {
        return Err(format!("{file_name} has an empty slug"));
    }

    let nsec = read_optional_string_field(&value, "nsec")
        .map_err(|reason| format!("{file_name} has invalid nsec: {reason}"))?;
    drop(nsec);
    let status = read_status_field(&value)
        .map_err(|reason| format!("{file_name} has invalid status: {reason}"))?;

    Ok(ParsedAgentInventoryFile {
        pubkey: pubkey.to_string(),
        slug,
        status,
    })
}

fn read_required_string_field(value: &Value, field: &str) -> Result<String, String> {
    match value.get(field) {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Null) => Err(format!("{field} must be a string")),
        Some(other) => Err(format!("{field} must be a string, found {other}")),
        None => Err(format!("missing {field}")),
    }
}

fn read_optional_string_field(value: &Value, field: &str) -> Result<Option<String>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(other) => Err(format!(
            "{field} must be a string when present, found {other}"
        )),
    }
}

fn read_status_field(value: &Value) -> Result<AgentInventoryStatus, String> {
    match value.get("status") {
        None | Some(Value::Null) => Ok(AgentInventoryStatus::Active),
        Some(Value::String(status)) if status == "active" => Ok(AgentInventoryStatus::Active),
        Some(Value::String(status)) if status == "inactive" => Ok(AgentInventoryStatus::Inactive),
        Some(Value::String(status)) => Err(format!("unsupported status {status:?}")),
        Some(other) => Err(format!("status must be a string, found {other}")),
    }
}

fn validate_filename_pubkey(pubkey: &str) -> Result<(), secp256k1::Error> {
    XOnlyPublicKey::from_str(pubkey)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::installed_agent_list::{
        INSTALLED_AGENT_LIST_KIND, InstalledAgentListAgent, InstalledAgentListInputs,
        encode_installed_agent_list,
    };
    use crate::nostr_event::verify_signed_event;
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct Secp256k1Signer<C: Signing> {
        secp: Secp256k1<C>,
        keypair: Keypair,
        xonly_hex: String,
    }

    impl<C: Signing> Secp256k1Signer<C> {
        fn new(secp: Secp256k1<C>, secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key hex");
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            let xonly_hex = hex::encode(xonly.serialize());
            Self {
                secp,
                keypair,
                xonly_hex,
            }
        }
    }

    impl<C: Signing> crate::backend_events::heartbeat::BackendSigner for Secp256k1Signer<C> {
        fn xonly_pubkey_hex(&self) -> String {
            self.xonly_hex.clone()
        }

        fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            Ok(hex::encode(sig.to_byte_array()))
        }
    }

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-agent-inventory-{prefix}-{}-{counter}-{unique}",
            std::process::id()
        ))
    }

    fn write_json(path: &Path, value: serde_json::Value) {
        fs::write(
            path,
            serde_json::to_vec_pretty(&value).expect("json must serialize"),
        )
        .expect("json file must write");
    }

    #[test]
    fn scans_agent_inventory_and_skips_non_inventory_files() {
        let temp_dir = unique_temp_dir("scan");
        fs::create_dir_all(&temp_dir).expect("temp dir must create");

        let owner = pubkey_hex(0x11);
        let alpha_left = pubkey_hex(0x21);
        let alpha_right = pubkey_hex(0x31);
        let beta = pubkey_hex(0x41);
        let inactive = pubkey_hex(0x51);

        write_json(
            &temp_dir.join(format!("{alpha_right}.json")),
            serde_json::json!({
                "nsec": "nsec-alpha-right",
                "slug": "alpha",
                "status": "active",
            }),
        );
        write_json(
            &temp_dir.join(format!("{beta}.json")),
            serde_json::json!({
                "slug": "beta",
            }),
        );
        write_json(
            &temp_dir.join(format!("{alpha_left}.json")),
            serde_json::json!({
                "slug": "alpha",
                "status": "active",
            }),
        );
        write_json(
            &temp_dir.join(format!("{inactive}.json")),
            serde_json::json!({
                "slug": "inactive-agent",
                "status": "inactive",
            }),
        );
        write_json(
            &temp_dir.join("index.json"),
            serde_json::json!({
                "bySlug": {},
                "byEventId": {},
                "byProject": {},
            }),
        );
        fs::write(temp_dir.join("notes.txt"), "ignored").expect("non-json file must write");
        fs::write(temp_dir.join("broken.json"), "{").expect("broken json must write");
        write_json(
            &temp_dir.join("not-a-pubkey.json"),
            serde_json::json!({
                "slug": "broken",
                "status": "active",
            }),
        );

        let report = read_installed_agent_inventory(&temp_dir).expect("inventory scan must work");

        let mut expected_agents = vec![
            InstalledAgentListAgent {
                pubkey: alpha_left.clone(),
                slug: "alpha".to_string(),
            },
            InstalledAgentListAgent {
                pubkey: alpha_right.clone(),
                slug: "alpha".to_string(),
            },
            InstalledAgentListAgent {
                pubkey: beta.clone(),
                slug: "beta".to_string(),
            },
        ];
        expected_agents.sort_by(|left, right| {
            left.slug
                .cmp(&right.slug)
                .then_with(|| left.pubkey.cmp(&right.pubkey))
        });

        assert_eq!(report.active_agents, expected_agents,);
        assert!(
            report
                .skipped_files
                .iter()
                .any(|entry| entry.path.ends_with("broken.json"))
        );
        assert!(
            report
                .skipped_files
                .iter()
                .any(|entry| entry.path.ends_with("not-a-pubkey.json"))
        );
        assert!(
            report
                .skipped_files
                .iter()
                .all(|entry| !entry.path.ends_with("index.json"))
        );

        let signer = test_signer();
        let owners = vec![owner];
        let inputs = InstalledAgentListInputs {
            created_at: 1_710_001_000,
            owner_pubkeys: &owners,
            agents: &report.active_agents,
        };

        let event =
            encode_installed_agent_list(&inputs, &signer).expect("installed agent list encode");
        assert_eq!(event.kind, INSTALLED_AGENT_LIST_KIND);
        assert_eq!(event.content, "");
        assert_eq!(
            event.tags,
            vec![
                vec!["p".to_string(), owners[0].clone()],
                vec![
                    "agent".to_string(),
                    expected_agents[0].pubkey.clone(),
                    "alpha".to_string()
                ],
                vec![
                    "agent".to_string(),
                    expected_agents[1].pubkey.clone(),
                    "alpha".to_string()
                ],
                vec![
                    "agent".to_string(),
                    expected_agents[2].pubkey.clone(),
                    "beta".to_string()
                ],
            ],
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn missing_status_defaults_to_active() {
        let temp_dir = unique_temp_dir("status");
        fs::create_dir_all(&temp_dir).expect("temp dir must create");

        let pubkey = pubkey_hex(0x61);
        write_json(
            &temp_dir.join(format!("{pubkey}.json")),
            serde_json::json!({
                "slug": "default-active",
                "nsec": "nsec-default-active",
            }),
        );

        let report = read_installed_agent_inventory(&temp_dir).expect("inventory scan must work");
        assert_eq!(
            report.active_agents,
            vec![InstalledAgentListAgent {
                pubkey,
                slug: "default-active".to_string(),
            }],
        );
    }

    #[test]
    fn rejects_invalid_directory_reads() {
        let missing_dir = unique_temp_dir("missing");
        let error = read_installed_agent_inventory(&missing_dir)
            .expect_err("missing directory must fail closed");

        match error {
            AgentInventoryError::ReadDirectory { path, .. } => {
                assert_eq!(path, missing_dir);
            }
        }
    }

    #[test]
    fn read_installed_agent_list_agents_returns_active_agents_only() {
        let temp_dir = unique_temp_dir("active-only");
        fs::create_dir_all(&temp_dir).expect("temp dir must create");

        let active = pubkey_hex(0x71);
        let inactive = pubkey_hex(0x72);
        write_json(
            &temp_dir.join(format!("{inactive}.json")),
            serde_json::json!({
                "slug": "inactive-agent",
                "status": "inactive",
            }),
        );
        write_json(
            &temp_dir.join(format!("{active}.json")),
            serde_json::json!({
                "slug": "active-agent",
                "status": "active",
            }),
        );

        let agents =
            read_installed_agent_list_agents(&temp_dir).expect("active agent list must load");

        assert_eq!(
            agents,
            vec![InstalledAgentListAgent {
                pubkey: active,
                slug: "active-agent".to_string(),
            }],
        );
    }
}

use std::io::{BufRead, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

const IDENTITY_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) trait UnavailableAgentNames {
    fn display_name(&self, pubkey: &str) -> Option<String>;
}

pub(crate) struct IdentityServiceAgentNames {
    socket_path: PathBuf,
}

impl IdentityServiceAgentNames {
    pub(crate) fn new(base_dir: &Path) -> Self {
        Self {
            socket_path: base_dir.join(tenex_identity::paths::IDENTITY_SOCKET_FILENAME),
        }
    }
}

impl UnavailableAgentNames for IdentityServiceAgentNames {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        resolve_identity_display_name(&self.socket_path, pubkey)
    }
}

pub(crate) fn log_unavailable_agent(pubkey: &str, names: &dyn UnavailableAgentNames) {
    let display_name = names
        .display_name(pubkey)
        .unwrap_or_else(|| short_pubkey(pubkey));
    tracing::warn!(
        pubkey = %pubkey,
        agent = %display_name,
        "Skipping unavailable agent {display_name}"
    );
}

fn resolve_identity_display_name(socket_path: &Path, pubkey: &str) -> Option<String> {
    if !socket_path.exists() {
        return None;
    }

    let mut stream = UnixStream::connect(socket_path).ok()?;
    let _ = stream.set_read_timeout(Some(IDENTITY_QUERY_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IDENTITY_QUERY_TIMEOUT));
    writeln!(stream, "RESOLVE {pubkey}").ok()?;

    let mut reader = std::io::BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }

    let trimmed = line.trim();
    if trimmed == "ERR" {
        return None;
    }

    let identity: tenex_identity::IdentityView = serde_json::from_str(trimmed).ok()?;
    if identity.event_id.is_none() {
        return None;
    }

    let name = identity.best_name().trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn short_pubkey(pubkey: &str) -> String {
    pubkey.chars().take(8).collect()
}

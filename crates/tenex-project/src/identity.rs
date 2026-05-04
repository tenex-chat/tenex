use std::io::{BufRead, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

const IDENTITY_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// What the identity service can tell us about a non-local agent.
///
/// All fields are best-effort: an absent identity service or missing kind:0
/// event yields `RemoteAgentView::default()`.
#[derive(Default)]
pub(crate) struct RemoteAgentView {
    pub(crate) display_name: Option<String>,
    pub(crate) slug: Option<String>,
    pub(crate) use_criteria: Option<String>,
}

/// Per-pubkey lookup against the host-wide identity service.
///
/// Used to label agents whose JSON projection is not local — i.e. agents
/// running on a different backend. Their kind:0 events carry TENEX-extension
/// tags (`slug`, `use-criteria`) that let us render them in the
/// `<available-agents>` block alongside locally-managed agents.
pub(crate) trait UnavailableAgentNames {
    /// Single fetch returning every field the renderer might want; cheaper
    /// than calling separate accessors when more than one is needed.
    fn view(&self, pubkey: &str) -> RemoteAgentView;

    /// Convenience: just the display name (used by `log_unavailable_agent`).
    fn display_name(&self, pubkey: &str) -> Option<String> {
        self.view(pubkey).display_name
    }
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
    fn view(&self, pubkey: &str) -> RemoteAgentView {
        let Some(view) = resolve_identity_view(&self.socket_path, pubkey) else {
            return RemoteAgentView::default();
        };
        // No kind:0 event → treat as completely empty.
        if view.event_id.is_none() {
            return RemoteAgentView::default();
        }
        let display_name = {
            let name = view.best_name().trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        };
        let trim_nonempty = |s: Option<String>| {
            s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        };
        RemoteAgentView {
            display_name,
            slug: trim_nonempty(view.slug),
            use_criteria: trim_nonempty(view.use_criteria),
        }
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

fn resolve_identity_view(socket_path: &Path, pubkey: &str) -> Option<tenex_identity::IdentityView> {
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

    serde_json::from_str(trimmed).ok()
}

fn short_pubkey(pubkey: &str) -> String {
    pubkey.chars().take(8).collect()
}

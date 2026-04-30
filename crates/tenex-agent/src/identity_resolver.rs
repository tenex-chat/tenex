//! Wires the host's `tenex-identity` Unix-socket cache into the
//! [`tenex_context::DisplayNameResolver`] interface used by the
//! conversation projection.
//!
//! The projection consults this resolver only when a conversation has
//! user-role messages from more than one distinct pubkey. Each unique
//! pubkey is resolved once per projection (the projection caches its
//! own results), so a 2-second per-call timeout is acceptable: the
//! identity cache hits sub-millisecond on warm rows, and a cold miss
//! resolves a single kind:0 in under a second.

use std::io::{BufRead, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tenex_context::DisplayNameResolver;

const IDENTITY_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

pub struct IdentityServiceResolver {
    socket_path: PathBuf,
}

impl IdentityServiceResolver {
    pub fn new(base_dir: &Path) -> Self {
        Self {
            socket_path: base_dir.join(tenex_identity::paths::IDENTITY_SOCKET_FILENAME),
        }
    }
}

impl DisplayNameResolver for IdentityServiceResolver {
    fn display_name(&self, pubkey: &str) -> Option<String> {
        if !self.socket_path.exists() {
            return None;
        }

        let mut stream = UnixStream::connect(&self.socket_path).ok()?;
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
        identity.event_id.as_ref()?;

        let name = identity.best_name().trim();
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    }
}

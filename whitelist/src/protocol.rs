/// Wire protocol for the whitelist daemon.
///
/// Requests are single newline-terminated ASCII lines; responses are likewise.
///   `CHECK <hex_pubkey> <project_dtag>\n` -> `YES\n` | `NO\n`
///   `STATUS\n`                            -> `OK whitelist=N backend=M p_tags=K\n`
///
/// The trust set is global on this machine, so `<project_dtag>` is required
/// by the protocol but not consulted by the server. Unknown verbs or
/// malformed input get `ERR\n`.
#[derive(Debug)]
pub enum Request {
    Check { pubkey: String },
    Status,
}

pub fn parse_request(line: &str) -> Option<Request> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let verb = parts.next()?;
    match verb {
        "CHECK" => {
            let pubkey = parts.next()?.to_string();
            let dtag = parts.next()?;
            if pubkey.is_empty() || dtag.is_empty() {
                return None;
            }
            Some(Request::Check { pubkey })
        }
        "STATUS" => Some(Request::Status),
        _ => None,
    }
}

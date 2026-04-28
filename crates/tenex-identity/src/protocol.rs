/// Wire protocol for the identity daemon.
///
/// Requests are single newline-terminated ASCII lines; responses are likewise.
///   `RESOLVE <hex_pubkey>\n`  ->  `<json>\n`   (IdentityView JSON, all-null fields if not found)
///   `STATUS\n`                ->  `OK cache=N\n`
///
/// Unknown verbs or malformed input get `ERR\n`.
#[derive(Debug)]
pub enum Request {
    Resolve { pubkey: String },
    Status,
}

pub fn parse_request(line: &str) -> Option<Request> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(2, ' ');
    let verb = parts.next()?;
    match verb {
        "RESOLVE" => {
            let pubkey = parts.next()?.trim().to_string();
            if pubkey.is_empty() {
                return None;
            }
            Some(Request::Resolve { pubkey })
        }
        "STATUS" => Some(Request::Status),
        _ => None,
    }
}

/// Wire protocol for the identity daemon.
///
/// Requests are single newline-terminated ASCII lines; responses are likewise.
///   `RESOLVE <hex_pubkey>\n`             ->  `<json>\n`   (IdentityView JSON, all-null fields if not found)
///   `STATUS\n`                           ->  `OK cache=N\n`
///   `WATCH_AUTHORS [<hex_pubkey> ...]\n` ->  `OK <n>\n`   (replaces the always-on kind:0 subscription set;
///                                                           an empty list tears the subscription down)
///
/// Unknown verbs or malformed input get `ERR\n`.
#[derive(Debug)]
pub enum Request {
    Resolve { pubkey: String },
    Status,
    WatchAuthors { pubkeys: Vec<String> },
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
        "WATCH_AUTHORS" => {
            let pubkeys = parts
                .next()
                .map(|rest| {
                    rest.split_ascii_whitespace()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(Request::WatchAuthors { pubkeys })
        }
        _ => None,
    }
}

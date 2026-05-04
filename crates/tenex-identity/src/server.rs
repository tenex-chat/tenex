use std::sync::Arc;

use nostr_sdk::Client;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tracing::{error, warn};

use crate::cache::IdentityCache;
use crate::model::IdentityView;
use crate::protocol::{parse_request, Request};
use crate::resolve::resolve;

pub async fn serve(listener: UnixListener, cache: Arc<IdentityCache>, client: Client) {
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let cache = cache.clone();
                let client = client.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, cache, client).await {
                        warn!("[identity] client error: {e:#}");
                    }
                });
            }
            Err(e) => {
                error!("[identity] accept error: {e}");
            }
        }
    }
}

async fn handle_client(
    stream: UnixStream,
    cache: Arc<IdentityCache>,
    client: Client,
) -> anyhow::Result<()> {
    let (reader_half, mut writer_half) = stream.into_split();
    let mut reader = BufReader::new(reader_half);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }

        let response = match parse_request(&line) {
            Some(Request::Resolve { pubkey }) => {
                let normalized = pubkey.trim().to_ascii_lowercase();
                if !is_hex64(&normalized) {
                    // Still return an object shape with ERR so callers know.
                    "ERR\n".to_string()
                } else {
                    match resolve(&normalized, client.clone(), cache.clone()).await {
                        Ok(Some(view)) => {
                            let mut json =
                                serde_json::to_string(&view).unwrap_or_else(|_| "ERR".to_string());
                            json.push('\n');
                            json
                        }
                        Ok(None) => {
                            // Not found — return an object with null fields so TypeScript
                            // can rely on the shape.
                            let empty = IdentityView {
                                pubkey: normalized.clone(),
                                display_name: None,
                                name: None,
                                nip05: None,
                                picture: None,
                                banner: None,
                                about: None,
                                lud16: None,
                                slug: None,
                                use_criteria: None,
                                backend_name: None,
                                event_id: None,
                                created_at: None,
                                fetched_at: crate::cache::now_secs(),
                            };
                            let mut json =
                                serde_json::to_string(&empty).unwrap_or_else(|_| "ERR".to_string());
                            json.push('\n');
                            json
                        }
                        Err(e) => {
                            warn!("[identity] resolve error for {normalized}: {e:#}");
                            "ERR\n".to_string()
                        }
                    }
                }
            }
            Some(Request::Status) => {
                let count = cache.count().unwrap_or(0);
                format!("OK cache={count}\n")
            }
            None => "ERR\n".to_string(),
        };

        writer_half.write_all(response.as_bytes()).await?;
        writer_half.flush().await?;
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

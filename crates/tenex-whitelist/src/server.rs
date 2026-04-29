use anyhow::Result;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::thread;

use crate::cache::TrustCache;
use crate::protocol::{parse_request, Request};

pub fn serve(listener: UnixListener, cache: Arc<TrustCache>) -> Result<()> {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let cache = cache.clone();
                thread::spawn(move || {
                    if let Err(e) = handle_client(stream, cache) {
                        eprintln!("[whitelist] client error: {e:#}");
                    }
                });
            }
            Err(e) => eprintln!("[whitelist] accept error: {e}"),
        }
    }
    Ok(())
}

fn handle_client(stream: UnixStream, cache: Arc<TrustCache>) -> Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(());
        }
        let response = match parse_request(&line) {
            Some(Request::Check { pubkey }) => {
                let normalized = pubkey.trim().to_ascii_lowercase();
                if !is_hex64(&normalized) {
                    "NO\n".to_string()
                } else if cache.is_allowed(&normalized) {
                    "YES\n".to_string()
                } else {
                    "NO\n".to_string()
                }
            }
            Some(Request::Status) => {
                let c = cache.counts();
                format!(
                    "OK whitelist={} backend={} p_tags={}\n",
                    c.whitelist, c.backend, c.p_tags
                )
            }
            None => "ERR\n".to_string(),
        };
        writer.write_all(response.as_bytes())?;
        writer.flush()?;
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

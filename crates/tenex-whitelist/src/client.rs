use anyhow::{anyhow, Result};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

pub fn connect_with_retry(path: &Path, attempts: u32, delay: Duration) -> Result<UnixStream> {
    let mut last_err = None;
    for _ in 0..attempts {
        match UnixStream::connect(path) {
            Ok(s) => return Ok(s),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(delay);
            }
        }
    }
    Err(anyhow!(
        "could not connect to {} after {attempts} attempts: {}",
        path.display(),
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

pub fn check(stream: UnixStream, pubkey: &str, dtag: &str) -> Result<bool> {
    let response = single_request(stream, &format!("CHECK {pubkey} {dtag}\n"))?;
    match response.trim() {
        "YES" => Ok(true),
        "NO" => Ok(false),
        other => Err(anyhow!("unexpected response: {other:?}")),
    }
}

pub fn status(stream: UnixStream) -> Result<String> {
    single_request(stream, "STATUS\n")
}

fn single_request(stream: UnixStream, request: &str) -> Result<String> {
    let mut writer = stream.try_clone()?;
    writer.write_all(request.as_bytes())?;
    writer.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(line)
}

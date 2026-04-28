use anyhow::{anyhow, Result};
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

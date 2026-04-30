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

/// Poll the identity daemon socket until it accepts connections or the timeout expires.
pub fn wait_until_ready(timeout: Duration) -> Result<()> {
    let socket = crate::paths::socket_path();
    let delay = Duration::from_millis(50);
    let attempts = (timeout.as_millis() / delay.as_millis()).max(1) as u32;
    connect_with_retry(&socket, attempts, delay).map(|_| ())
}

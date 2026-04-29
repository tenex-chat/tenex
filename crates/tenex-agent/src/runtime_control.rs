use std::path::PathBuf;

use anyhow::{Context, Result};
use tenex_protocol::{RuntimeControlRequest, RuntimeControlResponse};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub fn socket_path() -> Option<PathBuf> {
    std::env::var_os("TENEX_RUNTIME_CONTROL_SOCKET")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub async fn request(
    socket_path: PathBuf,
    request: RuntimeControlRequest,
) -> Result<RuntimeControlResponse> {
    let mut stream = UnixStream::connect(&socket_path).await.with_context(|| {
        format!(
            "connecting runtime control socket {}",
            socket_path.display()
        )
    })?;
    stream
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    serde_json::from_str(line.trim()).context("decoding runtime control response")
}

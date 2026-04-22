//! Blocking Telegram media downloader used by the gateway.
//!
//! The gateway looks up a file's relative path via `getFile`, derives the
//! public download URL with `file_download_url`, streams the bytes to disk,
//! and hands the resulting absolute path to the inbound normalizer.
//!
//! Storage layout:
//!
//! ```text
//! $TENEX_BASE_DIR/daemon/telegram/media/<file_unique_id><ext>
//! ```
//!
//! Download deduplication: if a file with the expected name already exists
//! and has non-zero length, we reuse it without calling `getFile`. Telegram
//! `file_unique_id` is stable across calls so this is safe. When `getFile`
//! reports a different size than the cached file we re-download.

use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::telegram::client::{TelegramBotClient, TelegramClientError};

const MEDIA_SUBDIR: &str = "telegram/media";

/// Error returned by [`download_telegram_media`]. Preserves the underlying
/// [`TelegramClientError`] for classification.
#[derive(Debug, Error)]
pub enum MediaDownloadError {
    #[error("telegram media io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("telegram media client error: {0}")]
    Client(#[from] TelegramClientError),
    #[error("telegram media: getFile returned no file_path for file_id={0}")]
    MissingFilePath(String),
}

/// Descriptor of the media attachment the gateway wants to download.
#[derive(Debug, Clone)]
pub struct MediaDownloadRequest<'a> {
    pub file_id: &'a str,
    pub file_unique_id: &'a str,
    pub mime_type: Option<&'a str>,
    /// Optional expected size in bytes. When `Some`, used to detect stale
    /// cached files that don't match the current upload.
    pub expected_size: Option<u64>,
}

/// Result of a successful media download.
#[derive(Debug, Clone)]
pub struct MediaDownloadResult {
    pub local_path: PathBuf,
    pub bytes_on_disk: u64,
    /// `true` when the file was already on disk and reused without calling
    /// the Bot API. Useful for diagnostics and tests.
    pub deduped: bool,
}

/// Download the media referenced by `request` to
/// `$daemon_dir/telegram/media/<fileUniqueId><ext>` and return the absolute
/// path. Idempotent per `file_unique_id`: if the expected file already
/// exists and matches the expected size (when known), the existing path is
/// returned without a network call.
pub fn download_telegram_media(
    daemon_dir: &Path,
    client: &TelegramBotClient,
    request: MediaDownloadRequest<'_>,
) -> Result<MediaDownloadResult, MediaDownloadError> {
    let media_dir = media_dir(daemon_dir);
    fs::create_dir_all(&media_dir).map_err(|source| MediaDownloadError::Io {
        path: media_dir.clone(),
        source,
    })?;

    // Pick the target filename. We use the `file_unique_id` which is stable
    // across getFile calls for the same underlying Telegram file object.
    let ext = extension_for_mime_type(request.mime_type);
    let file_name = format!("{}{}", request.file_unique_id, ext);
    let target = media_dir.join(&file_name);

    // Dedupe: reuse an existing file when it's clearly the same upload.
    if let Some(existing_size) = existing_file_size(&target)? {
        let matches_expected = match request.expected_size {
            Some(expected) => existing_size == expected,
            None => existing_size > 0,
        };
        if matches_expected {
            return Ok(MediaDownloadResult {
                local_path: target,
                bytes_on_disk: existing_size,
                deduped: true,
            });
        }
        // Size mismatch → re-download. Leave the file in place; we'll
        // overwrite via a temp + rename below.
    }

    let file = client.get_file(request.file_id)?;
    let file_path = file
        .file_path
        .ok_or_else(|| MediaDownloadError::MissingFilePath(request.file_id.to_string()))?;
    let download_url = client.file_download_url(&file_path);

    // Stream to a temp file next to the target then rename atomically.
    let tmp_path = target.with_extension(format!("{}.partial", strip_leading_dot(&ext)));
    let bytes = client.download_file_to(&download_url, &tmp_path)?;
    fs::rename(&tmp_path, &target).map_err(|source| {
        let _ = fs::remove_file(&tmp_path);
        MediaDownloadError::Io {
            path: target.clone(),
            source,
        }
    })?;

    Ok(MediaDownloadResult {
        local_path: target,
        bytes_on_disk: bytes,
        deduped: false,
    })
}

pub fn media_dir(daemon_dir: &Path) -> PathBuf {
    daemon_dir.join(MEDIA_SUBDIR)
}

fn existing_file_size(path: &Path) -> Result<Option<u64>, MediaDownloadError> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(meta.len())),
        Ok(_) => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(MediaDownloadError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Map MIME type to a file extension. Mirrors the TS service's
/// `MIME_TO_EXT` table plus the `ext = "/".second()` fallback when the
/// prefix doesn't match.
fn extension_for_mime_type(mime_type: Option<&str>) -> String {
    let Some(mime) = mime_type else {
        return String::new();
    };
    match mime {
        "audio/ogg" => ".ogg".to_string(),
        "audio/mpeg" => ".mp3".to_string(),
        "audio/mp4" => ".m4a".to_string(),
        "audio/wav" => ".wav".to_string(),
        "image/jpeg" => ".jpg".to_string(),
        "image/png" => ".png".to_string(),
        "image/gif" => ".gif".to_string(),
        "image/webp" => ".webp".to_string(),
        "video/mp4" => ".mp4".to_string(),
        "video/quicktime" => ".mov".to_string(),
        "application/pdf" => ".pdf".to_string(),
        "application/zip" => ".zip".to_string(),
        "text/plain" => ".txt".to_string(),
        other => match other.split_once('/') {
            Some((_, subtype)) if !subtype.is_empty() => format!(".{subtype}"),
            _ => String::new(),
        },
    }
}

fn strip_leading_dot(ext: &str) -> String {
    ext.strip_prefix('.').unwrap_or(ext).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::client::{TelegramBotClient, TelegramBotClientConfig};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    #[derive(Debug, Clone)]
    struct MockResponse {
        status: u16,
        content_type: String,
        body: Vec<u8>,
    }

    struct MockServer {
        url: String,
        handle: Option<JoinHandle<()>>,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl MockServer {
        fn start(script: Vec<MockResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let url = format!("http://{}", listener.local_addr().expect("addr"));
            let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let requests_clone = requests.clone();
            let handle = thread::spawn(move || {
                for response in script {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            serve_one(stream, &response, requests_clone.clone());
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                url,
                handle: Some(handle),
                requests,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("req lock").clone()
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn serve_one(
        mut stream: std::net::TcpStream,
        response: &MockResponse,
        requests: Arc<Mutex<Vec<String>>>,
    ) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        requests.lock().expect("req lock").push(path);

        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).expect("header");
            if n == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.trim().eq_ignore_ascii_case("content-length")
            {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
        if content_length > 0 {
            let mut buf = vec![0u8; content_length];
            reader.read_exact(&mut buf).expect("body");
        }

        let status_text = match response.status {
            200 => "OK",
            404 => "Not Found",
            500 => "Internal Server Error",
            _ => "OK",
        };
        let header = format!(
            "HTTP/1.1 {} {status_text}\r\ncontent-type: {}\r\ncontent-length: {}\r\n\r\n",
            response.status,
            response.content_type,
            response.body.len(),
        );
        stream.write_all(header.as_bytes()).expect("write header");
        stream.write_all(&response.body).expect("write body");
        stream.flush().expect("flush");
    }

    fn client_for(base_url: &str) -> TelegramBotClient {
        TelegramBotClient::new(
            TelegramBotClientConfig::new("TESTTOKEN").with_api_base_url(base_url),
        )
        .expect("client")
    }

    #[test]
    fn downloads_file_and_stores_under_unique_id() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let get_file_body = serde_json::json!({
            "ok": true,
            "result": {
                "file_id": "fid-1",
                "file_unique_id": "uniq-1",
                "file_size": 11,
                "file_path": "voice/voice_file.ogg"
            }
        })
        .to_string();
        let server = MockServer::start(vec![
            MockResponse {
                status: 200,
                content_type: "application/json".to_string(),
                body: get_file_body.into_bytes(),
            },
            MockResponse {
                status: 200,
                content_type: "audio/ogg".to_string(),
                body: b"hello-voice".to_vec(),
            },
        ]);
        let client = client_for(&server.url);
        let result = download_telegram_media(
            tmp.path(),
            &client,
            MediaDownloadRequest {
                file_id: "fid-1",
                file_unique_id: "uniq-1",
                mime_type: Some("audio/ogg"),
                expected_size: Some(11),
            },
        )
        .expect("download");

        assert!(result.local_path.is_absolute());
        assert!(result.local_path.ends_with("telegram/media/uniq-1.ogg"));
        assert_eq!(result.bytes_on_disk, 11);
        assert!(!result.deduped);

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("/botTESTTOKEN/getFile"));
        assert!(requests[0].contains("file_id=fid-1"));
        assert!(requests[1].contains("/file/botTESTTOKEN/voice/voice_file.ogg"));

        let on_disk = fs::read(&result.local_path).expect("read");
        assert_eq!(on_disk, b"hello-voice");

        // No leftover partial files.
        let entries: Vec<_> = fs::read_dir(media_dir(tmp.path()))
            .expect("media dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".partial"))
            .collect();
        assert!(entries.is_empty(), "no partial files should be left behind");
    }

    #[test]
    fn reuses_existing_file_when_expected_size_matches() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Seed a cached file.
        let media_dir_path = media_dir(tmp.path());
        fs::create_dir_all(&media_dir_path).unwrap();
        let cached_path = media_dir_path.join("uniq-2.ogg");
        fs::write(&cached_path, b"cached-bytes").expect("write cached");

        // Start a server with nothing scripted: any getFile call fails.
        let server = MockServer::start(vec![]);
        let client = client_for(&server.url);
        let result = download_telegram_media(
            tmp.path(),
            &client,
            MediaDownloadRequest {
                file_id: "fid-2",
                file_unique_id: "uniq-2",
                mime_type: Some("audio/ogg"),
                expected_size: Some(12),
            },
        )
        .expect("dedup");

        assert!(result.deduped);
        assert_eq!(result.bytes_on_disk, 12);
        assert_eq!(result.local_path, cached_path);
        // No network calls.
        assert!(server.requests().is_empty());
    }

    #[test]
    fn re_downloads_when_cached_file_size_differs_from_expected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let media_dir_path = media_dir(tmp.path());
        fs::create_dir_all(&media_dir_path).unwrap();
        let cached_path = media_dir_path.join("uniq-3.ogg");
        fs::write(&cached_path, b"stale").expect("write stale");

        let get_file_body = serde_json::json!({
            "ok": true,
            "result": {
                "file_id": "fid-3",
                "file_unique_id": "uniq-3",
                "file_size": 7,
                "file_path": "voice/file3.ogg"
            }
        })
        .to_string();
        let server = MockServer::start(vec![
            MockResponse {
                status: 200,
                content_type: "application/json".to_string(),
                body: get_file_body.into_bytes(),
            },
            MockResponse {
                status: 200,
                content_type: "audio/ogg".to_string(),
                body: b"updated".to_vec(),
            },
        ]);
        let client = client_for(&server.url);
        let result = download_telegram_media(
            tmp.path(),
            &client,
            MediaDownloadRequest {
                file_id: "fid-3",
                file_unique_id: "uniq-3",
                mime_type: Some("audio/ogg"),
                expected_size: Some(7),
            },
        )
        .expect("re-download");
        assert!(!result.deduped);
        assert_eq!(result.bytes_on_disk, 7);
        let on_disk = fs::read(&result.local_path).unwrap();
        assert_eq!(on_disk, b"updated");
    }

    #[test]
    fn mime_type_fallback_uses_subtype() {
        assert_eq!(extension_for_mime_type(None), "");
        assert_eq!(extension_for_mime_type(Some("image/jpeg")), ".jpg");
        assert_eq!(extension_for_mime_type(Some("image/svg+xml")), ".svg+xml");
        assert_eq!(extension_for_mime_type(Some("nonsense")), "");
    }

    #[test]
    fn get_file_missing_path_returns_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let body = serde_json::json!({
            "ok": true,
            "result": { "file_id": "fid-4" }
        })
        .to_string();
        let server = MockServer::start(vec![MockResponse {
            status: 200,
            content_type: "application/json".to_string(),
            body: body.into_bytes(),
        }]);
        let client = client_for(&server.url);
        let error = download_telegram_media(
            tmp.path(),
            &client,
            MediaDownloadRequest {
                file_id: "fid-4",
                file_unique_id: "uniq-4",
                mime_type: Some("audio/ogg"),
                expected_size: None,
            },
        )
        .expect_err("missing path");
        assert!(matches!(error, MediaDownloadError::MissingFilePath(ref id) if id == "fid-4"));
    }
}

use anyhow::{Context, Result};
use base64::Engine as _;
use rig::completion::message::{
    DocumentSourceKind, Image, ImageMediaType, MimeType as _, UserContent,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 15;

/// Scan `content` for image URLs (markdown `![...](url)` or bare image URLs),
/// fetch each one, base64-encode it, and return a `Vec<UserContent>` with only
/// image blocks (no text block).
///
/// Supports `https://`, `http://`, and `file://` URL schemes. `file://` reads
/// the bytes from the local filesystem and is gated on `allowed_file_prefixes`
/// — only paths starting with one of these prefixes (and free of `..`
/// components) are fetched. Inbound event content is partially user-controlled,
/// so an unrestricted `file://` reader would let an attacker exfiltrate
/// arbitrary local files into the LLM prompt.
///
/// The caller is responsible for appending the text content after the returned
/// image blocks so that the final message order is: [images, text].
///
/// On any fetch/decode error the image is silently skipped (a message is
/// printed to stderr) and the remaining images are still attempted.
///
/// Returns `None` when no images were found or successfully fetched so the
/// caller can continue with a plain string prompt.
pub async fn prepare_multimodal_content(
    content: &str,
    allowed_file_prefixes: &[PathBuf],
) -> Option<Vec<UserContent>> {
    let urls = extract_image_urls(content);
    if urls.is_empty() {
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .unwrap_or_default();

    let mut parts: Vec<UserContent> = Vec::new();

    for url in urls {
        match fetch_image(&client, &url, allowed_file_prefixes).await {
            Ok(Some((data, media_type))) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                let rig_media_type = ImageMediaType::from_mime_type(&media_type);
                parts.push(UserContent::Image(Image {
                    data: DocumentSourceKind::Base64(encoded),
                    media_type: rig_media_type,
                    detail: None,
                    additional_params: None,
                }));
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[tenex-agent] multimodal: fetch error for {url}: {e}");
            }
        }
    }

    if parts.is_empty() {
        return None;
    }

    Some(parts)
}

/// Extract deduplicated image URLs from message content.
///
/// Recognises two forms:
/// - Markdown images: `![alt text](url)` for http/https/file schemes
/// - Bare http/https/file URLs ending in `.jpg`, `.jpeg`, `.png`, `.gif`, or
///   `.webp` (with optional query string).
fn extract_image_urls(content: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut urls = Vec::new();

    // Markdown image syntax: ![alt](url)
    let md_re = regex::Regex::new(r"!\[[^\]]*\]\(((?:https?|file)://[^)]+)\)").unwrap();
    for cap in md_re.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            let url = m.as_str().to_string();
            if seen.insert(url.clone()) {
                urls.push(url);
            }
        }
    }

    // Bare image URLs (no quotes or whitespace; optional query string).
    let bare_re = regex::Regex::new(
        "(?:https?|file)://[^\\s<>\"']+\\.(?:jpe?g|png|gif|webp)(?:\\?[^\\s<>\"']*)?",
    )
    .unwrap();
    for m in bare_re.find_iter(content) {
        let url = m.as_str().to_string();
        if seen.insert(url.clone()) {
            urls.push(url);
        }
    }

    urls
}

async fn fetch_image(
    client: &reqwest::Client,
    url: &str,
    allowed_file_prefixes: &[PathBuf],
) -> Result<Option<(Vec<u8>, String)>> {
    if let Some(path) = url.strip_prefix("file://") {
        return fetch_local_image(path, allowed_file_prefixes);
    }
    fetch_http_image(client, url).await
}

fn fetch_local_image(
    path: &str,
    allowed_file_prefixes: &[PathBuf],
) -> Result<Option<(Vec<u8>, String)>> {
    let validated = match validate_local_path(path, allowed_file_prefixes) {
        Ok(p) => p,
        Err(reason) => {
            eprintln!("[tenex-agent] multimodal: rejecting file:// URL {path}: {reason}");
            return Ok(None);
        }
    };
    let bytes = std::fs::read(&validated)
        .with_context(|| format!("read {}", validated.display()))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        eprintln!(
            "[tenex-agent] multimodal: image too large ({} bytes) -- skipping {path}",
            bytes.len()
        );
        return Ok(None);
    }
    let Some(media_type) = infer_mime_from_url(path) else {
        eprintln!("[tenex-agent] multimodal: unknown media type for {path} -- skipping");
        return Ok(None);
    };
    eprintln!(
        "[tenex-agent] multimodal: prepared {} bytes ({media_type}) from {path}",
        bytes.len()
    );
    Ok(Some((bytes, media_type.to_string())))
}

/// Validate a `file://` URL's path: must be absolute, must not contain `..`
/// components, and must start with one of the allowed prefixes. Returns the
/// path on success or an explanatory message on rejection.
fn validate_local_path(path: &str, allowed_prefixes: &[PathBuf]) -> Result<PathBuf, &'static str> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("path is not absolute");
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path contains `..`");
    }
    if !allowed_prefixes.iter().any(|prefix| p.starts_with(prefix)) {
        return Err("path is outside the allowed file:// prefixes");
    }
    Ok(p.to_path_buf())
}

async fn fetch_http_image(
    client: &reqwest::Client,
    url: &str,
) -> Result<Option<(Vec<u8>, String)>> {
    let response = client.get(url).send().await.context("http get")?;

    if !response.status().is_success() {
        eprintln!(
            "[tenex-agent] multimodal: HTTP {} for {url}",
            response.status()
        );
        return Ok(None);
    }

    // Reject by Content-Length before downloading the body.
    if let Some(len) = response.content_length() {
        if len as usize > MAX_IMAGE_BYTES {
            eprintln!("[tenex-agent] multimodal: image too large ({len} bytes) -- skipping {url}");
            return Ok(None);
        }
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

    let media_type = content_type
        .as_deref()
        .and_then(|ct| supported_image_mime(ct))
        .or_else(|| infer_mime_from_url(url));

    let Some(media_type) = media_type else {
        eprintln!(
            "[tenex-agent] multimodal: unsupported or unknown media type for {url} -- skipping"
        );
        return Ok(None);
    };

    let bytes = response.bytes().await.context("http body")?.to_vec();

    if bytes.len() > MAX_IMAGE_BYTES {
        eprintln!(
            "[tenex-agent] multimodal: image too large ({} bytes) -- skipping {url}",
            bytes.len()
        );
        return Ok(None);
    }

    eprintln!(
        "[tenex-agent] multimodal: prepared {} bytes ({media_type}) from {url}",
        bytes.len()
    );
    Ok(Some((bytes, media_type.to_string())))
}

fn supported_image_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn infer_mime_from_url(url: &str) -> Option<&'static str> {
    let lower = url.to_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".gif") {
        Some("image/gif")
    } else if path.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
}

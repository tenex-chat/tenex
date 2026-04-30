use base64::Engine as _;
use rig::completion::message::{DocumentSourceKind, Image, ImageMediaType, MimeType as _, UserContent};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 15;

/// Scan `content` for image URLs (markdown `![...](url)` or bare HTTPS URLs
/// ending in a common image extension), fetch each one, base64-encode it, and
/// return a `Vec<UserContent>` with only image blocks (no text block).
///
/// The caller is responsible for appending the text content after the returned
/// image blocks so that the final message order is: [images, text].
///
/// On any fetch/decode error the image is silently skipped (a message is
/// printed to stderr) and the remaining images are still attempted.
///
/// Returns `None` when no images were found or successfully fetched so the
/// caller can continue with a plain string prompt.
pub async fn prepare_multimodal_content(content: &str) -> Option<Vec<UserContent>> {
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
        match fetch_image(&client, &url).await {
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
/// - Markdown images: `![alt text](https://...)`
/// - Bare HTTPS URLs ending in `.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp`
///   (with optional query string).
fn extract_image_urls(content: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut urls = Vec::new();

    // Markdown image syntax: ![alt](url)
    let md_re = regex::Regex::new(r"!\[[^\]]*\]\((https?://[^)]+)\)").unwrap();
    for cap in md_re.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            let url = m.as_str().to_string();
            if seen.insert(url.clone()) {
                urls.push(url);
            }
        }
    }

    // Bare HTTPS image URLs (no quotes or whitespace; optional query string).
    // Use a non-raw string so we can avoid quoting issues.
    let bare_re =
        regex::Regex::new("https?://[^\\s<>\"']+\\.(?:jpe?g|png|gif|webp)(?:\\?[^\\s<>\"']*)?")
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
) -> Result<Option<(Vec<u8>, String)>, reqwest::Error> {
    let response = client.get(url).send().await?;

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
            eprintln!(
                "[tenex-agent] multimodal: image too large ({len} bytes) -- skipping {url}"
            );
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
        eprintln!("[tenex-agent] multimodal: unsupported or unknown media type for {url} -- skipping");
        return Ok(None);
    };

    let bytes = response.bytes().await?.to_vec();

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

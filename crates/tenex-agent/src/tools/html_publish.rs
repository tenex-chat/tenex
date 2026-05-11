//! Publish an HTML report to a Blossom blob store and emit a kind:1 ToolUse
//! event tagged with the resulting URL.
//!
//! Accepts either a single HTML file or a directory containing `index.html`.
//! Directories are zipped (deflate) before upload; single files are uploaded
//! verbatim. The upload itself is BUD-02 — a kind:24242 authorization event
//! signed with this agent's keys, base64-encoded into the `Authorization`
//! header, and PUT'd to `<blossom_url>/upload`.
//!
//! The emitted ToolUse event carries `["url", <uploaded_url>]`,
//! `["t", "html-report"]`, and `["d", <slug>]` tags via
//! [`ToolUseIntent::extra_tags`], so downstream consumers can filter,
//! dereference, and address the published artifact by its stable slug.

use crate::emit::EmitState;
use base64::Engine as _;
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tenex_protocol::{Intent, ToolUseIntent};
use zip::write::SimpleFileOptions;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HtmlPublishError(String);

#[derive(Debug, Deserialize, Serialize)]
pub struct HtmlPublishArgs {
    pub title: String,
    pub description: String,
    pub path: String,
    pub slug: String,
}

#[derive(Debug, Serialize)]
pub struct HtmlPublishOutput {
    pub success: bool,
    pub url: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct HtmlPublishTool {
    state: Arc<EmitState>,
    blossom_url: String,
    keys: Keys,
}

impl HtmlPublishTool {
    pub fn new(state: Arc<EmitState>, blossom_url: String, keys: Keys) -> Self {
        Self {
            state,
            blossom_url,
            keys,
        }
    }
}

impl Tool for HtmlPublishTool {
    const NAME: &'static str = "html_publish";
    type Error = HtmlPublishError;
    type Args = HtmlPublishArgs;
    type Output = HtmlPublishOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Upload an HTML report to a Blossom blob server and announce it as \
                a kind:1 event tagged with the resulting URL. The path may be a single .html \
                file (uploaded verbatim) or a directory containing index.html (zipped, then \
                uploaded). Environment variables in the path (e.g. $AGENT_HOME, ${VAR}) are \
                expanded before resolution."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short human-readable title for the report."
                    },
                    "description": {
                        "type": "string",
                        "description": "Description of the report contents, used in the announcement."
                    },
                    "path": {
                        "type": "string",
                        "description": "Path to an HTML file or a directory containing index.html. \
                            Supports $VAR and ${VAR} env-var substitution."
                    },
                    "slug": {
                        "type": "string",
                        "description": "Stable identifier for the report; emitted as a \"d\" tag \
                            so subsequent publishes with the same slug replace the prior version."
                    }
                },
                "required": ["title", "description", "path", "slug"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let expanded = expand_env_vars(&args.path);
        let resolved = PathBuf::from(&expanded);

        let metadata = std::fs::metadata(&resolved).map_err(|e| {
            HtmlPublishError(format!("path not accessible {}: {e}", resolved.display()))
        })?;

        let (bytes, content_type) = if metadata.is_dir() {
            let index = resolved.join("index.html");
            if !index.is_file() {
                return Err(HtmlPublishError(format!(
                    "directory {} does not contain an index.html",
                    resolved.display()
                )));
            }
            let zipped = zip_directory(&resolved)?;
            (zipped, "application/zip")
        } else {
            let bytes = std::fs::read(&resolved).map_err(|e| {
                HtmlPublishError(format!("failed to read {}: {e}", resolved.display()))
            })?;
            (bytes, "text/html")
        };

        let sha_hex = sha256_hex(&bytes);
        let url = blossom_upload(
            &self.blossom_url,
            &self.keys,
            &bytes,
            &sha_hex,
            content_type,
        )
        .await?;

        let ral = self.state.meta.lock().unwrap().ral;
        let mut ctx = self.state.build_ctx(ral);
        ctx.llm_runtime_ms = self.state.take_runtime_delta();
        let args_json = serde_json::to_string(&args).unwrap_or_default();

        let intent = ToolUseIntent {
            tool_name: Self::NAME.to_string(),
            content: args.description.clone(),
            args_json: Some(args_json),
            referenced_messages: Vec::new(),
            usage: None,
            extra_tags: vec![
                vec!["url".to_string(), url.clone()],
                vec!["t".to_string(), "html-report".to_string()],
                vec!["title".to_string(), args.title.clone()],
                vec!["m".to_string(), content_type.to_string()],
                vec!["d".to_string(), args.slug.clone()],
            ],
        };

        self.state
            .channel
            .send(Intent::ToolUse(intent), &ctx)
            .await
            .map_err(|e| HtmlPublishError(format!("failed to emit tool-use event: {e}")))?;

        Ok(HtmlPublishOutput {
            success: true,
            url: Some(url.clone()),
            summary: format!("Report published: {url}"),
            error: None,
        })
    }
}

/// Expand `$VAR` and `${VAR}` substrings using `std::env::var`. Unknown vars
/// are left in place verbatim so callers can spot misconfigured paths in the
/// resulting filesystem error rather than getting a silent empty expansion.
fn expand_env_vars(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            // ${NAME}
            if bytes[i + 1] == b'{' {
                if let Some(end_rel) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                    let name = std::str::from_utf8(&bytes[i + 2..i + 2 + end_rel]).unwrap_or("");
                    if !name.is_empty() {
                        match std::env::var(name) {
                            Ok(v) => out.push_str(&v),
                            Err(_) => {
                                out.push_str(&input[i..i + 2 + end_rel + 1]);
                            }
                        }
                        i += 2 + end_rel + 1;
                        continue;
                    }
                }
            }
            // $NAME — terminated by anything that's not [A-Za-z0-9_]
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if end > start {
                let name = std::str::from_utf8(&bytes[start..end]).unwrap_or("");
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&input[i..end]),
                }
                i = end;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// Recursively zip every file under `root` (deflate compression). Paths inside
/// the archive are stored relative to `root` so the archive can be unpacked at
/// any location while preserving `index.html` at the top level.
fn zip_directory(root: &Path) -> Result<Vec<u8>, HtmlPublishError> {
    let buf: Vec<u8> = Vec::new();
    let cursor = Cursor::new(buf);
    let mut writer = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read_dir = std::fs::read_dir(&dir)
            .map_err(|e| HtmlPublishError(format!("read_dir {}: {e}", dir.display())))?;
        for entry in read_dir {
            let entry =
                entry.map_err(|e| HtmlPublishError(format!("dir entry {}: {e}", dir.display())))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|e| HtmlPublishError(format!("strip_prefix {}: {e}", path.display())))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            writer
                .start_file(rel_str, options)
                .map_err(|e| HtmlPublishError(format!("zip start_file: {e}")))?;
            let mut file = std::fs::File::open(&path)
                .map_err(|e| HtmlPublishError(format!("open {}: {e}", path.display())))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|e| HtmlPublishError(format!("read {}: {e}", path.display())))?;
            writer
                .write_all(&bytes)
                .map_err(|e| HtmlPublishError(format!("zip write: {e}")))?;
        }
    }

    let cursor = writer
        .finish()
        .map_err(|e| HtmlPublishError(format!("zip finish: {e}")))?;
    Ok(cursor.into_inner())
}

/// BUD-02 upload: build a signed kind:24242 authorization event, base64 it,
/// and PUT the blob to `<blossom_url>/upload`. Returns the `url` field from
/// the JSON response.
async fn blossom_upload(
    blossom_url: &str,
    keys: &Keys,
    bytes: &[u8],
    sha_hex: &str,
    content_type: &str,
) -> Result<String, HtmlPublishError> {
    let expiration = (Timestamp::now() + 600u64).to_string();

    let auth_event = EventBuilder::new(Kind::Custom(24242), "")
        .tag(parse_tag(["t", "upload"])?)
        .tag(parse_tag(["x", sha_hex])?)
        .tag(parse_tag(["expiration", &expiration])?)
        .sign_with_keys(keys)
        .map_err(|e| HtmlPublishError(format!("sign auth event: {e}")))?;

    let auth_b64 = base64::engine::general_purpose::STANDARD.encode(auth_event.as_json());
    let endpoint = format!("{}/upload", blossom_url.trim_end_matches('/'));

    let response = reqwest::Client::new()
        .put(&endpoint)
        .header(reqwest::header::AUTHORIZATION, format!("Nostr {auth_b64}"))
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| HtmlPublishError(format!("blossom PUT {endpoint}: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(HtmlPublishError(format!(
            "blossom upload failed: HTTP {status}: {body}"
        )));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| HtmlPublishError(format!("decode blossom response: {e}")))?;

    body.get("url")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| HtmlPublishError(format!("blossom response missing 'url' field: {body}")))
}

fn parse_tag<I, S>(parts: I) -> Result<Tag, HtmlPublishError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    Tag::parse(parts).map_err(|e| HtmlPublishError(format!("tag parse: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_dollar_var() {
        std::env::set_var("HTML_PUBLISH_TEST_VAR", "/tmp/x");
        assert_eq!(
            expand_env_vars("$HTML_PUBLISH_TEST_VAR/file.html"),
            "/tmp/x/file.html"
        );
    }

    #[test]
    fn expands_braced_var() {
        std::env::set_var("HTML_PUBLISH_TEST_VAR2", "/var/y");
        assert_eq!(
            expand_env_vars("${HTML_PUBLISH_TEST_VAR2}/index.html"),
            "/var/y/index.html"
        );
    }

    #[test]
    fn unknown_var_left_verbatim() {
        std::env::remove_var("HTML_PUBLISH_DEFINITELY_UNSET");
        let s = expand_env_vars("$HTML_PUBLISH_DEFINITELY_UNSET/x");
        assert_eq!(s, "$HTML_PUBLISH_DEFINITELY_UNSET/x");
    }

    #[test]
    fn sha256_hex_matches_known_value() {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn zip_directory_includes_index_html() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), b"<html></html>").unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets").join("a.css"), b"body{}").unwrap();
        let bytes = zip_directory(dir.path()).unwrap();
        assert!(!bytes.is_empty());
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
        assert!(names.iter().any(|n| n == "index.html"));
        assert!(names.iter().any(|n| n == "assets/a.css"));
    }
}

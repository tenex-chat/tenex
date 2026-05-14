use std::path::PathBuf;

use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

#[derive(Clone)]
pub struct McpProxyTool {
    definition: tenex_mcp::ToolManifestEntry,
    socket_path: PathBuf,
    /// Whether the agent's active model accepts image input. When
    /// `false`, image content from MCP tool results is replaced with a
    /// textual placeholder before being handed back to the LLM —
    /// otherwise base64 PNG blobs the model can't perceive would still
    /// fill the context window and produce 4xx overflows the way they
    /// did during the iOS-tester incident.
    image_support: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct McpProxyError(String);

impl McpProxyTool {
    pub fn new(
        definition: tenex_mcp::ToolManifestEntry,
        socket_path: PathBuf,
        image_support: bool,
    ) -> Self {
        Self {
            definition,
            socket_path,
            image_support,
        }
    }
}

impl ToolDyn for McpProxyTool {
    fn name(&self) -> String {
        self.definition.name.clone()
    }

    fn definition<'a>(&'a self, _prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        Box::pin(async move {
            ToolDefinition {
                name: self.definition.name.clone(),
                description: self.definition.description.clone(),
                parameters: self.definition.input_schema.clone(),
            }
        })
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let arguments = serde_json::from_str(&args).map_err(ToolError::JsonError)?;
            let request = tenex_mcp::McpToolCallRequest {
                tool_name: self.definition.name.clone(),
                arguments,
            };
            let mut stream = UnixStream::connect(&self.socket_path)
                .await
                .map_err(|e| tool_error(format!("connect MCP bridge: {e}")))?;
            let mut bytes = serde_json::to_vec(&request).map_err(|e| tool_error(format!("{e}")))?;
            bytes.push(b'\n');
            stream
                .write_all(&bytes)
                .await
                .map_err(|e| tool_error(format!("write MCP request: {e}")))?;
            stream
                .flush()
                .await
                .map_err(|e| tool_error(format!("flush MCP request: {e}")))?;

            let mut lines = BufReader::new(stream).lines();
            let line = lines
                .next_line()
                .await
                .map_err(|e| tool_error(format!("read MCP response: {e}")))?
                .ok_or_else(|| tool_error("MCP bridge closed without a response"))?;
            let response: tenex_mcp::McpToolCallResponse =
                serde_json::from_str(&line).map_err(|e| tool_error(format!("{e}")))?;
            if let Some(error) = response.error {
                // Return Ok so the LLM receives the verbatim error text without
                // rig's "ToolCallError: " prefix wrapping, and so on_tool_result
                // fires and can emit an observable Nostr event for the failure.
                return Ok(format!("Error: {error}"));
            }
            let raw = response.result.unwrap_or_default();
            Ok(if self.image_support {
                raw
            } else {
                strip_images_for_text_only_model(&raw)
            })
        })
    }
}

fn tool_error(message: impl Into<String>) -> ToolError {
    ToolError::ToolCallError(Box::new(McpProxyError(message.into())))
}

/// Rewrite an MCP tool result so it carries no image bytes.
///
/// `tenex-mcp::format_call_tool_result` returns one of three shapes:
///
/// - plain text (no images involved) — passed through unchanged
/// - `{"type":"image","data":…,"mimeType":…}` — replaced with a single
///   placeholder line
/// - `{"response":…,"parts":[{"type":"image",…}, …]}` — the response
///   text is preserved; each image part collapses to one placeholder
///   line appended after it
///
/// Used for models that lack vision capability. Without this, the base64
/// PNG bytes would still ride along in chat history and burn the context
/// window for no benefit — the model can't perceive them anyway.
fn strip_images_for_text_only_model(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return raw.to_owned();
    };
    if let Some(obj) = value.as_object() {
        if obj.get("type").and_then(Value::as_str) == Some("image") {
            return image_placeholder(obj);
        }
        if let Some(parts) = obj.get("parts").and_then(Value::as_array) {
            let response_text = obj.get("response").and_then(Value::as_str).unwrap_or("");
            let mut lines: Vec<String> = Vec::with_capacity(1 + parts.len());
            if !response_text.is_empty() {
                lines.push(response_text.to_owned());
            }
            for part in parts {
                if let Some(part_obj) = part.as_object() {
                    if part_obj.get("type").and_then(Value::as_str) == Some("image") {
                        lines.push(image_placeholder(part_obj));
                    }
                }
            }
            return lines.join("\n");
        }
    }
    raw.to_owned()
}

fn image_placeholder(image_obj: &serde_json::Map<String, Value>) -> String {
    let mime = image_obj
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let bytes = image_obj
        .get("data")
        .and_then(Value::as_str)
        .map(estimate_base64_bytes)
        .unwrap_or(0);
    format!(
        "[image omitted: {bytes} bytes, {mime} — model has no vision capability]",
    )
}

/// Estimate the decoded byte length of a base64 string without actually
/// decoding it. `4 chars → 3 bytes`, minus one byte per `=` padding char
/// at the end.
fn estimate_base64_bytes(b64: &str) -> usize {
    let len = b64.len();
    if len == 0 {
        return 0;
    }
    let padding = b64.bytes().rev().take_while(|c| *c == b'=').count();
    (len / 4) * 3 - padding
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passes_through() {
        let raw = "hello\nworld";
        assert_eq!(strip_images_for_text_only_model(raw), raw);
    }

    #[test]
    fn single_image_envelope_becomes_placeholder() {
        // 12 base64 chars, no padding → 9 bytes.
        let raw = r#"{"type":"image","data":"AAAAAAAAAAAA","mimeType":"image/png"}"#;
        let out = strip_images_for_text_only_model(raw);
        assert!(
            out.starts_with("[image omitted: 9 bytes, image/png"),
            "got: {out}",
        );
        assert!(!out.contains("AAAA"));
    }

    #[test]
    fn hybrid_envelope_preserves_text_and_replaces_images() {
        let raw = r#"{"response":"navigated to rooms","parts":[
            {"type":"image","data":"AAAA","mimeType":"image/png"},
            {"type":"image","data":"BBBB","mimeType":"image/jpeg"}
        ]}"#;
        let out = strip_images_for_text_only_model(raw);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "navigated to rooms");
        assert!(lines[1].contains("image/png"));
        assert!(lines[2].contains("image/jpeg"));
        assert!(!out.contains("AAAA"));
        assert!(!out.contains("BBBB"));
    }

    #[test]
    fn malformed_json_falls_through_unchanged() {
        let raw = "not json: { broken";
        assert_eq!(strip_images_for_text_only_model(raw), raw);
    }

    #[test]
    fn non_envelope_json_passes_through() {
        // Tool returned plain JSON text (e.g. a list of rooms) — not an
        // image envelope. Should not be rewritten.
        let raw = r#"{"rooms":["a","b","c"]}"#;
        assert_eq!(strip_images_for_text_only_model(raw), raw);
    }

    #[test]
    fn base64_padding_is_accounted_for() {
        // 4 chars with `=` padding → 2 raw bytes.
        let raw = r#"{"type":"image","data":"QQ==","mimeType":"image/png"}"#;
        let out = strip_images_for_text_only_model(raw);
        assert!(out.starts_with("[image omitted: 1 bytes,"), "got: {out}");
    }
}

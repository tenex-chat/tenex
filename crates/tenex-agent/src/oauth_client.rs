use async_trait::async_trait;
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, Middleware, Next};
use serde_json::Value;

pub fn is_oauth_token(key: &str) -> bool {
    key.starts_with("sk-ant-oat")
}

pub fn build_oauth_http_client(token: &str) -> ClientWithMiddleware {
    ClientBuilder::new(Default::default())
        .with(OAuthMiddleware {
            token: token.to_string(),
        })
        .build()
}

/// Required betas for Claude Code OAuth authentication.
pub const OAUTH_BETAS: &[&str] = &[
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
];

/// Anthropic OAuth requires the system prompt to start with this exact line.
/// Without it the API returns a misleading `rate_limit_error`. Sent as the
/// first system block, leaving downstream `cache_control` markers intact on
/// later blocks.
const CLAUDE_CODE_PREAMBLE: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

struct OAuthMiddleware {
    token: String,
}

#[async_trait]
impl Middleware for OAuthMiddleware {
    async fn handle(
        &self,
        mut req: reqwest::Request,
        extensions: &mut http::Extensions,
        next: Next<'_>,
    ) -> reqwest_middleware::Result<reqwest::Response> {
        let headers = req.headers_mut();
        headers.remove("x-api-key");
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.token))
                .expect("valid bearer token header value"),
        );

        if req.url().path() == "/v1/messages" {
            if let Some(new_body) = rewrite_messages_body(req.body()) {
                *req.body_mut() = Some(reqwest::Body::from(new_body));
            }
        }

        next.run(req, extensions).await
    }
}

fn rewrite_messages_body(body: Option<&reqwest::Body>) -> Option<Vec<u8>> {
    let bytes = body?.as_bytes()?;
    let mut value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object_mut()?;
    let preamble_block = serde_json::json!({
        "type": "text",
        "text": CLAUDE_CODE_PREAMBLE,
    });
    let new_system = match object.remove("system") {
        Some(Value::Array(blocks)) => {
            let mut combined = Vec::with_capacity(blocks.len() + 1);
            combined.push(preamble_block);
            combined.extend(blocks);
            Value::Array(combined)
        }
        Some(Value::String(text)) => Value::Array(vec![
            preamble_block,
            serde_json::json!({ "type": "text", "text": text }),
        ]),
        Some(other) => {
            object.insert("system".to_string(), other);
            return None;
        }
        None => Value::Array(vec![preamble_block]),
    };
    object.insert("system".to_string(), new_system);
    serde_json::to_vec(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_array_system_preserving_cache_control() {
        let body = serde_json::to_vec(&serde_json::json!({
            "model": "claude-sonnet-4-5",
            "system": [
                {"type": "text", "text": "agent system", "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [{"role": "user", "content": "hi"}],
        }))
        .unwrap();
        let body_obj = reqwest::Body::from(body);
        let rewritten = rewrite_messages_body(Some(&body_obj)).expect("rewrites array body");
        let v: Value = serde_json::from_slice(&rewritten).unwrap();
        let system = v.get("system").unwrap().as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], CLAUDE_CODE_PREAMBLE);
        assert_eq!(system[1]["text"], "agent system");
        assert_eq!(system[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn rewrites_string_system_into_array() {
        let body = serde_json::to_vec(&serde_json::json!({
            "system": "agent system",
            "messages": [],
        }))
        .unwrap();
        let body_obj = reqwest::Body::from(body);
        let rewritten = rewrite_messages_body(Some(&body_obj)).expect("rewrites string body");
        let v: Value = serde_json::from_slice(&rewritten).unwrap();
        let system = v.get("system").unwrap().as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], CLAUDE_CODE_PREAMBLE);
        assert_eq!(system[1]["text"], "agent system");
    }

    #[test]
    fn injects_preamble_when_system_missing() {
        let body = serde_json::to_vec(&serde_json::json!({
            "messages": [],
        }))
        .unwrap();
        let body_obj = reqwest::Body::from(body);
        let rewritten = rewrite_messages_body(Some(&body_obj)).expect("rewrites missing-system");
        let v: Value = serde_json::from_slice(&rewritten).unwrap();
        let system = v.get("system").unwrap().as_array().unwrap();
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["text"], CLAUDE_CODE_PREAMBLE);
    }
}

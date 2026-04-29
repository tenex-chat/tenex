use async_trait::async_trait;
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, Middleware, Next};

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
        next.run(req, extensions).await
    }
}

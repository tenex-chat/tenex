use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::config::EmbedConfig;

pub struct EmbeddingClient {
    http: Client,
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Deserialize)]
struct EmbedData {
    embedding: Vec<f64>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
}

impl EmbeddingClient {
    pub fn new(config: &EmbedConfig) -> Result<Self> {
        let api_key = config
            .api_key
            .clone()
            .ok_or_else(|| anyhow!("no API key configured for embedding provider '{}'", config.provider))?;

        let base_url = match config.base_url.as_deref() {
            Some(u) => u.trim_end_matches('/').to_string(),
            None => match config.provider.as_str() {
                "openai" => "https://api.openai.com/v1".to_string(),
                "openrouter" => "https://openrouter.ai/api/v1".to_string(),
                other => return Err(anyhow!("unknown embedding provider '{other}'; set a baseUrl or use 'openai' / 'openrouter'")),
            },
        };

        Ok(Self { http: Client::new(), api_key, base_url, model: config.model.clone() })
    }

    pub async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let body = EmbedRequest { model: &self.model, input: text };
        let resp: EmbedResponse = self
            .http
            .post(format!("{}/embeddings", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("send embedding request")?
            .error_for_status()
            .context("embedding API error")?
            .json()
            .await
            .context("parse embedding response")?;

        resp.data
            .into_iter()
            .next()
            .map(|d| d.embedding.into_iter().map(|f| f as f32).collect())
            .ok_or_else(|| anyhow!("embedding API returned empty data array"))
    }
}

use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::StatusCode;
use rig::client::CompletionClient;
use rig::completion::CompletionRequestBuilder;
use rig::providers::openrouter;
use serde_json::Value;
use std::borrow::Cow;
use std::time::Duration;

const MODEL: &str = "openai/gpt-4o-mini";
const PROMPT: &str = "Reply with exactly: TENEX OpenRouter usage probe";

#[tokio::main]
async fn main() -> Result<()> {
    let key = openrouter_api_key()?;

    run_rig_non_streaming(&key).await?;
    run_rig_streaming(&key).await?;
    run_direct_streaming_with_generation_lookup(&key).await?;

    Ok(())
}

async fn run_rig_non_streaming(key: &str) -> Result<()> {
    let client = openrouter::Client::new(key)?;
    let model = client.completion_model(MODEL);
    let response = CompletionRequestBuilder::new(model, PROMPT)
        .max_tokens(16)
        .temperature(0.0)
        .send()
        .await
        .context("rig non-streaming completion failed")?;

    println!("rig non-streaming:");
    println!("  response_id: {}", response.raw_response.id);
    println!("  response_model: {}", response.raw_response.model);
    println!("  usage: {:?}", response.usage);
    if let Some(usage) = response.raw_response.usage {
        println!("  raw_usage_cost: {:.10}", usage.cost);
    } else {
        println!("  raw_usage_cost: <missing>");
    }

    Ok(())
}

async fn run_rig_streaming(key: &str) -> Result<()> {
    let client = openrouter::Client::new(key)?;
    let model = client.completion_model(MODEL);
    let mut stream = CompletionRequestBuilder::new(model, PROMPT)
        .max_tokens(16)
        .temperature(0.0)
        .stream()
        .await
        .context("rig streaming completion failed")?;

    let mut final_usage = None;
    while let Some(item) = stream.next().await {
        if let rig::streaming::StreamedAssistantContent::Final(response) =
            item.context("rig streaming item failed")?
        {
            final_usage = Some(response.usage);
        }
    }

    println!("rig streaming:");
    println!("  final_usage: {:?}", final_usage);
    println!("  exposed_response_id: <not available on rig FinalResponse path>");
    println!("  exposed_response_model: <not available on rig FinalResponse path>");
    println!("  exposed_cost: <not available on rig FinalResponse path>");

    Ok(())
}

async fn run_direct_streaming_with_generation_lookup(key: &str) -> Result<()> {
    let http = reqwest::Client::new();
    let response = http
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": MODEL,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 16,
            "temperature": 0,
            "stream": true
        }))
        .send()
        .await
        .context("direct OpenRouter streaming request failed")?
        .error_for_status()
        .context("direct OpenRouter streaming request returned error")?;

    let header_generation_id = header_value(response.headers(), "x-generation-id");
    let mut response_id = None;
    let mut response_model = None;
    let mut response_usage = None;
    let mut sse_buffer = String::new();
    let mut byte_stream = response.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.context("direct OpenRouter stream chunk failed")?;
        sse_buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(separator) = sse_buffer.find("\n\n") {
            let event = sse_buffer[..separator].to_string();
            sse_buffer.drain(..separator + 2);
            if let Some(data) = sse_data(&event) {
                if data == "[DONE]" {
                    continue;
                }
                let json: Value = serde_json::from_str(data)
                    .with_context(|| format!("failed to parse SSE data: {data}"))?;
                if let Some(id) = json.get("id").and_then(Value::as_str) {
                    response_id = Some(id.to_string());
                }
                if let Some(model) = json.get("model").and_then(Value::as_str) {
                    response_model = Some(model.to_string());
                }
                if let Some(usage) = json.get("usage") {
                    response_usage = Some(usage.clone());
                }
            }
        }
    }

    println!("direct streaming:");
    println!(
        "  x_generation_id_header: {}",
        header_generation_id.as_deref().unwrap_or("<missing>")
    );
    println!(
        "  sse_response_id: {}",
        response_id.as_deref().unwrap_or("<missing>")
    );
    println!(
        "  sse_response_model: {}",
        response_model.as_deref().unwrap_or("<missing>")
    );
    println!(
        "  sse_usage: {}",
        response_usage
            .as_ref()
            .map(Value::to_string)
            .as_deref()
            .unwrap_or("<missing>")
    );

    match response_id {
        Some(id) => match fetch_generation_with_retry(&http, key, &id).await {
            Ok(generation) => print_generation_summary(&generation),
            Err(error) => println!("  generation_lookup: <unavailable: {error}>"),
        },
        None => {
            println!("  generation_lookup: <skipped: no SSE response id>");
        }
    }

    Ok(())
}

fn sse_data(event: &str) -> Option<&str> {
    event
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim))
}

async fn fetch_generation_with_retry(http: &reqwest::Client, key: &str, id: &str) -> Result<Value> {
    let generation_url = format!("https://openrouter.ai/api/v1/generation?id={id}");
    let mut last_error = None;

    for _ in 0..10 {
        let response = http
            .get(&generation_url)
            .bearer_auth(key)
            .send()
            .await
            .context("OpenRouter generation lookup failed")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("OpenRouter generation lookup body read failed")?;

        if status.is_success() {
            return serde_json::from_str::<Value>(&body)
                .context("OpenRouter generation lookup JSON failed");
        }

        last_error = Some((status, body));
        if status != StatusCode::NOT_FOUND {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let (status, body) = last_error.context("OpenRouter generation lookup produced no response")?;
    anyhow::bail!("OpenRouter generation lookup returned {status}: {body}");
}

fn print_generation_summary(generation: &Value) {
    let data = generation.get("data").unwrap_or(generation);
    println!(
        "  generation_model: {}",
        json_scalar(data, "model").unwrap_or(Cow::Borrowed("<missing>"))
    );
    println!(
        "  generation_usage: {}",
        json_scalar(data, "usage").unwrap_or(Cow::Borrowed("<missing>"))
    );
    println!(
        "  generation_total_cost: {}",
        json_scalar(data, "total_cost")
            .or_else(|| json_scalar(data, "cost"))
            .unwrap_or(Cow::Borrowed("<missing>"))
    );
    println!(
        "  generation_tokens_prompt: {}",
        json_scalar(data, "tokens_prompt").unwrap_or(Cow::Borrowed("<missing>"))
    );
    println!(
        "  generation_tokens_completion: {}",
        json_scalar(data, "tokens_completion").unwrap_or(Cow::Borrowed("<missing>"))
    );
}

fn json_scalar<'a>(value: &'a Value, key: &str) -> Option<Cow<'a, str>> {
    value.get(key).and_then(|v| match v {
        Value::String(s) => Some(Cow::Borrowed(s.as_str())),
        Value::Number(n) => Some(Cow::Owned(n.to_string())),
        _ => None,
    })
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn openrouter_api_key() -> Result<String> {
    if let Ok(key) = std::env::var("OPENROUTER_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }

    let path = dirs_next::home_dir()
        .context("home directory not found")?
        .join(".tenex/providers.json");
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let json: Value = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    json.pointer("/providers/openrouter/apiKey")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .map(ToOwned::to_owned)
        .context("OpenRouter API key not found in OPENROUTER_API_KEY or ~/.tenex/providers.json")
}

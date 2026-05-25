//! Standalone probe that exercises the same code path as `tenex-agent` for
//! Anthropic + OAuth + prompt caching, and prints per-call usage so we can
//! see whether `cache_creation_input_tokens` (write) and
//! `cache_read_input_tokens` (read) are populated as expected.
//!
//! Run with:
//!   cargo run -p tenex-agent --bin anthropic-cache-probe
//!
//! Reads the OAuth token from $ANTHROPIC_API_KEY or
//! ~/.tenex/providers.json (`providers.anthropic.apiKey[0]`).

use anyhow::{Context, Result};
use futures::StreamExt;
use rig_core::client::CompletionClient;
use rig_core::completion::CompletionRequestBuilder;
use rig_core::providers::anthropic;
use serde_json::Value;

#[path = "../oauth_client.rs"]
mod oauth_client;

const MODEL: &str = "claude-sonnet-4-5";

#[tokio::main]
async fn main() -> Result<()> {
    let key = anthropic_api_key()?;
    if !oauth_client::is_oauth_token(&key) {
        anyhow::bail!("expected an sk-ant-oat OAuth token; this probe targets the OAuth path");
    }

    let preamble = build_large_preamble();
    let prompt_tokens_estimate = preamble.len() / 4;
    println!(
        "preamble bytes={} (≈{} tokens)",
        preamble.len(),
        prompt_tokens_estimate
    );

    println!("\n--- call 1 (expect cache write) ---");
    let usage1 = run_call(&key, &preamble, "Reply with: hello one").await?;
    print_usage(&usage1);

    // Anthropic prompt caching is best-effort and a freshly written cache
    // entry is not always visible to a follow-up request issued
    // immediately. A small sleep gives the cache time to settle before we
    // assert on the read path.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    println!("\n--- call 2 (expect cache read) ---");
    let usage2 = run_call(&key, &preamble, "Reply with: hello two").await?;
    print_usage(&usage2);

    println!("\n--- summary ---");
    let wrote = usage1.cache_creation_input_tokens.unwrap_or(0);
    let read = usage2.cache_read_input_tokens.unwrap_or(0);
    println!("call 1 cache_creation_input_tokens = {wrote}");
    println!("call 2 cache_read_input_tokens     = {read}");
    if wrote > 0 && read > 0 {
        println!("RESULT: cache write+read confirmed");
    } else {
        println!("RESULT: cache NOT working — investigate");
        std::process::exit(1);
    }

    Ok(())
}

fn build_large_preamble() -> String {
    // Inject a unique nonce so each run gets a cold cache and we can
    // distinguish a real write→read cycle from cache leftover from a prior
    // run still warm in Anthropic's 5-minute TTL window.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut s = format!(
        "You are TENEX agent for project probe-cache nonce={nonce}. \
         Responsibilities: delegation, code review, shell execution, document retrieval. ",
    );
    let unit = "Detailed agent context line covering one slice of operational guidance for the TENEX runtime, supervision rules, delegation patterns, retry semantics, and tool invocation protocol. ";
    while s.len() < 8000 {
        s.push_str(unit);
    }
    s
}

#[derive(Default)]
struct CallUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

fn print_usage(u: &CallUsage) {
    println!(
        "  input={} output={} cache_write={} cache_read={}",
        opt(u.input_tokens),
        opt(u.output_tokens),
        opt(u.cache_creation_input_tokens),
        opt(u.cache_read_input_tokens),
    );
}

fn opt(v: Option<u64>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "?".into())
}

async fn run_call(key: &str, preamble: &str, prompt: &str) -> Result<CallUsage> {
    let http_client = oauth_client::build_oauth_http_client(key);
    let client = anthropic::Client::builder()
        .api_key(key)
        .anthropic_betas(oauth_client::OAUTH_BETAS)
        .http_client(http_client)
        .build()?;
    let model = client.completion_model(MODEL).with_prompt_caching();

    let mut stream = CompletionRequestBuilder::new(model, prompt)
        .preamble(preamble.to_string())
        .max_tokens(50)
        .temperature(0.0)
        .stream()
        .await
        .context("anthropic streaming completion failed")?;

    let mut final_response = None;
    while let Some(item) = stream.next().await {
        if let rig_core::streaming::StreamedAssistantContent::Final(response) =
            item.context("anthropic streaming item failed")?
        {
            final_response = Some(response);
        }
    }
    let final_response = final_response.context("no final streaming response received")?;

    Ok(CallUsage {
        input_tokens: final_response.usage.input_tokens.map(|n| n as u64),
        output_tokens: Some(final_response.usage.output_tokens as u64),
        cache_creation_input_tokens: final_response.usage.cache_creation_input_tokens,
        cache_read_input_tokens: final_response.usage.cache_read_input_tokens,
    })
}

fn anthropic_api_key() -> Result<String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
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
    json.pointer("/providers/anthropic/apiKey/0")
        .and_then(Value::as_str)
        .map(|s| s.split_whitespace().next().unwrap_or(s).to_string())
        .filter(|s| !s.is_empty())
        .context("Anthropic OAuth key not found in ANTHROPIC_API_KEY or providers.json")
}

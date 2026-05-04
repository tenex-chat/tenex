//! End-to-end smoke test: hits real LLM providers, records spans, prints summary.
//!
//! Providers exercised (skipped gracefully if unavailable):
//! - **OpenRouter** (non-streaming for true `usage.cost`) — gpt-4o-mini.
//! - **Ollama** at `OLLAMA_HOST` or `http://localhost:11434` if reachable.
//! - **Voyage** embeddings if `VOYAGE_API_KEY` is set.
//! - **Anthropic** direct if a working key in `~/.tenex/providers.json`.
//!
//! Reads the OpenRouter key from `OPENROUTER_API_KEY` or
//! `~/.tenex/providers.json` (matches the existing `openrouter_usage_probe`).

use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use serde_json::Value;
use tenex_accounting::{
    EmbeddingFinish, EmbeddingStart, LlmCallFinish, LlmCallStart, QueryService, RecordedMessage,
    Recorder, RootKind, RootKindOrStr, TraceRoot,
};

const OPENROUTER_MODEL: &str = "openai/gpt-4o-mini";
const PROMPT: &str = "Reply with exactly: TENEX accounting smoke ok";
const VOYAGE_MODEL: &str = "voyage-3";

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let db_path = std::env::var("TENEX_ACCOUNTING_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| tenex_accounting::default_db_path());
    println!("smoke: using db at {}", db_path.display());
    let recorder = Recorder::open(db_path.clone())
        .await
        .context("open recorder")?;

    let trace = recorder
        .open_trace(TraceRoot {
            root_kind: RootKindOrStr::Known(RootKind::Smoke),
            label: Some("accounting smoke test".into()),
            ..Default::default()
        })
        .await?;

    // ── OpenRouter (non-streaming → cost surfaces in response) ────────────
    match openrouter_key() {
        Ok(key) => match exercise_openrouter(&trace, &key).await {
            Ok(()) => println!("✓ openrouter recorded"),
            Err(e) => println!("× openrouter failed: {e:#}"),
        },
        Err(e) => println!("- openrouter skipped: {e}"),
    }

    // ── Ollama if reachable ──────────────────────────────────────────────
    let ollama_host =
        std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string());
    match exercise_ollama(&trace, &ollama_host).await {
        Ok(()) => println!("✓ ollama recorded"),
        Err(e) => println!("- ollama skipped: {e:#}"),
    }

    // ── Voyage embeddings ────────────────────────────────────────────────
    match std::env::var("VOYAGE_API_KEY") {
        Ok(key) if !key.trim().is_empty() => match exercise_voyage(&trace, &key).await {
            Ok(()) => println!("✓ voyage recorded"),
            Err(e) => println!("× voyage failed: {e:#}"),
        },
        _ => println!("- voyage skipped: VOYAGE_API_KEY unset"),
    }

    // ── Anthropic direct ─────────────────────────────────────────────────
    match anthropic_key() {
        Ok(key) => match exercise_anthropic(&trace, &key).await {
            Ok(()) => println!("✓ anthropic recorded"),
            Err(e) => println!("- anthropic skipped: {e:#}"),
        },
        Err(e) => println!("- anthropic skipped: {e}"),
    }

    trace.finish_ok(Some("smoke ok".into())).await?;
    recorder.flush().await?;

    // ── Read it back and print a summary ──────────────────────────────────
    let q = QueryService::new(&db_path);
    let ov = q.overview(Some(0))?;
    println!("\n──────── overview (all time) ────────");
    println!("traces: {}", ov.traces_total);
    println!("llm_calls: {}", ov.llm_calls);
    println!("embeddings: {}", ov.embeddings);
    println!(
        "total cost (provider where given, else estimated): ${:.6}",
        ov.total_cost_usd
    );
    println!("\n──────── cost by provider ────────");
    for p in ov.cost_by_provider {
        println!(
            "{:14} calls={:4} in={:7} out={:7} cost=${:.6} est=${:.6} shadow=${:.6}",
            p.provider,
            p.calls,
            p.input_tokens,
            p.output_tokens,
            p.cost_usd,
            p.cost_estimated_usd,
            p.shadow_cost_usd
        );
    }
    println!("\n──────── recent llm calls ────────");
    for r in q.recent_llm_calls(20)? {
        println!(
            "{}  {:14} {:30} in={:>5} out={:>5} cost={:>10}  {:>6}ms  {}",
            short(&r.span_id),
            r.provider,
            r.provider_model_id,
            r.input_tokens,
            r.output_tokens,
            r.cost_usd
                .map(|c| format!("${:.6}", c))
                .unwrap_or_else(|| "—".into()),
            r.duration_ms.unwrap_or(0),
            r.finish_reason.as_deref().unwrap_or("—"),
        );
    }
    println!(
        "\n→ open the UI:  cargo run --bin accounting_serve -- --bind 127.0.0.1:9876 --db {}",
        db_path.display()
    );
    Ok(())
}

fn short(id: &str) -> String {
    if id.len() <= 10 {
        id.to_string()
    } else {
        format!("{}…{}", &id[..6], &id[id.len() - 4..])
    }
}

// ───────────────────────── OpenRouter ─────────────────────────

fn openrouter_key() -> Result<String> {
    if let Ok(v) = std::env::var("OPENROUTER_API_KEY") {
        if !v.trim().is_empty() {
            return Ok(v);
        }
    }
    let path = dirs_next::home_dir()
        .context("home")?
        .join(".tenex/providers.json");
    let content =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let j: Value = serde_json::from_str(&content)?;
    j.pointer("/providers/openrouter/apiKey")
        .and_then(Value::as_str)
        .filter(|k| !k.trim().is_empty())
        .map(ToOwned::to_owned)
        .context("openrouter key not found")
}

fn anthropic_key() -> Result<String> {
    let path = dirs_next::home_dir()
        .context("home")?
        .join(".tenex/providers.json");
    let content =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let j: Value = serde_json::from_str(&content)?;
    let raw = j
        .pointer("/providers/anthropic/apiKey/0")
        .and_then(Value::as_str)
        .or_else(|| {
            j.pointer("/providers/anthropic/apiKey")
                .and_then(Value::as_str)
        })
        .context("anthropic key not found")?;
    // Memory note: extract part before space.
    Ok(raw.split_whitespace().next().unwrap_or(raw).to_string())
}

async fn exercise_openrouter(trace: &tenex_accounting::TraceHandle, key: &str) -> Result<()> {
    let span = trace
        .open_llm_call(LlmCallStart {
            provider: "openrouter".into(),
            provider_model_id: OPENROUTER_MODEL.into(),
            operation: "generate_text".into(),
            api_key_label: Some("env-or-providers-json".into()),
            agent_slug: Some("smoke".into()),
            n_messages_sent: Some(1),
            messages: vec![RecordedMessage {
                role: "user".into(),
                classification: Some("user".into()),
                content: PROMPT.into(),
                tokens_estimated: Some(10),
                cache_breakpoint_after: false,
            }],
            ..Default::default()
        })
        .await?;
    let started = Instant::now();
    let http = reqwest::Client::new();
    let body = serde_json::json!({
        "model": OPENROUTER_MODEL,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 16,
        "temperature": 0,
        "usage": {"include": true},
    });
    let resp = http
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .context("openrouter post")?;
    let status = resp.status();
    let txt = resp.text().await.context("openrouter body")?;
    if !status.is_success() {
        span.finish_err(Some("provider_error".into()), Some(txt.clone()))
            .await?;
        anyhow::bail!("openrouter {status}: {}", txt);
    }
    let json: Value = serde_json::from_str(&txt).context("openrouter json")?;
    let usage = json.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cost = usage.and_then(|u| u.get("cost")).and_then(Value::as_f64);
    let id = json.get("id").and_then(Value::as_str).map(str::to_string);
    let provider = json
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let finish_reason = json
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .map(str::to_string);
    let _ = started.elapsed();
    span.finish_ok(LlmCallFinish {
        input_tokens,
        output_tokens,
        total_cost_usd_provider: cost,
        finish_reason,
        openrouter_provider: provider,
        openrouter_generation_id: id,
        ..Default::default()
    })
    .await?;
    Ok(())
}

// ───────────────────────── Ollama ─────────────────────────

async fn exercise_ollama(trace: &tenex_accounting::TraceHandle, host: &str) -> Result<()> {
    // Pick a small model that's likely loaded; let user override.
    let model =
        std::env::var("OLLAMA_MODEL").unwrap_or_else(|_| "deepseek-v4-flash:cloud".to_string());
    let http = reqwest::Client::new();
    // Reachability check first.
    let ping = http
        .get(format!("{host}/api/tags"))
        .send()
        .await
        .context("ollama unreachable")?;
    if !ping.status().is_success() {
        anyhow::bail!("ollama /api/tags returned {}", ping.status());
    }
    let span = trace
        .open_llm_call(LlmCallStart {
            provider: "ollama".into(),
            provider_model_id: model.clone(),
            operation: "generate_text".into(),
            agent_slug: Some("smoke".into()),
            n_messages_sent: Some(1),
            messages: vec![RecordedMessage {
                role: "user".into(),
                classification: Some("user".into()),
                content: PROMPT.into(),
                tokens_estimated: Some(10),
                cache_breakpoint_after: false,
            }],
            ..Default::default()
        })
        .await?;
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "stream": false,
        "options": {"num_predict": 32, "temperature": 0}
    });
    let resp = http
        .post(format!("{host}/api/chat"))
        .json(&body)
        .send()
        .await
        .context("ollama chat")?;
    let status = resp.status();
    let txt = resp.text().await?;
    if !status.is_success() {
        span.finish_err(Some("provider_error".into()), Some(txt.clone()))
            .await?;
        anyhow::bail!("ollama {status}: {}", txt);
    }
    let json: Value = serde_json::from_str(&txt)?;
    let input = json
        .get("prompt_eval_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = json.get("eval_count").and_then(Value::as_u64).unwrap_or(0);
    let total_dur = json.get("total_duration").and_then(Value::as_i64);
    let load_dur = json.get("load_duration").and_then(Value::as_i64);
    let eval_dur = json.get("eval_duration").and_then(Value::as_i64);
    let prompt_eval_dur = json.get("prompt_eval_duration").and_then(Value::as_i64);
    let _ = total_dur;
    let model_loaded_from_cold = load_dur.map(|d| d > 100_000_000); // > 100ms suggests load.
    span.finish_ok(LlmCallFinish {
        input_tokens: input,
        output_tokens: output,
        load_duration_ns: load_dur,
        eval_duration_ns: eval_dur,
        prompt_eval_duration_ns: prompt_eval_dur,
        model_loaded_from_cold,
        finish_reason: Some("stop".into()),
        ..Default::default()
    })
    .await?;
    Ok(())
}

// ───────────────────────── Voyage embeddings ─────────────────────────

async fn exercise_voyage(trace: &tenex_accounting::TraceHandle, key: &str) -> Result<()> {
    let input = "TENEX accounting smoke embedding test.";
    let span = trace
        .open_embedding(EmbeddingStart {
            provider: "voyage".into(),
            model: VOYAGE_MODEL.into(),
            agent_pubkey: None,
            batch_size: 1,
            total_input_chars: input.len() as i64,
            source_kind: Some("smoke".into()),
            source_event_kind: None,
            source_event_id: None,
            vector_storage_target: None,
        })
        .await?;
    let http = reqwest::Client::new();
    let body = serde_json::json!({"input": [input], "model": VOYAGE_MODEL});
    let resp = http
        .post("https://api.voyageai.com/v1/embeddings")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .context("voyage post")?;
    let status = resp.status();
    let txt = resp.text().await?;
    if !status.is_success() {
        span.finish_ok(EmbeddingFinish::default()).await?;
        anyhow::bail!("voyage {status}: {}", txt);
    }
    let json: Value = serde_json::from_str(&txt)?;
    let usage_tokens = json
        .pointer("/usage/total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let dim = json
        .pointer("/data/0/embedding")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64);
    span.finish_ok(EmbeddingFinish {
        total_input_tokens: usage_tokens,
        dimension: dim,
        dedup_skipped_count: 0,
    })
    .await?;
    Ok(())
}

// ───────────────────────── Anthropic ─────────────────────────

async fn exercise_anthropic(trace: &tenex_accounting::TraceHandle, key: &str) -> Result<()> {
    let model = std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".to_string());
    let span = trace
        .open_llm_call(LlmCallStart {
            provider: "anthropic".into(),
            provider_model_id: model.clone(),
            operation: "generate_text".into(),
            api_key_label: Some("providers-json".into()),
            agent_slug: Some("smoke".into()),
            n_messages_sent: Some(1),
            messages: vec![RecordedMessage {
                role: "user".into(),
                classification: Some("user".into()),
                content: PROMPT.into(),
                tokens_estimated: Some(10),
                cache_breakpoint_after: false,
            }],
            ..Default::default()
        })
        .await?;
    let http = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 32,
        "messages": [{"role": "user", "content": PROMPT}],
    });
    let resp = http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("anthropic post")?;
    let status = resp.status();
    let txt = resp.text().await?;
    if !status.is_success() {
        span.finish_err(Some("provider_error".into()), Some(txt.clone()))
            .await?;
        anyhow::bail!("anthropic {status}: {}", txt);
    }
    let json: Value = serde_json::from_str(&txt)?;
    let input = json
        .pointer("/usage/input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = json
        .pointer("/usage/output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = json
        .pointer("/usage/cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = json
        .pointer("/usage/cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let stop = json
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::to_string);
    span.finish_ok(LlmCallFinish {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        finish_reason: stop,
        ..Default::default()
    })
    .await?;
    Ok(())
}

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::{load_llms, load_providers, resolve_config};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptModel {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub system_prompt: Option<String>,
}

pub fn resolve_role_model(base_dir: &std::path::Path, role_key: &str) -> Result<PromptModel> {
    let llms = load_llms(base_dir)?;
    let config_name = llms
        .roles
        .get(role_key)
        .ok_or_else(|| anyhow!("no config assigned to role '{role_key}'"))?;
    let providers = load_providers(base_dir)?;
    let value = resolve_config(config_name, &llms, &providers, &KeyHealthTracker::new());
    prompt_model_from_resolved_value(&value)
}

pub async fn refine_system_prompt(model: &PromptModel, prompt: &str) -> Result<String> {
    match model.provider.as_str() {
        "anthropic" => call_anthropic(model, prompt).await,
        "openai" | "codex" => {
            call_openai_compatible(model, "https://api.openai.com/v1/chat/completions", prompt)
                .await
        }
        "openrouter" => {
            call_openai_compatible(
                model,
                "https://openrouter.ai/api/v1/chat/completions",
                prompt,
            )
            .await
        }
        "ollama" => call_ollama(model, prompt).await,
        other => bail!("LLM prompt refinement is not wired for provider '{other}'"),
    }
}

pub fn build_refinement_prompt(
    name: &str,
    slug: &str,
    role: &str,
    description: &str,
    use_criteria: &str,
    draft: &str,
) -> String {
    format!(
        "Create a TENEX agent system prompt from this operator brief.\n\
         Return only the final system prompt. Do not wrap it in markdown fences.\n\n\
         Agent name: {name}\n\
         Agent slug: {slug}\n\
         Role: {role}\n\
         Description: {description}\n\
         Use criteria: {use_criteria}\n\n\
         Operator draft:\n{draft}"
    )
}

fn prompt_model_from_resolved_value(value: &Value) -> Result<PromptModel> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown LLM config resolution error");
        bail!("{msg}");
    }

    match value.get("kind").and_then(Value::as_str) {
        Some("standard") => parse_standard(value, None),
        Some("meta") => {
            let default = value
                .get("default")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("meta config missing default variant"))?;
            let variant = value
                .get("variants")
                .and_then(|v| v.get(default))
                .ok_or_else(|| anyhow!("meta config missing default variant '{default}'"))?;
            let system_prompt = variant
                .get("systemPrompt")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let resolved = variant
                .get("resolved")
                .ok_or_else(|| anyhow!("meta variant '{default}' missing resolved config"))?;
            parse_standard(resolved, system_prompt)
        }
        other => bail!("unsupported resolved LLM config kind: {other:?}"),
    }
}

fn parse_standard(value: &Value, system_prompt: Option<String>) -> Result<PromptModel> {
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("resolved config missing provider"))?
        .to_owned();
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("resolved config missing model"))?
        .to_owned();
    let api_key = value
        .get("apiKeys")
        .and_then(Value::as_array)
        .and_then(|keys| keys.first())
        .and_then(|key| key.get("key"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let base_url = value
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(PromptModel {
        provider,
        model,
        api_key,
        base_url,
        system_prompt,
    })
}

async fn call_openai_compatible(model: &PromptModel, url: &str, prompt: &str) -> Result<String> {
    let key = model
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow!("provider '{}' has no API key", model.provider))?;
    let system = system_message(model);
    let body = serde_json::json!({
        "model": model.model,
        "max_tokens": 1600,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ]
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("build LLM client")?
        .post(url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .context("call LLM")?;
    parse_chat_response(response).await
}

async fn call_anthropic(model: &PromptModel, prompt: &str) -> Result<String> {
    let key = model
        .api_key
        .as_deref()
        .ok_or_else(|| anyhow!("provider 'anthropic' has no API key"))?;
    let body = serde_json::json!({
        "model": model.model,
        "max_tokens": 1600,
        "temperature": 0.2,
        "system": system_message(model),
        "messages": [{"role": "user", "content": prompt}]
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("build Anthropic client")?
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("call Anthropic")?;
    if !response.status().is_success() {
        bail!("Anthropic returned {}", response.status());
    }
    let json: Value = response.json().await.context("parse Anthropic response")?;
    let text = json
        .get("content")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find_map(|v| v.get("text").and_then(Value::as_str))
        })
        .ok_or_else(|| anyhow!("unexpected Anthropic response shape"))?;
    Ok(text.trim().to_owned())
}

async fn call_ollama(model: &PromptModel, prompt: &str) -> Result<String> {
    let base = model
        .base_url
        .as_deref()
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/');
    let body = serde_json::json!({
        "model": model.model,
        "stream": false,
        "messages": [
            {"role": "system", "content": system_message(model)},
            {"role": "user", "content": prompt}
        ]
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("build Ollama client")?
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .context("call Ollama")?;
    if !response.status().is_success() {
        bail!("Ollama returned {}", response.status());
    }
    let json: Value = response.json().await.context("parse Ollama response")?;
    let text = json
        .pointer("/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("unexpected Ollama response shape"))?;
    Ok(text.trim().to_owned())
}

async fn parse_chat_response(response: reqwest::Response) -> Result<String> {
    if !response.status().is_success() {
        bail!("LLM returned {}", response.status());
    }
    let json: Value = response.json().await.context("parse LLM response")?;
    let text = json
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("unexpected LLM response shape"))?;
    Ok(text.trim().to_owned())
}

fn system_message(model: &PromptModel) -> &str {
    model.system_prompt.as_deref().unwrap_or(
        "You are a prompt architect for TENEX agents. Produce concise, durable system prompts.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_standard_resolved_config() {
        let value = serde_json::json!({
            "ok": true,
            "kind": "standard",
            "provider": "openrouter",
            "model": "anthropic/claude-haiku-4-5",
            "apiKeys": [{"key": "sk-or"}],
            "baseUrl": "https://example.test"
        });
        let model = prompt_model_from_resolved_value(&value).unwrap();
        assert_eq!(model.provider, "openrouter");
        assert_eq!(model.api_key.as_deref(), Some("sk-or"));
        assert_eq!(model.base_url.as_deref(), Some("https://example.test"));
    }

    #[test]
    fn parse_meta_uses_default_variant_resolved_config() {
        let value = serde_json::json!({
            "ok": true,
            "kind": "meta",
            "default": "deep",
            "variants": {
                "deep": {
                    "systemPrompt": "variant system",
                    "resolved": {
                        "ok": true,
                        "kind": "standard",
                        "provider": "anthropic",
                        "model": "claude",
                        "apiKeys": [{"key": "sk-ant"}]
                    }
                }
            }
        });
        let model = prompt_model_from_resolved_value(&value).unwrap();
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.system_prompt.as_deref(), Some("variant system"));
    }

    #[test]
    fn refinement_prompt_contains_all_agent_fields() {
        let prompt = build_refinement_prompt(
            "Planner",
            "planner",
            "planning specialist",
            "Plans work",
            "Use for plans",
            "Be careful",
        );
        for needle in [
            "Planner",
            "planner",
            "planning specialist",
            "Plans work",
            "Use for plans",
            "Be careful",
        ] {
            assert!(prompt.contains(needle), "missing {needle}");
        }
    }
}

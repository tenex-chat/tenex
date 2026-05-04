use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tenex_agent_registry::{AgentCategory, VALID_CATEGORIES};
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::ConfigStore;
use tenex_llm_config::{ResolvedConfig, StandardConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptModel {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentGenerationResult {
    pub name: String,
    pub slug: String,
    pub role: String,
    pub description: String,
    pub use_criteria: String,
    pub category: Option<AgentCategory>,
    pub instructions: String,
}

pub fn resolve_role_model(base_dir: &std::path::Path, role_key: &str) -> Result<PromptModel> {
    let store = ConfigStore::load(base_dir)?;
    let resolved = store.resolve_role_or_default(role_key, &KeyHealthTracker::new())?;
    prompt_model_from_resolved_config(&resolved)
}

pub fn resolve_supervision_model(base_dir: &std::path::Path) -> Result<PromptModel> {
    resolve_role_model(base_dir, "supervision")
}

pub fn build_generation_prompt(description: &str) -> String {
    let categories = VALID_CATEGORIES
        .iter()
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Generate a TENEX agent definition from this description.\n\
         Return ONLY a JSON object — no markdown fences, no extra text.\n\n\
         Description: {description}\n\n\
         Return JSON with exactly these fields:\n\
         - name: display name (title case, concise)\n\
         - slug: lowercase kebab-case identifier derived from the name\n\
         - role: one short phrase describing expertise (no punctuation)\n\
         - description: one sentence describing what the agent does\n\
         - useCriteria: one sentence describing when to use this agent\n\
         - category: one of: {categories}\n\
         - instructions: complete system prompt for the agent\n\n\
         Example output:\n\
         {{\"name\":\"Code Reviewer\",\"slug\":\"code-reviewer\",\"role\":\"code quality specialist\",\
         \"description\":\"Reviews code for correctness, style, and security.\",\
         \"useCriteria\":\"Use when reviewing a pull request or patch.\",\
         \"category\":\"reviewer\",\
         \"instructions\":\"You are Code Reviewer, a code quality specialist.\\n\\nYour job: ...\"}}"
    )
}

pub async fn generate_agent_from_description(
    model: &PromptModel,
    description: &str,
) -> Result<AgentGenerationResult> {
    let prompt = build_generation_prompt(description);
    let raw = refine_system_prompt(model, &prompt).await?;
    parse_generation_result(&raw)
}

fn parse_generation_result(raw: &str) -> Result<AgentGenerationResult> {
    let clean = raw.trim();
    let clean = clean
        .strip_prefix("```json")
        .or_else(|| clean.strip_prefix("```"))
        .map(|s| s.trim_end_matches("```").trim())
        .unwrap_or(clean);

    let json: Value =
        serde_json::from_str(clean).with_context(|| format!("LLM returned non-JSON:\n{raw}"))?;

    let name = json
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("LLM response missing 'name'"))?
        .to_owned();

    let slug = json
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(&name)
        .to_owned();

    let role = json
        .get("role")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("LLM response missing 'role'"))?
        .to_owned();

    let description = json
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    let use_criteria = json
        .get("useCriteria")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    let category = json
        .get("category")
        .and_then(Value::as_str)
        .and_then(AgentCategory::from_str_strict);

    let instructions = json
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("LLM response missing 'instructions'"))?
        .to_owned();

    Ok(AgentGenerationResult {
        name,
        slug,
        role,
        description,
        use_criteria,
        category,
        instructions,
    })
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

fn prompt_model_from_resolved_config(config: &ResolvedConfig) -> Result<PromptModel> {
    match config {
        ResolvedConfig::Standard(standard) => parse_standard(standard, None),
        ResolvedConfig::Meta(meta) => {
            let variant = meta
                .variants
                .get(&meta.default)
                .ok_or_else(|| anyhow!("meta config missing default variant '{}'", meta.default))?;
            parse_standard(&variant.resolved, variant.system_prompt.clone())
        }
        ResolvedConfig::Acp(_) => bail!("agent generation role resolved to an ACP config"),
    }
}

fn parse_standard(config: &StandardConfig, system_prompt: Option<String>) -> Result<PromptModel> {
    let api_key = config.api_keys.first().map(|key| key.key.clone());
    Ok(PromptModel {
        provider: config.provider.clone(),
        model: config.model.clone(),
        api_key,
        base_url: config.base_url.clone(),
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
        let config = ResolvedConfig::Standard(StandardConfig {
            provider: "openrouter".to_string(),
            model: "anthropic/claude-haiku-4-5".to_string(),
            api_keys: vec![tenex_llm_config::ApiKey {
                key: "sk-or".to_string(),
                alias: None,
            }],
            base_url: Some("https://example.test".to_string()),
            timeout: None,
            extras: serde_json::Map::new(),
        });
        let model = prompt_model_from_resolved_config(&config).unwrap();
        assert_eq!(model.provider, "openrouter");
        assert_eq!(model.api_key.as_deref(), Some("sk-or"));
        assert_eq!(model.base_url.as_deref(), Some("https://example.test"));
    }

    #[test]
    fn parse_meta_uses_default_variant_resolved_config() {
        let mut variants = indexmap::IndexMap::new();
        variants.insert(
            "deep".to_string(),
            tenex_llm_config::ResolvedVariant {
                model_config: "claude".to_string(),
                keywords: Vec::new(),
                description: None,
                system_prompt: Some("variant system".to_string()),
                resolved: StandardConfig {
                    provider: "anthropic".to_string(),
                    model: "claude".to_string(),
                    api_keys: vec![tenex_llm_config::ApiKey {
                        key: "sk-ant".to_string(),
                        alias: None,
                    }],
                    base_url: None,
                    timeout: None,
                    extras: serde_json::Map::new(),
                },
            },
        );
        let config = ResolvedConfig::Meta(tenex_llm_config::MetaConfig {
            default: "deep".to_string(),
            variants,
        });
        let model = prompt_model_from_resolved_config(&config).unwrap();
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.system_prompt.as_deref(), Some("variant system"));
    }

    #[test]
    fn build_generation_prompt_contains_required_field_names() {
        let prompt = build_generation_prompt("An agent that reviews code");
        for needle in [
            "name",
            "slug",
            "role",
            "description",
            "useCriteria",
            "category",
            "instructions",
            "An agent that reviews code",
        ] {
            assert!(
                prompt.contains(needle),
                "missing '{needle}' in generation prompt"
            );
        }
    }

    #[test]
    fn parse_generation_result_extracts_all_fields() {
        let raw = r#"{"name":"Code Reviewer","slug":"code-reviewer","role":"code quality specialist","description":"Reviews code.","useCriteria":"Use for PRs.","category":"reviewer","instructions":"You are Code Reviewer."}"#;
        let result = parse_generation_result(raw).unwrap();
        assert_eq!(result.name, "Code Reviewer");
        assert_eq!(result.slug, "code-reviewer");
        assert_eq!(result.role, "code quality specialist");
        assert_eq!(result.description, "Reviews code.");
        assert_eq!(result.use_criteria, "Use for PRs.");
        assert_eq!(result.category, Some(AgentCategory::Reviewer));
        assert_eq!(result.instructions, "You are Code Reviewer.");
    }

    #[test]
    fn parse_generation_result_strips_markdown_fences() {
        let raw = "```json\n{\"name\":\"Planner\",\"slug\":\"planner\",\"role\":\"planner\",\"instructions\":\"You plan.\"}\n```";
        let result = parse_generation_result(raw).unwrap();
        assert_eq!(result.name, "Planner");
    }

    #[test]
    fn parse_generation_result_unknown_category_returns_none() {
        let raw = r#"{"name":"X","slug":"x","role":"specialist","instructions":"Do stuff.","category":"unknown-type"}"#;
        let result = parse_generation_result(raw).unwrap();
        assert_eq!(result.category, None);
    }

    #[test]
    fn parse_generation_result_missing_name_returns_error() {
        let raw = r#"{"slug":"x","role":"specialist","instructions":"Do stuff."}"#;
        assert!(parse_generation_result(raw).is_err());
    }

    #[test]
    fn parse_generation_result_missing_instructions_returns_error() {
        let raw = r#"{"name":"X","slug":"x","role":"specialist"}"#;
        assert!(parse_generation_result(raw).is_err());
    }
}

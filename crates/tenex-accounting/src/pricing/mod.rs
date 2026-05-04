//! Pricing catalog. Embedded rate card, model lookups, and cost calculation.
//!
//! All prices in USD per million tokens (per provider convention). The catalog
//! is hand-maintained — when prices change, update this file. Do not move the
//! math elsewhere.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ModelPricing {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub reasoning_per_mtok: f64,
    pub embedding_per_mtok: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub provider: &'static str,
    pub model_family: &'static str,
    pub provider_model_id: &'static str,
    pub pricing: ModelPricing,
    pub context_window: Option<i64>,
    pub supports_caching: bool,
    pub supports_reasoning: bool,
    /// For local (Ollama) models: a paid model used as shadow-cost reference.
    /// Format: "<provider>/<provider_model_id>".
    pub shadow_reference: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub prompt: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
}

impl CostBreakdown {
    pub fn total(&self) -> f64 {
        self.prompt + self.output + self.cache_read + self.cache_write + self.reasoning
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
}

impl TokenCounts {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write + self.reasoning
    }
}

pub fn estimate_cost(pricing: &ModelPricing, tokens: &TokenCounts) -> CostBreakdown {
    let m = 1_000_000.0;
    let reasoning_rate = if pricing.reasoning_per_mtok > 0.0 {
        pricing.reasoning_per_mtok
    } else {
        pricing.output_per_mtok
    };
    CostBreakdown {
        prompt: tokens.input as f64 * pricing.input_per_mtok / m,
        output: tokens.output as f64 * pricing.output_per_mtok / m,
        cache_read: tokens.cache_read as f64 * pricing.cache_read_per_mtok / m,
        cache_write: tokens.cache_write as f64 * pricing.cache_write_per_mtok / m,
        reasoning: tokens.reasoning as f64 * reasoning_rate / m,
    }
}

pub fn estimate_embedding_cost(pricing: &ModelPricing, tokens: u64) -> f64 {
    tokens as f64 * pricing.embedding_per_mtok / 1_000_000.0
}

/// Resolve a (provider, model id) pair to a catalog entry. Match is
/// case-insensitive on provider; the model id is checked for exact match,
/// prefix-of, and suffix-of in that order.
pub fn lookup(provider: &str, model_id: &str) -> Option<&'static ModelEntry> {
    let p = provider.to_ascii_lowercase();
    let candidates: Vec<&'static ModelEntry> = CATALOG
        .iter()
        .filter(|e| e.provider.eq_ignore_ascii_case(&p))
        .collect();
    if let Some(hit) = candidates.iter().find(|e| e.provider_model_id == model_id) {
        return Some(*hit);
    }
    if let Some(hit) = candidates
        .iter()
        .find(|e| model_id.starts_with(e.provider_model_id))
    {
        return Some(*hit);
    }
    if let Some(hit) = candidates
        .iter()
        .find(|e| model_id.ends_with(e.provider_model_id))
    {
        return Some(*hit);
    }
    None
}

pub fn shadow_reference_for(provider: &str, model_id: &str) -> Option<&'static ModelEntry> {
    let entry = lookup(provider, model_id)?;
    let key = entry.shadow_reference?;
    let (ref_provider, ref_model) = key.split_once('/').unwrap_or(("", key));
    if !ref_provider.is_empty() {
        lookup(ref_provider, ref_model)
    } else {
        CATALOG.iter().find(|e| e.provider_model_id == ref_model)
    }
}

pub fn full_catalog() -> &'static [ModelEntry] {
    CATALOG
}

const fn pricing(
    input_per_mtok: f64,
    output_per_mtok: f64,
    cache_read_per_mtok: f64,
    cache_write_per_mtok: f64,
) -> ModelPricing {
    ModelPricing {
        input_per_mtok,
        output_per_mtok,
        cache_read_per_mtok,
        cache_write_per_mtok,
        reasoning_per_mtok: 0.0,
        embedding_per_mtok: 0.0,
    }
}

const fn embedding_pricing(per_mtok: f64) -> ModelPricing {
    ModelPricing {
        input_per_mtok: 0.0,
        output_per_mtok: 0.0,
        cache_read_per_mtok: 0.0,
        cache_write_per_mtok: 0.0,
        reasoning_per_mtok: 0.0,
        embedding_per_mtok: per_mtok,
    }
}

const ZERO: ModelPricing = ModelPricing {
    input_per_mtok: 0.0,
    output_per_mtok: 0.0,
    cache_read_per_mtok: 0.0,
    cache_write_per_mtok: 0.0,
    reasoning_per_mtok: 0.0,
    embedding_per_mtok: 0.0,
};

/// Prices captured ~2026-04. When providers change rates, edit here.
pub static CATALOG: &[ModelEntry] = &[
    // ─────────── OpenRouter (passes through to sub-providers) ───────────
    ModelEntry {
        provider: "openrouter",
        model_family: "gpt-4o-mini",
        provider_model_id: "openai/gpt-4o-mini",
        pricing: pricing(0.15, 0.60, 0.075, 0.0),
        context_window: Some(128_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "gpt-4o",
        provider_model_id: "openai/gpt-4o",
        pricing: pricing(2.50, 10.00, 1.25, 0.0),
        context_window: Some(128_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "claude-sonnet-4-5",
        provider_model_id: "anthropic/claude-sonnet-4.5",
        pricing: pricing(3.00, 15.00, 0.30, 3.75),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: true,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "claude-haiku-4-5",
        provider_model_id: "anthropic/claude-haiku-4.5",
        pricing: pricing(1.00, 5.00, 0.10, 1.25),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "claude-opus-4-7",
        provider_model_id: "anthropic/claude-opus-4.7",
        pricing: pricing(15.00, 75.00, 1.50, 18.75),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: true,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "deepseek-chat",
        provider_model_id: "deepseek/deepseek-chat",
        pricing: pricing(0.27, 1.10, 0.07, 0.0),
        context_window: Some(64_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openrouter",
        model_family: "llama-3.1-70b",
        provider_model_id: "meta-llama/llama-3.1-70b-instruct",
        pricing: pricing(0.52, 0.75, 0.0, 0.0),
        context_window: Some(131_000),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: None,
    },
    // ─────────── Anthropic direct ───────────
    ModelEntry {
        provider: "anthropic",
        model_family: "claude-sonnet-4-5",
        provider_model_id: "claude-sonnet-4-5",
        pricing: pricing(3.00, 15.00, 0.30, 3.75),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: true,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "anthropic",
        model_family: "claude-haiku-4-5",
        provider_model_id: "claude-haiku-4-5",
        pricing: pricing(1.00, 5.00, 0.10, 1.25),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "anthropic",
        model_family: "claude-opus-4-7",
        provider_model_id: "claude-opus-4-7",
        pricing: pricing(15.00, 75.00, 1.50, 18.75),
        context_window: Some(200_000),
        supports_caching: true,
        supports_reasoning: true,
        shadow_reference: None,
    },
    // ─────────── OpenAI direct ───────────
    ModelEntry {
        provider: "openai",
        model_family: "gpt-4o-mini",
        provider_model_id: "gpt-4o-mini",
        pricing: pricing(0.15, 0.60, 0.075, 0.0),
        context_window: Some(128_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openai",
        model_family: "gpt-4o",
        provider_model_id: "gpt-4o",
        pricing: pricing(2.50, 10.00, 1.25, 0.0),
        context_window: Some(128_000),
        supports_caching: true,
        supports_reasoning: false,
        shadow_reference: None,
    },
    // ─────────── Embedders ───────────
    ModelEntry {
        provider: "voyage",
        model_family: "voyage-3",
        provider_model_id: "voyage-3",
        pricing: embedding_pricing(0.06),
        context_window: Some(32_000),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "voyage",
        model_family: "voyage-3-large",
        provider_model_id: "voyage-3-large",
        pricing: embedding_pricing(0.18),
        context_window: Some(32_000),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openai",
        model_family: "text-embedding-3-small",
        provider_model_id: "text-embedding-3-small",
        pricing: embedding_pricing(0.02),
        context_window: Some(8_192),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: None,
    },
    ModelEntry {
        provider: "openai",
        model_family: "text-embedding-3-large",
        provider_model_id: "text-embedding-3-large",
        pricing: embedding_pricing(0.13),
        context_window: Some(8_192),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: None,
    },
    // ─────────── Ollama (local — zero direct $) ───────────
    ModelEntry {
        provider: "ollama",
        model_family: "deepseek-v4-flash",
        provider_model_id: "deepseek-v4-flash:cloud",
        pricing: ZERO,
        context_window: Some(64_000),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: Some("openrouter/deepseek/deepseek-chat"),
    },
    ModelEntry {
        provider: "ollama",
        model_family: "qwen2.5-coder",
        provider_model_id: "qwen2.5-coder:7b",
        pricing: ZERO,
        context_window: Some(32_000),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: Some("openrouter/anthropic/claude-haiku-4.5"),
    },
    ModelEntry {
        provider: "ollama",
        model_family: "nomic-embed-text",
        provider_model_id: "nomic-embed-text",
        pricing: ZERO,
        context_window: Some(8_192),
        supports_caching: false,
        supports_reasoning: false,
        shadow_reference: Some("voyage/voyage-3"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_finds_canonical() {
        let m = lookup("openrouter", "openai/gpt-4o-mini").unwrap();
        assert_eq!(m.model_family, "gpt-4o-mini");
    }

    #[test]
    fn lookup_handles_anthropic_versioned_snapshot() {
        let m = lookup("anthropic", "claude-sonnet-4-5-20250929").unwrap();
        assert_eq!(m.model_family, "claude-sonnet-4-5");
    }

    #[test]
    fn shadow_reference_resolves() {
        let r = shadow_reference_for("ollama", "deepseek-v4-flash:cloud").unwrap();
        assert_eq!(r.provider, "openrouter");
    }

    #[test]
    fn cost_math() {
        let m = lookup("openrouter", "openai/gpt-4o-mini").unwrap();
        let c = estimate_cost(
            &m.pricing,
            &TokenCounts {
                input: 1_000_000,
                output: 1_000_000,
                ..Default::default()
            },
        );
        assert!((c.prompt - 0.15).abs() < 1e-9);
        assert!((c.output - 0.60).abs() < 1e-9);
    }
}

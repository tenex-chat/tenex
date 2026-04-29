use serde::Deserialize;
use tenex_llm_config::resolver::load_providers;

#[derive(Debug, Deserialize)]
struct EmbedDoc {
    provider: String,
    model: String,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
}

impl EmbedDoc {
    fn load() -> Option<Self> {
        let path = dirs_next::home_dir()?.join(".tenex/embed.json");
        let content = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl EmbedConfig {
    pub fn load() -> Option<Self> {
        let doc = EmbedDoc::load()?;
        let base_dir = dirs_next::home_dir()?.join(".tenex");
        let providers = load_providers(&base_dir).ok()?;

        let entry = providers.providers.get(&doc.provider);
        let api_key = entry
            .and_then(|e| e.api_keys.first())
            .map(|k| k.key.clone());
        let base_url = doc
            .base_url
            .or_else(|| entry.and_then(|e| e.base_url.clone()));

        Some(Self {
            provider: doc.provider,
            model: doc.model,
            api_key,
            base_url,
        })
    }
}

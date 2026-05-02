use std::collections::HashMap;

#[derive(Clone, Default)]
pub(crate) struct AgentLabels {
    by_pubkey: HashMap<String, String>,
}

impl AgentLabels {
    pub(crate) fn from_slugs(slugs: impl IntoIterator<Item = (String, String)>) -> Self {
        let by_pubkey = slugs
            .into_iter()
            .filter_map(|(pubkey, slug)| {
                let pubkey = pubkey.trim().to_ascii_lowercase();
                let slug = slug.trim().to_string();
                if pubkey.is_empty() || slug.is_empty() {
                    None
                } else {
                    Some((pubkey, slug))
                }
            })
            .collect();
        Self { by_pubkey }
    }

    pub(crate) fn slug(
        &self,
        agent_pubkey: Option<&str>,
        recorded_slug: Option<&str>,
    ) -> Option<String> {
        if let Some(pubkey) = agent_pubkey {
            let normalized = pubkey.trim().to_ascii_lowercase();
            if let Some(slug) = self.by_pubkey.get(&normalized) {
                return Some(slug.clone());
            }
        }
        recorded_slug
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .map(str::to_owned)
    }

    pub(crate) fn label(
        &self,
        agent_pubkey: Option<&str>,
        recorded_slug: Option<&str>,
        fallback: &str,
    ) -> String {
        self.slug(agent_pubkey, recorded_slug)
            .unwrap_or_else(|| fallback.to_string())
    }
}

use crate::store::api_keys::parse_api_key_entry;
use crate::store::providers::ProviderEntry;

pub(super) fn first_usable_api_key(entry: ProviderEntry<'_>) -> Option<String> {
    entry.api_keys().into_iter().find_map(|raw| {
        let parsed = parse_api_key_entry(&raw);
        if parsed.key.is_empty() || parsed.key == "none" {
            None
        } else {
            Some(parsed.key)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::providers::ProvidersDoc;

    #[test]
    fn first_usable_api_key_strips_label() {
        let mut doc = ProvidersDoc::new();
        doc.set_api_keys(
            "anthropic",
            vec![
                "".to_owned(),
                "none".to_owned(),
                "sk-ant-test work".to_owned(),
            ],
        );
        let key = first_usable_api_key(doc.get("anthropic").unwrap());
        assert_eq!(key.as_deref(), Some("sk-ant-test"));
    }
}

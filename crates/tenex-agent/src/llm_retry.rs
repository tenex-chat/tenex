//! Per-provider multi-key retry primitives.
//!
//! Providers may expose multiple API keys (configured as a JSON array in
//! `providers.json`). When the active key fails with an auth or rate-limit
//! response, [`with_key_retry`] rotates to the next healthy key and reports
//! the failure back to the shared [`KeyHealthTracker`]. The streaming path
//! uses [`RotatingModel`] instead, which wraps one rig [`CompletionModel`]
//! per key and performs the same rotation at the request-start boundary.
//!
//! Rotation happens **before** any tool calls are executed on the streaming
//! path, so a failure on key A never causes tool calls already issued
//! against key A to be replayed against key B. Once a stream has produced
//! any content, errors are surfaced to the caller unchanged.
//!
//! The classifier in [`is_rotatable_key_error`] rotates on signals that are
//! specific to a single key (401/403, `invalid_api_key`, 429/rate-limit
//! responses). Server-side outages (5xx) and transport errors fall through
//! to the caller — rotating to another key would not help.

use std::sync::Arc;

use anyhow::Result;
use rig::completion::{CompletionError, CompletionModel, CompletionRequest, CompletionResponse};
use rig::streaming::StreamingCompletionResponse;
use tenex_llm_config::key_health::KeyHealthTracker;

use crate::config::ResolvedModel;

/// Returns true when an error reflects a key-specific failure: the same
/// request *might* succeed against a different key for the same provider.
///
/// Detection is substring-based against the error's `Display`/`Debug` form
/// because rig wraps every provider error in a single `CompletionError`
/// without preserving the HTTP status. Conservative on purpose: anything we
/// fail to recognise as key-specific (network errors, 5xx, malformed
/// responses) is *not* rotated.
pub fn is_rotatable_key_error<E: std::fmt::Display>(err: &E) -> bool {
    let lower = err.to_string().to_ascii_lowercase();

    // Authentication / authorization failures.
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid_api_key")
        || lower.contains("invalid api key")
        || lower.contains("authentication")
        || lower.contains("authentication_error")
        || lower.contains("403")
        || lower.contains("permission_denied")
        || lower.contains("forbidden")
    {
        return true;
    }

    // Rate-limit responses. A second key under a different account or tier
    // may have headroom.
    if lower.contains("429")
        || lower.contains("rate_limit")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("quota")
    {
        return true;
    }

    false
}

/// Run `op` once per healthy API key, rotating on key-specific failures.
///
/// `op` receives the API key string for each attempt. For providers that
/// take no key (e.g. `ollama`, `mock`), `op` is invoked exactly once with
/// an empty string. The closure's future is `Send` so callers can await it
/// without further wrapping.
///
/// On a rotatable error, the key is marked failed via
/// [`KeyHealthTracker::mark_failed`] using its original-array index and
/// the next healthy key is tried. The last rotatable error is returned if
/// every key fails; a non-rotatable error is returned immediately.
pub async fn with_key_retry<T, F, Fut>(resolved: &ResolvedModel, mut op: F) -> Result<T>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let healthy = resolved.healthy_api_keys();

    if healthy.is_empty() {
        // Providers that take no key (ollama/mock) populate `api_keys` as
        // empty; the caller's closure ignores the argument in that case.
        // Providers that *do* expect keys but have none healthy fall here
        // too: surface a clear error before calling the closure.
        if resolved.api_keys.is_empty() {
            return op(String::new()).await;
        }
        anyhow::bail!(
            "all API keys for provider '{}' are unhealthy",
            resolved.provider
        );
    }

    let mut last_err: Option<anyhow::Error> = None;
    for key in healthy {
        match op(key.key.clone()).await {
            Ok(value) => return Ok(value),
            Err(err) if is_rotatable_key_error(&err) => {
                resolved
                    .key_health
                    .mark_failed(&resolved.provider, key.original_index);
                tracing::warn!(
                    provider = %resolved.provider,
                    key_index = key.original_index,
                    alias = key.alias.as_deref().unwrap_or(""),
                    error = %err,
                    "API key failed; rotating to next key"
                );
                last_err = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_err.unwrap_or_else(|| {
        anyhow::anyhow!(
            "no API keys remained healthy for provider '{}'",
            resolved.provider
        )
    }))
}

/// `CompletionModel` wrapper that rotates between one pre-built rig model
/// per API key when the underlying call fails with a key-specific error.
///
/// Constructed by building one inner `M` per healthy key (each wired to its
/// own API key in the rig client). `completion` and `stream` try each model
/// in order; on a rotatable error before any output is produced, the
/// originating key is marked unhealthy and the next model is tried.
///
/// Mid-stream errors (after the first chunk) bubble up unchanged: rotating
/// once tool calls have started would re-execute side-effecting tools
/// against a different key.
#[derive(Clone)]
pub struct RotatingModel<M> {
    provider: String,
    health: Arc<KeyHealthTracker>,
    /// `(original_index, model)` for each key, in resolution order.
    keyed_models: Vec<(usize, M)>,
}

impl<M> RotatingModel<M> {
    /// Build a rotating wrapper. `keyed_models` must contain one entry per
    /// healthy key, each tagged with the key's original index in the
    /// provider config so failures map back to the tracker.
    pub fn new(
        provider: String,
        health: Arc<KeyHealthTracker>,
        keyed_models: Vec<(usize, M)>,
    ) -> Self {
        Self {
            provider,
            health,
            keyed_models,
        }
    }
}

impl<M> CompletionModel for RotatingModel<M>
where
    M: CompletionModel,
{
    type Response = M::Response;
    type StreamingResponse = M::StreamingResponse;
    type Client = ();

    fn make(_client: &Self::Client, _model: impl Into<String>) -> Self {
        // RotatingModel is constructed directly via `new` once per turn —
        // it has no associated rig client to drive `make` from.
        unreachable!("RotatingModel is constructed via RotatingModel::new, not CompletionModel::make")
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> std::result::Result<CompletionResponse<Self::Response>, CompletionError> {
        if self.keyed_models.is_empty() {
            return Err(CompletionError::ProviderError(format!(
                "no API keys available for provider '{}'",
                self.provider
            )));
        }
        let mut last_err: Option<CompletionError> = None;
        for (index, model) in &self.keyed_models {
            match model.completion(request.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) if is_rotatable_key_error(&err) => {
                    self.health.mark_failed(&self.provider, *index);
                    tracing::warn!(
                        provider = %self.provider,
                        key_index = *index,
                        error = %err,
                        "API key failed during completion; rotating to next key"
                    );
                    last_err = Some(err);
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            CompletionError::ProviderError(format!(
                "all API keys for provider '{}' are unhealthy",
                self.provider
            ))
        }))
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> std::result::Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError>
    {
        if self.keyed_models.is_empty() {
            return Err(CompletionError::ProviderError(format!(
                "no API keys available for provider '{}'",
                self.provider
            )));
        }
        let mut last_err: Option<CompletionError> = None;
        for (index, model) in &self.keyed_models {
            // Stream initiation either fails immediately (key-related) or
            // returns a stream we hand back to the caller. Once the stream
            // is returned, downstream chunk errors are not retried here —
            // tool calls may already have been emitted.
            match model.stream(request.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) if is_rotatable_key_error(&err) => {
                    self.health.mark_failed(&self.provider, *index);
                    tracing::warn!(
                        provider = %self.provider,
                        key_index = *index,
                        error = %err,
                        "API key failed during stream init; rotating to next key"
                    );
                    last_err = Some(err);
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            CompletionError::ProviderError(format!(
                "all API keys for provider '{}' are unhealthy",
                self.provider
            ))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tenex_llm_config::ApiKey;

    #[test]
    fn classifies_anthropic_invalid_api_key() {
        let err =
            anyhow::anyhow!("ProviderError: 401 authentication_error: invalid x-api-key");
        assert!(is_rotatable_key_error(&err));
    }

    #[test]
    fn classifies_openai_invalid_api_key() {
        let err = anyhow::anyhow!(
            "ProviderError: invalid_api_key: Incorrect API key provided: sk-***"
        );
        assert!(is_rotatable_key_error(&err));
    }

    #[test]
    fn classifies_rate_limit() {
        let err = anyhow::anyhow!("ProviderError: 429 rate_limit_exceeded");
        assert!(is_rotatable_key_error(&err));
    }

    #[test]
    fn does_not_rotate_on_context_window_exceeded() {
        let err = anyhow::anyhow!(
            "ProviderError: 400 prompt is too long: 264121 tokens > 200000 maximum"
        );
        assert!(!is_rotatable_key_error(&err));
    }

    #[test]
    fn does_not_rotate_on_5xx() {
        let err = anyhow::anyhow!("ProviderError: 503 Service Unavailable");
        assert!(!is_rotatable_key_error(&err));
    }

    #[test]
    fn does_not_rotate_on_transport_failure() {
        let err = anyhow::anyhow!("HttpError: connection reset by peer");
        assert!(!is_rotatable_key_error(&err));
    }

    fn make_resolved(provider: &str, api_keys: Vec<ApiKey>) -> ResolvedModel {
        ResolvedModel {
            provider: provider.to_string(),
            model: "test-model".to_string(),
            api_keys,
            base_url: None,
            key_health: Arc::new(KeyHealthTracker::new()),
        }
    }

    fn key(idx: usize, val: &str) -> ApiKey {
        ApiKey {
            key: val.to_string(),
            original_index: idx,
            alias: None,
        }
    }

    #[tokio::test]
    async fn with_key_retry_returns_on_first_success() {
        let resolved = make_resolved("anthropic", vec![key(0, "k0"), key(1, "k1")]);
        let mut attempts = 0;
        let result = with_key_retry(&resolved, |k| {
            attempts += 1;
            async move { Ok::<_, anyhow::Error>(k) }
        })
        .await
        .unwrap();
        assert_eq!(result, "k0");
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn with_key_retry_rotates_on_auth_error() {
        let resolved = make_resolved("anthropic", vec![key(0, "k0"), key(1, "k1")]);
        let mut seen: Vec<String> = Vec::new();
        let result = with_key_retry(&resolved, |k| {
            seen.push(k.clone());
            async move {
                if k == "k0" {
                    Err::<String, _>(anyhow::anyhow!("401 unauthorized"))
                } else {
                    Ok(k)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(result, "k1");
        assert_eq!(seen, vec!["k0", "k1"]);
        assert!(!resolved.key_health.is_healthy("anthropic", 0));
        assert!(resolved.key_health.is_healthy("anthropic", 1));
    }

    #[tokio::test]
    async fn with_key_retry_propagates_non_rotatable_error_without_marking() {
        let resolved = make_resolved("anthropic", vec![key(0, "k0"), key(1, "k1")]);
        let err = with_key_retry(&resolved, |_k| async {
            Err::<(), _>(anyhow::anyhow!("400 prompt is too long"))
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("too long"));
        // First key was tried but is not rotatable → not marked failed.
        assert!(resolved.key_health.is_healthy("anthropic", 0));
        assert!(resolved.key_health.is_healthy("anthropic", 1));
    }

    #[tokio::test]
    async fn with_key_retry_exhausts_and_returns_last_rotatable_error() {
        let resolved = make_resolved("anthropic", vec![key(0, "k0"), key(1, "k1")]);
        let err = with_key_retry(&resolved, |k| async move {
            Err::<(), _>(anyhow::anyhow!("429 rate_limit for {k}"))
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("rate_limit"));
        assert!(!resolved.key_health.is_healthy("anthropic", 0));
        assert!(!resolved.key_health.is_healthy("anthropic", 1));
    }

    #[tokio::test]
    async fn with_key_retry_invokes_once_when_no_keys_configured() {
        let resolved = make_resolved("ollama", vec![]);
        let mut attempts = 0;
        let result = with_key_retry(&resolved, |k| {
            attempts += 1;
            async move {
                assert_eq!(k, "");
                Ok::<_, anyhow::Error>(())
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(attempts, 1);
    }
}

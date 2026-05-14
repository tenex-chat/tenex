#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompletionErrorClass {
    ContextWindowExceeded,
    Other,
}

pub(super) fn classify_error(error: &anyhow::Error) -> CompletionErrorClass {
    classify_message(&error.to_string())
}

pub(super) fn is_context_window_exceeded(error: &anyhow::Error) -> bool {
    classify_error(error) == CompletionErrorClass::ContextWindowExceeded
}

fn classify_message(message: &str) -> CompletionErrorClass {
    let lower = message.to_ascii_lowercase();
    let contextish = lower.contains("context") || lower.contains("prompt");
    let exceeded = lower.contains("too long")
        || lower.contains("exceed")
        || lower.contains("larger than")
        || lower.contains("maximum")
        || lower.contains("limit");

    if lower.contains("context_length_exceeded")
        || lower.contains("maximum context length")
        || lower.contains("context window")
        || lower.contains("prompt is too long")
        || lower.contains("num_ctx")
        || (contextish && exceeded)
    {
        CompletionErrorClass::ContextWindowExceeded
    } else {
        CompletionErrorClass::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_anthropic_prompt_too_long() {
        assert_eq!(
            classify_message("ProviderError: 400 prompt is too long: 264121 tokens"),
            CompletionErrorClass::ContextWindowExceeded
        );
    }

    #[test]
    fn classifies_openai_context_length_exceeded() {
        assert_eq!(
            classify_message(
                "ProviderError: context_length_exceeded: maximum context length is 128000 tokens"
            ),
            CompletionErrorClass::ContextWindowExceeded
        );
    }

    #[test]
    fn classifies_openrouter_maximum_context_length() {
        assert_eq!(
            classify_message(
                "ProviderError: This model's maximum context length is 200000 tokens. However, you requested 201000 tokens"
            ),
            CompletionErrorClass::ContextWindowExceeded
        );
    }

    #[test]
    fn classifies_ollama_context_window_errors() {
        assert_eq!(
            classify_message("ProviderError: requested tokens exceed context window of 262144"),
            CompletionErrorClass::ContextWindowExceeded
        );
    }

    #[test]
    fn leaves_unrelated_provider_errors_alone() {
        assert_eq!(
            classify_message("ProviderError: invalid API key"),
            CompletionErrorClass::Other
        );
    }
}

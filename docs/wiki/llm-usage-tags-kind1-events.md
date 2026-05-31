---
title: "LLM Usage Tags on Kind:1 Events"
slug: llm-usage-tags-kind1-events
summary: "LLM usage tags are attached to kind:1 events rather than to chat spans"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-19
updated: 2026-05-19
verified: 2026-05-19
compiled-from: conversation
sources:
  - session:0a42dfb6-343b-4ddb-951e-7b598d7a809d
---

# LLM Usage Tags on Kind:1 Events

## LLM Usage Tags on Kind:1 Events

LLM usage tags are attached to kind:1 events rather than to chat spans. Kind:1 events carry LLM usage tags including llm-prompt-tokens, llm-completion-tokens, llm-total-tokens, llm-cached-input-tokens, llm-cache-creation-tokens, llm-runtime, llm-model, and llm-cost-usd. The LlmUsage struct includes a cache_creation_tokens field of type Option<u64>, which is emitted as the llm-cache-creation-tokens tag on kind:1 events alongside the existing llm-cached-input-tokens tag. The cache_creation_tokens field is populated from stream_usage.cache_creation_input_tokens in both the Accept and InjectMessage paths in the turn loop. [^0a42d-1]

## See Also


---
title: ACP Wizard Model ID Picker
slug: acp-wizard-model-id-picker
summary: The ACP wizard Model ID prompt uses a Select picker backed by the models.dev disk cache, filtered by provider (anthropic for ClaudeCode, openai for Codex)
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-12
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:8b1a1633-3324-4442-8e87-665002311a02
  - session:4667caf7-5c44-4cfa-b3d8-34f1f6baf81e
  - session:57c4c2bb-6510-4aa6-9989-96f36ed5dc98
---

# ACP Wizard Model ID Picker

## Model ID Picker

When configuring a provider, the CLI fetches available models from the provider's live API and presents them as a selectable list rather than requiring manual model name entry. The Anthropic model fetch calls GET https://api.anthropic.com/v1/models using the stored API key and returns (id, display_name) pairs such as (claude-opus-4-7, Claude Opus 4.7). The OpenAI model fetch calls GET https://api.openai.com/v1/models and filters results to OpenAI-owned gpt-*, o1, o3, and o4 models. The model picker displays labels in the format 'Display Name (id)' and includes a 'Custom model…' escape hatch that falls back to free-text input. When the live API fetch fails (e.g., bad API key or offline), the CLI silently falls back to the existing models.dev cache or text-input path.

<!-- citations: [^8b1a1-1] [^4667c-1] [^57c4c-1] -->
## See Also


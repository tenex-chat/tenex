# llm/ — LLM Layer (Layer 2)

Abstraction layer for LLM providers. Agents and services never talk to provider SDKs directly.

## Key Files

- `LLMServiceFactory.ts` — Provider initialization and configuration
- `service.ts` — Core LLM service orchestration
- `ChunkHandler.ts` — Stream chunk processing
- `FinishHandler.ts` — Stream completion handling
- `StreamPublisher.ts` — Publishes stream output to Nostr
- `MessageProcessor.ts` — Message pre-processing
- `LLMConfigEditor.ts` — CLI config editing for LLM settings
- `TracingUtils.ts` — LLM call tracing
- `chunk-validators.ts` — Validates incoming stream chunks

## Subdirectories

- `providers/standard/` — Standard providers (Claude, OpenAI, OpenRouter, Ollama, Gemini)
- `providers/agent/` — Agent-specific providers (ClaudeCode, CodexAppServer) with tool adapters
- `providers/registry/` — Provider registration
- `providers/base/` — Base provider interfaces
- `middleware/` — Request/response middleware pipeline
- `meta/` — Provider metadata
- `utils/` — ModelSelector and other utilities

## Rules

- All providers implement the base provider interface from `providers/base/`
- Provider-specific code stays in this module — no `if (provider === "claude")` in agents/
- Retries and middleware are handled by the middleware pipeline, not inline
- Credentials come from environment variables or `~/.tenex/llms.json` via ConfigService

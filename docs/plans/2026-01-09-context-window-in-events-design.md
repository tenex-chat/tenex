# Context Window in Events Design

## Purpose

Add model context window size to LLM events for:
1. **Consumer visibility** - Subscribers to Nostr events can see how much context the agent had available
2. **Debugging/observability** - Help diagnose issues where context limits may have affected output quality

## Approach

Hybrid strategy: dynamic fetch for providers with metadata APIs, hardcoded fallbacks for those without.

| Provider | Source |
|----------|--------|
| OpenRouter | `GET /api/v1/models` → `context_length` |
| Gemini | `models.get()` → `input_token_limit` |
| Ollama | `GET /api/show` |
| OpenAI | Hardcoded lookup table |
| Anthropic | Hardcoded lookup table |

## Design

### Cache Module

**File: `src/llm/utils/context-window-cache.ts`**

Single module with three responsibilities:

```typescript
// Runtime cache
const cache = new Map<string, number>();

// Fallbacks for providers without metadata APIs
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "anthropic:claude-sonnet-4-20250514": 200_000,
  "anthropic:claude-opus-4-20250514": 200_000,
  // OpenAI
  "openai:gpt-4o": 128_000,
  "openai:gpt-4-turbo": 128_000,
  // ... etc
};

// Public API
export function getContextWindow(provider: string, model: string): number | undefined;
export function resolveContextWindow(provider: string, model: string): Promise<void>;
```

### Resolution Logic

```typescript
async function resolveContextWindow(provider: string, model: string): Promise<void> {
  const key = `${provider}:${model}`;

  if (cache.has(key)) return;

  // Check hardcoded fallbacks first
  if (KNOWN_CONTEXT_WINDOWS[key]) {
    cache.set(key, KNOWN_CONTEXT_WINDOWS[key]);
    return;
  }

  // Provider-specific fetch
  switch (provider) {
    case "openrouter":
      await fetchFromOpenRouter(model);
      break;
    case "ollama":
      await fetchFromOllama(model);
      break;
    case "gemini-cli":
      await fetchFromGemini(model);
      break;
  }
}
```

For OpenRouter, reuse `fetchOpenRouterModels()` from `openrouter-models.ts` and cache all models at once.

### LLMService Integration

Fire-and-forget async fetch at construction:

```typescript
constructor(...) {
  // ... existing setup ...

  resolveContextWindow(this.provider, this.model).catch(() => {
    // Silently ignore - context window will just be undefined
  });
}

private buildUsage(base: LanguageModelUsage, extras?: {...}): LanguageModelUsageWithCostUsd {
  return {
    ...base,
    ...extras,
    contextWindow: getContextWindow(this.provider, this.model),
  };
}
```

### Type Change

**File: `src/llm/types.ts`**

```typescript
export type LanguageModelUsageWithCostUsd = LanguageModelUsage & {
  costUsd?: number;
  model?: string;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  contextWindow?: number;  // NEW
};
```

## Files to Change

| File | Change |
|------|--------|
| `src/llm/utils/context-window-cache.ts` | New - cache + fallbacks + fetchers |
| `src/llm/types.ts` | Add `contextWindow` to usage type |
| `src/llm/service.ts` | Fire-and-forget resolve, attach to usage |
| `src/llm/providers/ollama-models.ts` | Add context window fetch via `/api/show` |

## Notes

- `openrouter-models.ts` already fetches `context_length` - reuse it
- Event consumers don't need changes - `contextWindow` appears automatically in `LanguageModelUsageWithCostUsd`
- Context window may be `undefined` for first few events if fetch hasn't completed (acceptable for observability data)

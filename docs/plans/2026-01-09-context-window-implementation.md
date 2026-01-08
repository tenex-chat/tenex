# Context Window in Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add model context window size to LLM events for consumer visibility and debugging.

**Architecture:** Module-level cache with provider-specific fetchers. Fire-and-forget async resolution at LLMService construction. Hardcoded fallbacks for providers without metadata APIs (OpenAI, Anthropic).

**Tech Stack:** TypeScript, existing fetch patterns from openrouter-models.ts

---

## Task 1: Add contextWindow to Usage Type

**Files:**
- Modify: `src/llm/types.ts:110-117`

**Step 1: Add contextWindow field**

In `src/llm/types.ts`, add `contextWindow` to the type:

```typescript
export type LanguageModelUsageWithCostUsd = LanguageModelUsage & {
    costUsd?: number;
    model?: string;
    /** Cached input tokens (from OpenRouter promptTokensDetails.cachedTokens) */
    cachedInputTokens?: number;
    /** Reasoning tokens (from OpenRouter completionTokensDetails.reasoningTokens) */
    reasoningTokens?: number;
    /** Model context window size in tokens */
    contextWindow?: number;
};
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no consumers break since field is optional)

**Step 3: Commit**

```bash
git add src/llm/types.ts
git commit -m "feat(llm): add contextWindow to usage type"
```

---

## Task 2: Create Context Window Cache - Core Structure

**Files:**
- Create: `src/llm/utils/context-window-cache.ts`
- Create: `src/llm/utils/__tests__/context-window-cache.test.ts`

**Step 1: Write test for hardcoded fallbacks**

Create `src/llm/utils/__tests__/context-window-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { getContextWindow, clearCache } from "../context-window-cache";

describe("context-window-cache", () => {
    beforeEach(() => {
        clearCache();
    });

    describe("getContextWindow", () => {
        it("returns undefined for unknown models", () => {
            expect(getContextWindow("unknown", "unknown-model")).toBeUndefined();
        });

        it("returns hardcoded value for known Anthropic models", () => {
            expect(getContextWindow("anthropic", "claude-sonnet-4-20250514")).toBe(200_000);
        });

        it("returns hardcoded value for known OpenAI models", () => {
            expect(getContextWindow("openai", "gpt-4o")).toBe(128_000);
        });
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Create minimal implementation**

Create `src/llm/utils/context-window-cache.ts`:

```typescript
/**
 * Context window cache for LLM models
 * Provides both hardcoded fallbacks and dynamic fetching
 */

const cache = new Map<string, number>();

/**
 * Hardcoded context windows for providers without metadata APIs
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
    // Anthropic - all 200K (1M beta requires special header)
    "anthropic:claude-sonnet-4-20250514": 200_000,
    "anthropic:claude-opus-4-20250514": 200_000,
    "anthropic:claude-3-5-sonnet-20241022": 200_000,
    "anthropic:claude-3-5-haiku-20241022": 200_000,
    "anthropic:claude-3-opus-20240229": 200_000,
    "anthropic:claude-3-sonnet-20240229": 200_000,
    "anthropic:claude-3-haiku-20240307": 200_000,

    // OpenAI
    "openai:gpt-4o": 128_000,
    "openai:gpt-4o-mini": 128_000,
    "openai:gpt-4-turbo": 128_000,
    "openai:gpt-4": 8_192,
    "openai:gpt-3.5-turbo": 16_385,
    "openai:o1": 200_000,
    "openai:o1-mini": 128_000,
    "openai:o1-preview": 128_000,
    "openai:o3-mini": 200_000,
};

/**
 * Get cached context window for a model
 * Returns undefined if not cached or unknown
 */
export function getContextWindow(provider: string, model: string): number | undefined {
    const key = `${provider}:${model}`;

    // Check runtime cache first
    if (cache.has(key)) {
        return cache.get(key);
    }

    // Check hardcoded fallbacks
    if (KNOWN_CONTEXT_WINDOWS[key]) {
        return KNOWN_CONTEXT_WINDOWS[key];
    }

    return undefined;
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
    cache.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/utils/context-window-cache.ts src/llm/utils/__tests__/context-window-cache.test.ts
git commit -m "feat(llm): add context window cache with hardcoded fallbacks"
```

---

## Task 3: Add OpenRouter Fetcher

**Files:**
- Modify: `src/llm/utils/context-window-cache.ts`
- Modify: `src/llm/utils/__tests__/context-window-cache.test.ts`

**Step 1: Write test for OpenRouter resolution**

Add to `src/llm/utils/__tests__/context-window-cache.test.ts`:

```typescript
import { getContextWindow, clearCache, resolveContextWindow } from "../context-window-cache";
import { vi } from "vitest";

describe("resolveContextWindow", () => {
    beforeEach(() => {
        clearCache();
        vi.restoreAllMocks();
    });

    it("fetches and caches OpenRouter model context window", async () => {
        // Mock fetch
        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                data: [
                    { id: "openai/gpt-4o", context_length: 128000 },
                    { id: "anthropic/claude-3-opus", context_length: 200000 },
                ]
            })
        });

        await resolveContextWindow("openrouter", "openai/gpt-4o");

        expect(getContextWindow("openrouter", "openai/gpt-4o")).toBe(128000);
        // Should cache all models from response
        expect(getContextWindow("openrouter", "anthropic/claude-3-opus")).toBe(200000);
    });

    it("does not fetch if already cached", async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ data: [{ id: "test/model", context_length: 50000 }] })
        });

        await resolveContextWindow("openrouter", "test/model");
        await resolveContextWindow("openrouter", "test/model");

        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: FAIL with "resolveContextWindow is not exported"

**Step 3: Add OpenRouter fetcher implementation**

Add to `src/llm/utils/context-window-cache.ts`:

```typescript
import { fetchOpenRouterModels } from "@/llm/providers/openrouter-models";

/** Track in-flight fetches to avoid duplicate requests */
const pendingFetches = new Map<string, Promise<void>>();

/**
 * Resolve context window for a model (async)
 * For OpenRouter, fetches and caches all models at once
 */
export async function resolveContextWindow(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;

    // Already cached
    if (cache.has(key) || KNOWN_CONTEXT_WINDOWS[key]) {
        return;
    }

    // Check if fetch already in progress
    if (pendingFetches.has(provider)) {
        await pendingFetches.get(provider);
        return;
    }

    switch (provider) {
        case "openrouter":
            await fetchAndCacheOpenRouter();
            break;
        // Other providers will be added in subsequent tasks
    }
}

async function fetchAndCacheOpenRouter(): Promise<void> {
    const fetchPromise = (async () => {
        const models = await fetchOpenRouterModels();
        for (const model of models) {
            cache.set(`openrouter:${model.id}`, model.context_length);
        }
    })();

    pendingFetches.set("openrouter", fetchPromise);

    try {
        await fetchPromise;
    } finally {
        pendingFetches.delete("openrouter");
    }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/utils/context-window-cache.ts src/llm/utils/__tests__/context-window-cache.test.ts
git commit -m "feat(llm): add OpenRouter context window fetcher"
```

---

## Task 4: Add Ollama Fetcher

**Files:**
- Modify: `src/llm/utils/context-window-cache.ts`
- Modify: `src/llm/utils/__tests__/context-window-cache.test.ts`

**Step 1: Write test for Ollama resolution**

Add to `src/llm/utils/__tests__/context-window-cache.test.ts`:

```typescript
it("fetches Ollama model context window via /api/show", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
            model_info: {
                "llama.context_length": 8192
            }
        })
    });

    await resolveContextWindow("ollama", "llama3.2:3b");

    expect(getContextWindow("ollama", "llama3.2:3b")).toBe(8192);
    expect(fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/show",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ name: "llama3.2:3b" })
        })
    );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: FAIL (Ollama case not handled)

**Step 3: Add Ollama fetcher implementation**

Add to `src/llm/utils/context-window-cache.ts` in `resolveContextWindow`:

```typescript
case "ollama":
    await fetchAndCacheOllama(model);
    break;
```

Add the function:

```typescript
async function fetchAndCacheOllama(model: string): Promise<void> {
    const key = `ollama:${model}`;

    // Per-model fetch for Ollama (no bulk API)
    if (pendingFetches.has(key)) {
        await pendingFetches.get(key);
        return;
    }

    const fetchPromise = (async () => {
        const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${baseUrl}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: model }),
        });

        if (!response.ok) {
            return;
        }

        interface OllamaShowResponse {
            model_info?: {
                "llama.context_length"?: number;
            };
        }

        const data = (await response.json()) as OllamaShowResponse;
        const contextLength = data.model_info?.["llama.context_length"];

        if (contextLength) {
            cache.set(key, contextLength);
        }
    })();

    pendingFetches.set(key, fetchPromise);

    try {
        await fetchPromise;
    } finally {
        pendingFetches.delete(key);
    }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/llm/utils/__tests__/context-window-cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/utils/context-window-cache.ts src/llm/utils/__tests__/context-window-cache.test.ts
git commit -m "feat(llm): add Ollama context window fetcher"
```

---

## Task 5: Integrate with LLMService

**Files:**
- Modify: `src/llm/service.ts`

**Step 1: Add fire-and-forget resolution in constructor**

In `src/llm/service.ts`, add import and constructor call:

```typescript
import { getContextWindow, resolveContextWindow } from "./utils/context-window-cache";
```

At end of constructor (after line 150):

```typescript
// Fire-and-forget: start resolving context window
resolveContextWindow(this.provider, this.model).catch(() => {
    // Silently ignore - context window will be undefined if fetch fails
});
```

**Step 2: Add contextWindow to complete event**

In `createFinishHandler()` around line 778, modify the emit:

```typescript
this.emit("complete", {
    message: finalMessage,
    steps: e.steps,
    usage: {
        ...(e.totalUsage || {}),
        costUsd: openrouterUsage?.cost,
        cachedInputTokens: openrouterUsage?.promptTokensDetails?.cachedTokens,
        reasoningTokens: openrouterUsage?.completionTokensDetails?.reasoningTokens,
        contextWindow: getContextWindow(this.provider, this.model),
    },
    finishReason: e.finishReason,
});
```

**Step 3: Add contextWindow to tool-will-execute event**

In `handleToolCall()` around line 843, update the currentStepUsage to include contextWindow.

Create a helper method after line 159:

```typescript
/**
 * Get context window for current model
 */
getModelContextWindow(): number | undefined {
    return getContextWindow(this.provider, this.model);
}
```

Then update `handleToolCall()`:

```typescript
private handleToolCall(toolCallId: string, toolName: string, args: unknown): void {
    trace.getActiveSpan()?.addEvent("llm.tool_will_execute", {
        "tool.name": toolName,
        "tool.call_id": toolCallId,
    });
    this.emit("tool-will-execute", {
        toolName,
        toolCallId,
        args,
        usage: this.currentStepUsage
            ? { ...this.currentStepUsage, contextWindow: this.getModelContextWindow() }
            : undefined,
    });
}
```

**Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/service.ts
git commit -m "feat(llm): integrate context window into LLMService events"
```

---

## Task 6: Final Verification

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Manual verification (optional)**

Start the daemon and check that events include `contextWindow` in usage:

```bash
pnpm dev
# Trigger an agent execution and inspect the events
```

---

## Summary

Files created:
- `src/llm/utils/context-window-cache.ts`
- `src/llm/utils/__tests__/context-window-cache.test.ts`

Files modified:
- `src/llm/types.ts` - added `contextWindow` field
- `src/llm/service.ts` - fire-and-forget resolution, attach to events

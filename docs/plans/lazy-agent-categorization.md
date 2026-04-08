# Lazy/On-Demand Agent Categorization at Runtime

## Context

TENEX stores agents as JSON files under `.tenex/agents/<pubkey>.json`. Each agent has optional `category` (explicit) and `inferredCategory` (LLM-derived) fields defined in `StoredAgentData` (`src/agents/types/storage.ts:78-146`). The categorization infrastructure exists:

- **`src/agents/categorizeAgent.ts`** — LLM-based categorization into 6 categories (principal, orchestrator, worker, reviewer, domain-expert, generalist). Accepts `AgentMetadata` and returns `AgentCategory | undefined`.
- **`src/agents/AgentStorage.ts`** — `updateInferredCategory(pubkey, category)` persists inferred category back to storage.
- **`src/agents/agent-installer.ts:243-266`** — On-install categorization: checks `!storedAgent.category`, fires `categorizeAgent()`, persists via `updateInferredCategory()`.

**Problem prior to this change:** Agents already in storage with neither `category` nor `inferredCategory` were never categorized. The `backfillAgentCategories.ts` script existed but was never wired into the runtime. Zero of 78 existing agents were categorized.

**Status:** The lazy categorization integration is **implemented**. This plan documents the completed work.

---

## Approach

Integrate lazy categorization at the agent load path, mirroring the existing on-install pattern. The integration point is `loadStoredAgentIntoRegistry()` in `src/agents/agent-loader.ts` — the authoritative function through which all registry-bound agents pass at startup and on-demand load.

**Why this function, not `createAgentInstance()`:**
- `createAgentInstance()` is a pure hydration step (storage → runtime object); injecting async side-effects there would blur its responsibility.
- `loadStoredAgentIntoRegistry()` owns the full lifecycle: load from storage, categorize if needed, add to registry. It's the natural place.

**Why non-blocking (fire-and-forget):**
- Categorization requires an LLM call (~200-500ms). Blocking the agent load path would delay startup proportionally to the number of uncategorized agents.
- The result is a cache-fill: future loads use the persisted value immediately.

**Why `loadAgentIntoRegistry()` is out of scope:**
- `loadAgentIntoRegistry()` (`agent-loader.ts:253`) loads by eventId and handles installs from Nostr. It has no callers in the codebase outside its own file — all registry loads go through `loadStoredAgentIntoRegistry()` via `AgentRegistry.ts`. New Nostr installs already categorize synchronously in `agent-installer.ts`.

---

## File Changes

### `src/agents/agent-loader.ts`
- **Action**: modify
- **What**: After `agentStorage.loadAgent(pubkey)` returns `storedAgent` and before `createAgentInstance()` is called, insert a lazy categorization block. The block checks `!storedAgent.category && !storedAgent.inferredCategory`, then fires an async IIFE (fire-and-forget with `.catch()` error handler) that calls `categorizeAgent()` and persists the result via `agentStorage.updateInferredCategory()`.
- **Why**: `categorizeAgent` was already imported at line 5. The pattern mirrors `agent-installer.ts:243-266` exactly, adapted to be non-blocking.

**Implemented block (lines 180-199):**
```typescript
if (!storedAgent.category && !storedAgent.inferredCategory) {
    void (async () => {
        const inferredCategory = await categorizeAgent({
            name: storedAgent.name,
            role: storedAgent.role,
            description: storedAgent.description,
            instructions: storedAgent.instructions,
            useCriteria: storedAgent.useCriteria,
        });
        if (!inferredCategory) return;
        const updated = await agentStorage.updateInferredCategory(pubkey, inferredCategory);
        if (updated) {
            logger.info(`[AgentLoader] Lazily categorized agent "${storedAgent.name}" as "${inferredCategory}"`);
        } else {
            logger.warn(`[AgentLoader] Failed to persist lazy categorization for "${storedAgent.name}"`);
        }
    })().catch((error) => {
        logger.warn(`[AgentLoader] Lazy categorization failed for "${storedAgent.name}"`, { error });
    });
}
```

---

## Execution Order

This feature is a single-function integration with no dependency chain.

1. **Verify `categorizeAgent` import** — already present at `agent-loader.ts:5`. No new import needed.
2. **Add lazy block to `loadStoredAgentIntoRegistry()`** — insert the non-blocking categorization check after `loadAgent()` resolves and before `createAgentInstance()` is called. ✅ Done at lines 180-199.
3. **Run TypeScript check** — `bun run typecheck` to confirm no type errors introduced.
4. **Manual smoke test** — start the daemon with at least one uncategorized agent in storage; confirm `[AgentLoader] Lazily categorized agent` log appears and the agent's JSON file gains an `inferredCategory` field.

---

## Verification

**Automated:**
```bash
bun test src/agents/__tests__/agent-loader.test.ts   # if test file exists
bun run typecheck
bun run lint
```

**Manual:**
1. Find an agent JSON under `.tenex/agents/` that has neither `category` nor `inferredCategory`.
2. Start the TENEX daemon and load a project that includes this agent.
3. Confirm the log: `[AgentLoader] Lazily categorized agent "<name>" as "<category>"`.
4. Inspect the agent JSON file — it should now have `"inferredCategory": "<category>"`.
5. Restart the daemon — the log should NOT appear again for that agent (cache is effective).

**Edge cases to verify:**
- Agent with `category` set: no categorization attempt made.
- Agent with `inferredCategory` set: no categorization attempt made.
- LLM unavailable: `categorizeAgent` returns `undefined`; agent loads successfully without a category; no crash.
- `updateInferredCategory` returns `false` (agent JSON missing): warn log emitted; agent still loads normally.

---

## Files Touched

| File | Change |
|------|--------|
| `src/agents/agent-loader.ts` | Add lazy categorization block to `loadStoredAgentIntoRegistry()` (lines 180-199) |

No other files require modification. The existing `categorizeAgent` import, `agentStorage.updateInferredCategory` method, and `logger` are already available in scope.

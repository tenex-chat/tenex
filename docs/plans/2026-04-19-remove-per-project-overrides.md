---
Title: Remove Per-Project Agent Configuration Overrides
Goal: Eliminate per-project config overrides so all kind:24020 events write to global default config. Agents get identical config across all projects.
Conversation Id: c7e55ecc41
Hashtag: #remove-per-project-overrides
---

# Remove Per-Project Agent Configuration Overrides

## Context

The TENEX agent configuration system currently supports two tiers of config:

- **Global default** (`StoredAgentData.default?: AgentDefaultConfig`) — written by kind:24020 events without an a-tag
- **Per-project overrides** (`StoredAgentData.projectOverrides?: Record<string, AgentProjectConfig>`) — written by kind:24020 events with an a-tag pointing to a project

The per-project override system adds significant complexity:
- `AgentProjectConfig` interface with delta-syntax tools (`+tool`/`-tool`)
- `resolveEffectiveConfig()` merge logic in `ConfigResolver.ts`
- `deduplicateProjectConfig()` / `computeToolsDelta()` / `applyToolsDelta()` helper functions
- 6-step PM resolution that checks `projectOverrides[dTag].isPM` and legacy `pmOverrides[dTag]`
- 832 lines of project-scoped config tests
- Runtime carries `projectOverrides` and `pmOverrides` on every `AgentInstance`

**Goal**: All kind:24020 events — whether they carry an a-tag or not — write to the agent's global `default` config. Agents behave identically across all projects.

Key source locations:
- `src/agents/types/storage.ts` — `AgentProjectConfig`, `StoredAgentData.projectOverrides`
- `src/agents/types/runtime.ts` — `AgentInstance.projectOverrides`, `AgentInstance.pmOverrides`
- `src/agents/AgentStorage.ts` — `updateProjectOverride()` (L1211), `updateProjectScopedIsPM()` (L1313), `getEffectiveConfig()` (L1099), `resolveEffectiveIsPM()` (L1294), `updateDefaultConfig()` (L1127), `sanitizeProjectOverrides()` (L64)
- `src/agents/ConfigResolver.ts` — `resolveEffectiveConfig()`, `deduplicateProjectConfig()`, `computeToolsDelta()`, `applyToolsDelta()`, and per-field resolver functions
- `src/services/agents/AgentConfigUpdateService.ts` — `applyProjectScopedUpdate()`, `applyGlobalUpdate()`
- `src/agents/agent-loader.ts` — `createAgentInstance()` (L45), copies `pmOverrides` and `projectOverrides` onto `AgentInstance`; passes `projectDTag` as `projectId` to `config.createLLMService()` for telemetry (L152)
- `src/services/projects/ProjectContext.ts` — `resolveProjectManager()` (L31), steps 2 and 3 read `projectOverrides` and `pmOverrides`
- `src/services/AgentDefinitionMonitor.ts` — upgrade method comment lists `projectOverrides` and `pmOverrides` as preserved identity fields (comment only, no code)
- `src/event-handler/index.ts` — `handleAgentConfigUpdate()` (L277–L346): extracts a-tag (L280–L300), validates it against the current project, passes `projectDTag` to `AgentConfigUpdateService.applyEvent()`, branches log messages on `updateResult.scope === "project"` (L316), emits `projectScoped` in log (L336)

---

## Approach

Route all kind:24020 event handling through `applyGlobalUpdate()` regardless of whether an a-tag is present. Remove the entire `projectOverrides` + `pmOverrides` infrastructure from storage, runtime, and resolution logic. No compatibility shim is needed for new events.

Existing on-disk JSON files that still contain `projectOverrides` or `pmOverrides` must be cleaned via a startup migration: `migrateAgentData()` strips these fields and writes directly to disk with `fs.writeFile()` — bypassing `saveAgent()` — to avoid the migration recursion hazard described below.

**A-tag semantics decision (Issue #2):** The event handler currently uses the a-tag to gate event routing — it ignores config updates for other projects (EventHandler line 292–299). This routing behavior is **preserved**: a-tags still gate acceptance so that an agent only processes config events aimed at the current project. However, storage is now always global — after passing the routing gate, the a-tag is not forwarded to `AgentConfigUpdateService` and storage always writes to `default`. The `projectDTag` parameter is stripped from `applyEvent()`.

**Reset semantics decision (Issue #3):** A `["reset"]` tag in a global update clears the entire `default` config block (sets it to `undefined`) and clears the global `isPM` flag. A-tags do not change this behavior — after the routing gate passes, `["reset"]` on any config event (with or without a-tag) resets the global `default` and `isPM`. A dedicated `resetDefaultConfig()` method on `AgentStorage` handles this, keeping the reset path explicit and separately testable.

**Why not keep the interface but ignore it at runtime?** Dead fields in storage and dead branches in code create confusion and test debt. Full removal is cleaner.

**Why not a feature flag?** The task explicitly states no backward compatibility.

---

## File Changes

### `src/agents/types/storage.ts`
- **Action**: modify
- **What**:
  - Delete the `AgentProjectConfig` interface entirely (the entire interface block with its JSDoc)
  - Remove `projectOverrides?: Record<string, AgentProjectConfig>` field and its JSDoc from `StoredAgentData`
  - Update the JSDoc on `AgentDefaultConfig` to remove the phrase "global fallback when no project-specific override exists"
- **Why**: The type no longer exists. Removing it makes the schema self-documenting.

### `src/agents/types/runtime.ts`
- **Action**: modify
- **What**:
  - Remove `import type { AgentProjectConfig } from "./storage"` (line 9)
  - Remove `pmOverrides?: Record<string, boolean>` field and its JSDoc from `AgentInstance`
  - Remove `projectOverrides?: Record<string, AgentProjectConfig>` field and its JSDoc from `AgentInstance`
- **Why**: Runtime no longer needs to carry per-project data; PM is resolved purely from the global `isPM` flag.

### `src/agents/ConfigResolver.ts`
- **Action**: delete the module entirely
- **What**:
  - After removing all project-override functions and delta helpers, only `arraysEqual()` and `arraysEqualUnordered()` remain. Neither has any production caller outside this file (confirmed by grep: only `ConfigResolver.ts` itself and `ConfigResolver.test.ts` reference them). Move `arraysEqual` and `arraysEqualUnordered` to `src/lib/arrays.ts` (create if not exists) and delete `ConfigResolver.ts` entirely.
  - Remove `AgentProjectConfig` from the re-export in the barrel index if present
  - Update `AgentStorage.ts` import that currently does `import { resolveEffectiveConfig, deduplicateProjectConfig, type ResolvedAgentConfig } from "@/agents/ConfigResolver"` — remove the import entirely once `getEffectiveConfig` is deleted
- **Why**: Every function in the module exists solely to support the project-override merge path. The only survivors (`arraysEqual`/`arraysEqualUnordered`) have no production callers and belong in a generic utility module.

### `src/agents/AgentStorage.ts`
- **Action**: modify
- **What**:
  - Remove `import { resolveEffectiveConfig, deduplicateProjectConfig, type ResolvedAgentConfig }` from the ConfigResolver import (L12–L15) — the entire import line goes away once `getEffectiveConfig` is deleted
  - Delete `sanitizeProjectOverrides()` function (L64–L86) and remove its call-sites from `normalizeLoadedAgent()` (L98) and `sanitizeStoredAgentForPersistence()` (L107)
  - Remove `projectOverrides` field references from both `normalizeLoadedAgent()` and `sanitizeStoredAgentForPersistence()`
  - Delete the `clearProjectOverrides?: boolean` option from `UpdateDefaultConfigOptions` (L26–L27) and its implementation block in `updateDefaultConfig()` (L1184–L1186)
  - Delete `getEffectiveConfig()` method (L1099–L1113) entirely; callers use direct reads from `storedAgent.default` instead
  - Delete `updateProjectOverride()` method (L1211–~L1260)
  - Delete `resolveEffectiveIsPM()` method (L1294–~L1310)
  - Delete `updateProjectScopedIsPM()` method (L1313–~L1345)
  - Keep `updateAgentIsPM()` (L1049) — still needed for global PM flag
  - Remove `pmOverrides` from `StoredAgent` type shape (L133, L190) and from all serialization/normalization helpers
  - Add `resetDefaultConfig(pubkey: string): Promise<boolean>` — loads agent, sets `agent.default = undefined` and `agent.isPM = undefined`, saves via `saveAgent()`, returns true on success. Used by `applyGlobalUpdate()` when `hasResetTag` is true.
  - Add `migrateAgentData(agent: StoredAgentData): boolean` — accepts the parsed JSON object typed with a local migration type (see Minor Issue #9 below), deletes `projectOverrides` and `pmOverrides` if present, returns `true` if the object was mutated.

  **Migration persistence (fixes Issue #1 — recursion hazard):**
  Inside `loadAgent()` (L515–L530), after `normalizeLoadedAgent(agent)`:
  ```
  const migrated = migrateAgentData(agent);
  if (migrated) {
      // Write directly to disk — do NOT call saveAgent() to avoid recursion
      // (saveAgent → loadAgent → migrateAgentData → saveAgent...)
      await fs.writeFile(filePath, JSON.stringify(agent, null, 2));
  }
  ```
  Use raw `fs.writeFile()` here because migration only strips unknown fields that do not affect indexes (bySlug, byEventId, byProject remain valid). The agent returned to the caller is already correct; the write is purely a cleanup of stale disk state.

  **`migrateAgentData` type safety (Minor Issue #9):**
  Add a local migration type before the function:
  ```ts
  type LegacyStoredAgent = StoredAgent & {
      projectOverrides?: unknown;
      pmOverrides?: unknown;
  };
  ```
  Cast the input inside `migrateAgentData` to `LegacyStoredAgent` so field access compiles without `any`.

- **Why**: All per-project write/read/merge logic is removed. The raw-write migration avoids the `saveAgent → loadAgent → saveAgent` recursion that would occur if migration called `saveAgent()`.

### `src/services/agents/AgentConfigUpdateService.ts`
- **Action**: modify
- **What**:
  - Remove `import { computeToolsDelta }` — no longer used
  - Remove `import type { AgentProjectConfig }` — type deleted
  - Delete `applyProjectScopedUpdate()` private method entirely (~120 lines)
  - In `applyEvent()`: remove the `if (projectDTag !== undefined)` branch entirely; always call `applyGlobalUpdate()` regardless of the event's a-tag. Remove `options` parameter from `applyEvent()` signature (the `projectDTag` option is no longer needed here — a-tag routing stays in `EventHandler`, not here).
  - In `applyGlobalUpdate()`: handle `hasResetTag` explicitly — when true, call `agentStorage.resetDefaultConfig(params.agentPubkey)` and return early with `configUpdated: true, pmUpdated: true`. Remove the existing `{ clearProjectOverrides: true }` option from the `updateDefaultConfig()` call (the option is being deleted).
  - Remove `projectDTag` from `ApplyAgentConfigUpdateResult` interface
  - Simplify `scope` field: it is now always `"global"`; remove `"project"` from the union type — or remove `scope` entirely if `EventHandler` log cleanup (Issue #6) no longer reads it
- **Why**: There is only one handling path now — global update.

### `src/event-handler/index.ts`
- **Action**: modify
- **What** (fixes Issue #2 and Issue #6):
  - **Keep** the a-tag extraction and project-validation block (L280–L300) — this routing gate is preserved. Events for other projects are still silently ignored.
  - **Remove** the `{ projectDTag }` argument from `this.agentConfigUpdateService.applyEvent(event, { projectDTag })` (L312) — call it as `this.agentConfigUpdateService.applyEvent(event)` instead. The a-tag has already served its routing purpose; storage no longer needs it.
  - Replace the `updateResult.scope === "project"` branch in the log message (L315–L318) with a single unconditional log line: `"Processing agent config update"`.
  - Remove `projectScoped: projectDTag !== undefined` from the second `logger.info` call (L336).
  - Remove any other references to `updateResult.scope` that branch on `"project"`.
- **Why**: Storage is now always global; the log branches referencing "project" scope are stale.

### `src/agents/agent-loader.ts`
- **Action**: modify
- **What**:
  - Remove `projectDTag` from `createAgentInstance()` **config-resolution usage**: delete `const resolvedConfig = agentStorage.getEffectiveConfig(storedAgent, projectDTag)` (L54); replace with direct reads: `const effectiveLLMConfig = storedAgent.default?.model`, `const effectiveTools = storedAgent.default?.tools`, `const effectiveAlwaysSkills = storedAgent.default?.skills`, `const effectiveBlockedSkills = storedAgent.default?.blockedSkills`, `const effectiveMcpAccess = storedAgent.default?.mcpAccess`
  - Remove `pmOverrides: storedAgent.pmOverrides` from the `AgentInstance` object literal (L108)
  - Remove `projectOverrides: storedAgent.projectOverrides` from the `AgentInstance` object literal (L110)
  - **Preserve `projectDTag` for telemetry (fixes Issue #5):** The parameter `projectDTag?: string` stays on `createAgentInstance()` signature. It is still passed as `projectId: projectDTag` to `config.createLLMService()` at L152 for LLM telemetry hooks. It is simply no longer used for config resolution. Remove only the comment "Resolve effective configuration: projectOverrides[dTag] ?? default" (L53) and the `getEffectiveConfig` call.
  - Update all callers of `createAgentInstance()` throughout the codebase — they continue passing `projectDTag` unchanged (no call-site changes needed since the parameter is kept).
- **Why**: No merge step needed for config; agent config comes directly from `default`. Telemetry still benefits from knowing which project launched the agent.

### `src/services/projects/ProjectContext.ts`
- **Action**: modify
- **What**:
  - Delete Step 2 block in `resolveProjectManager()` (L62–L75): the `if (projectDTag)` loop that checks `agent.projectOverrides?.[projectDTag]?.isPM === true`
  - Delete Step 3 block (L75–L88): the `if (projectDTag)` loop that checks `agent.pmOverrides?.[projectDTag] === true`
  - Check if `projectDTag` parameter is still needed for steps 4/5/6 — step 4 uses `project.tags` (no dTag needed), step 5 is also tag-based, step 6 is a fallback. If `projectDTag` is truly unused after removing steps 2/3, remove it from the function signature and update call-sites (L258, L591)
  - Update the JSDoc to renumber steps (steps 4→2, 5→3, 6→4) and remove references to deleted steps
- **Why**: PM is now purely global (`isPM`) or derived from project event tags (remaining steps).

### `src/agents/agent-installer.ts`
- **Action**: modify (comment only, fixes Issue #7)
- **What**:
  - Update the comment at L161–L162: `"// This preserves user configuration (llmConfig, pmOverrides, etc.)"` → `"// This preserves user configuration (llmConfig, etc.)"`
- **Why**: `pmOverrides` no longer exists; the comment must not reference deleted fields.

### `src/services/AgentDefinitionMonitor.ts`
- **Action**: modify (comment only)
- **What**:
  - Update the JSDoc block (L58–L70) "Identity Preservation" section to remove `pmOverrides` (L66) and `projectOverrides` (L68) from the list of preserved fields
- **Why**: Comment accuracy. The upgrade method body already never touches these fields in code.

---

## Execution Order

Execute steps in this order to keep TypeScript compilation a usable guide throughout. After removing types in step 1, `tsc` errors point exactly to all the code sites that need updating.

1. **Remove types** (`storage.ts`, `runtime.ts`)
   - Delete `AgentProjectConfig` interface
   - Remove `projectOverrides` from `StoredAgentData`
   - Remove `pmOverrides` and `projectOverrides` from `AgentInstance`
   - Run `bun run typecheck` — errors now enumerate all remaining sites to fix

2. **Delete ConfigResolver.ts; create `src/lib/arrays.ts`**
   - Move `arraysEqual` and `arraysEqualUnordered` to `src/lib/arrays.ts`
   - Delete `ConfigResolver.ts`
   - Update the single test import in `ConfigResolver.test.ts` (rename to `arrays.test.ts` or update import path)

3. **Update AgentStorage.ts**
   - Add local `LegacyStoredAgent` migration type
   - Add `migrateAgentData()` function
   - Add `resetDefaultConfig()` method
   - Delete `sanitizeProjectOverrides`, `updateProjectOverride`, `resolveEffectiveIsPM`, `updateProjectScopedIsPM`, `getEffectiveConfig`
   - Remove `clearProjectOverrides` option from `updateDefaultConfig`
   - Strip `pmOverrides` from `StoredAgent` serialization/normalization
   - Add raw-`fs.writeFile` migration call in `loadAgent()` body

4. **Update AgentConfigUpdateService.ts**
   - Delete `applyProjectScopedUpdate`
   - Remove `options` param from `applyEvent`; always call `applyGlobalUpdate`
   - Handle `hasResetTag` in `applyGlobalUpdate` via `resetDefaultConfig()`
   - Remove `computeToolsDelta` import, `AgentProjectConfig` import
   - Simplify `ApplyAgentConfigUpdateResult` (remove `scope: "project"`, remove `projectDTag`)

5. **Update EventHandler (`src/event-handler/index.ts`)**
   - Keep a-tag routing gate intact
   - Drop `{ projectDTag }` from `applyEvent()` call
   - Remove `updateResult.scope === "project"` log branch
   - Remove `projectScoped` log field

6. **Update agent-loader.ts**
   - Delete `getEffectiveConfig` call; replace with direct `storedAgent.default?.*` reads
   - Remove `pmOverrides`/`projectOverrides` fields from `AgentInstance` construction
   - Keep `projectDTag` parameter; keep its use in `createLLMService` for telemetry
   - Delete stale comment about "projectOverrides[dTag] ?? default"

7. **Update ProjectContext.ts**
   - Remove steps 2 and 3 from `resolveProjectManager`
   - Drop `projectDTag` parameter if unused; update call-sites

8. **Update comments** (`AgentDefinitionMonitor.ts`, `agent-installer.ts`)

9. **Delete and rewrite tests**
   - Delete `src/event-handler/__tests__/project-scoped-config.test.ts` entirely (all 832 lines are project-scoped scenarios with no salvageable global tests)
   - `src/agents/__tests__/AgentStorage.test.ts` (2248 lines): delete all `projectOverrides` / `updateProjectOverride` / `updateProjectScopedIsPM` / `resolveEffectiveIsPM` test cases; retain and verify global config and global `isPM` tests; add tests for:
     - `migrateAgentData()` stripping `projectOverrides` and `pmOverrides` from a legacy object
     - `resetDefaultConfig()` clearing `default` and `isPM`
   - `src/agents/__tests__/ConfigResolver.test.ts` (452 lines): rename to `src/lib/__tests__/arrays.test.ts`; delete all `resolveEffectiveConfig`, `deduplicateProjectConfig`, `computeToolsDelta`, `applyToolsDelta` tests; retain `arraysEqual`/`arraysEqualUnordered` tests with updated import path
   - `src/services/agents/__tests__/AgentConfigUpdateService.test.ts` (168 lines): delete all 13 project-scoped test cases; retain global update tests; add:
     - A test that an event with an a-tag is now treated as global (calls `applyGlobalUpdate`, writes to `default`)
     - A test that `["reset"]` clears `default` config and `isPM`
   - `src/services/projects/__tests__/ProjectContext.test.ts` (715 lines): delete PM resolution tests for steps 2 and 3; retain global `isPM` test (step 1), project tag tests (steps 4–6)
   - `src/agents/__tests__/agent-installer.test.ts` (lines 104–124): delete the `"should preserve pmOverrides when agent already exists"` test entirely — `pmOverrides` no longer exists
   - `src/event-handler/__tests__/pm-designation.test.ts` (199 lines): remove stubs for `updateProjectOverride` (L66) and `updateProjectScopedIsPM` (L67) — those methods are deleted; retain stubs for `updateDefaultConfig` and `updateAgentIsPM`

10. **Final lint and type-check**

---

## Verification

```bash
# TypeScript must be completely clean
bun run typecheck

# All tests must pass
bun test

# No references to deleted constructs should remain in source
grep -r "projectOverrides\|AgentProjectConfig\|pmOverrides\|updateProjectOverride\|updateProjectScopedIsPM\|resolveEffectiveIsPM\|applyProjectScopedUpdate\|applyToolsDelta\|computeToolsDelta\|deduplicateProjectConfig\|clearProjectOverrides\|project-scoped config\|project-scoped PM\|projectScoped\|scope.*project" src/

# Lint clean
bun run lint

# Architecture layer check
bun run lint:architecture
```

Manual edge cases to verify after implementation:
- An existing agent JSON on disk that still contains `projectOverrides` or `pmOverrides` is loaded, silently migrated via raw `fs.writeFile`, and re-saved without those fields — and the agent operates correctly on the `default` config
- `loadAgent()` called from `saveAgent()` does not trigger infinite recursion when migration writes directly via `fs.writeFile`
- A kind:24020 event that carries an a-tag matching the current project now writes to `default` (trace through `applyEvent` → always `applyGlobalUpdate`)
- A kind:24020 event that carries an a-tag for a *different* project is still silently ignored by `EventHandler` (routing gate preserved)
- A `["reset"]` tag with or without an a-tag clears the global `default` config block and `isPM`
- PM resolution still works via global `isPM` flag (step 1) and via project event tags (steps 2–4 after renumbering); no regression in `resolveProjectManager`
- `AgentDefinitionMonitor` upgrade correctly writes `default.tools` and `default.skills` without referencing removed fields
- LLM telemetry still receives `projectId` from the `projectDTag` passed to `createAgentInstance()`

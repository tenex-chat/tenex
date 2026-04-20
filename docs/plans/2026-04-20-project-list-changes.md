# Project List Tool Changes

## Context

`src/tools/implementations/project_list.ts` is the sole implementation of the `project_list` tool. It is exposed to agents via the built-in skill at `src/skills/built-in/project-list/tools/project-list.ts`, which simply re-exports `createProjectListTool`. The tool is referenced in `src/tools/types.ts` (as a `ToolName`) and is consumed heavily by `delegate_crossproject.ts` (which uses its agent data to resolve delegation targets).

Three changes are needed:

1. **Simplify agent format** — currently each agent in a project's `agents` array is `{ slug, pubkey, role, isPM? }`. The pubkey is noisy; isPM should be folded into the slug key. Change to `Record<string, string>` where key is the slug (or `"slug (PM)"` for PM agents) and value is the role.

2. **Add fuzzy search parameter** — currently the tool returns ALL projects. Add an optional `search` string parameter that filters projects via case-insensitive substring matching across `id`, `title`, `description`, and `repository` fields.

3. **Exempt project_list from output truncation** — `src/agents/execution/ToolOutputTruncation.ts` has a `TRUNCATION_EXEMPT_TOOLS` set. `project_list` is not in it. For a deployment with many projects, the JSON output can exceed the 10,000-char threshold and get truncated with a placeholder, making the result unrecoverable (no pagination). It must be added to the exempt set.

No other files reference the internal `ProjectAgent`, `ProjectInfo`, or `ProjectListOutput` types — they are file-scoped (not exported). The skill wrapper at `src/skills/built-in/project-list/tools/project-list.ts` only calls `createProjectListTool(context)` and does not inspect the output shape, so it needs no changes.

## Approach

### Change 1: Agent format

Replace the `ProjectAgent` type with a simple `Record<string, string>` (key = display slug, value = role). The PM indicator is embedded in the key by appending `" (PM)"` to the slug rather than a separate boolean field.

Introduce a semantic helper so the three agent-building loops are consistent and not raw Record writes:

```ts
type AgentRoleMap = Record<string, string>;

function formatAgentKey(slug: string, isPM = false): string {
    return isPM ? `${slug} (PM)` : slug;
}

function addAgentRole(agents: AgentRoleMap, slug: string, role: string, isPM = false): void {
    agents[formatAgentKey(slug, isPM)] = role;
}
```

Initialize agent maps with null prototype to avoid prototype-chain collisions for unexpected slug values:

```ts
const agents = Object.create(null) as Record<string, string>;
```

**Why this approach:** It produces a compact, human-readable JSON object that is immediately interpretable (e.g., `{ "architect (PM)": "orchestrator", "claude-code": "worker" }`). It reduces token weight vs. the current object-per-agent format. The semantic helpers prevent subtle inconsistencies across the three loops.

**Alternative considered:** Keep the object array but drop `pubkey`. Rejected because the task explicitly asks for key-value format, and the flat `Record` is more compact.

### Change 2: Search

Normalize input once before filtering:

```ts
const normalizedSearch = search?.trim().toLowerCase();
```

Extract a named helper for readability:

```ts
function matchesProjectSearch(project: ProjectInfo, query: string): boolean {
    return [
        project.id,
        project.title,
        project.description,
        project.repository,
    ].some((value) => (value ?? "").toLowerCase().includes(query));
}
```

Apply it after collecting all projects, computing the returned set before summary counts:

```ts
const returnedProjects = normalizedSearch
    ? projects.filter((project) => matchesProjectSearch(project, normalizedSearch))
    : projects;

const totalAgents = returnedProjects.reduce(
    (sum, project) => sum + Object.keys(project.agents).length,
    0
);

const runningCount = returnedProjects.filter((p) => p.isRunning).length;
```

All summary values (`totalProjects`, `runningProjects`, `totalAgents`) are derived from `returnedProjects`, not from the full unfiltered `projects` array. If there is a collection-time `totalAgents` accumulator variable, it must be removed (or kept only for unfiltered logging purposes).

**Why:** Normalizing once avoids repeated `?.trim().toLowerCase()` calls at the call site. The named helper makes the four-field OR readable and testable. Deriving all summary counts from `returnedProjects` ensures they accurately reflect what was returned, not what was collected.

**Note on empty/whitespace search:** `search?.trim()` returns `""` for whitespace-only input; `normalizedSearch` will be `""`. Since `"".toLowerCase() === ""` and `any_string.includes("")` is always `true`, all projects match — correct behavior (empty search = no filter).

### Change 3: Truncation exemption

Add `"project_list"` to `TRUNCATION_EXEMPT_TOOLS` in `ToolOutputTruncation.ts`. The rationale exactly mirrors `conversation_get`: the tool has no pagination, so a truncated result is unrecoverable.

### Change 4: PM suffix disambiguation

Update the `project_list` tool description and/or the `delegate_crossproject` tool's `agentSlug` parameter description to make clear that the `" (PM)"` suffix is display-only:

> Agent keys ending with " (PM)" indicate the project manager; use the slug without the suffix when calling `delegate_crossproject`.

## File Changes

### `src/tools/implementations/project_list.ts`

- **Action**: modify
- **What**:
  1. Remove the `ProjectAgent` type. Update `ProjectInfo.agents` from `ProjectAgent[]` to `Record<string, string>` (slug → role map).
  2. Add helper types and functions (file-scoped, not exported):
     ```ts
     type AgentRoleMap = Record<string, string>;

     function formatAgentKey(slug: string, isPM = false): string {
         return isPM ? `${slug} (PM)` : slug;
     }

     function addAgentRole(agents: AgentRoleMap, slug: string, role: string, isPM = false): void {
         agents[formatAgentKey(slug, isPM)] = role;
     }

     function matchesProjectSearch(project: ProjectInfo, query: string): boolean {
         return [
             project.id,
             project.title,
             project.description,
             project.repository,
         ].some((value) => (value ?? "").toLowerCase().includes(query));
     }
     ```
  3. Add a Zod-inferred input type and update `projectListSchema`:
     ```ts
     const projectListSchema = z.object({
         search: z
             .string()
             .optional()
             .describe(
                 "Optional fuzzy search string. When provided, only projects whose id, title, description, or repository contain this string (case-insensitive) are returned."
             ),
     });

     type ProjectListInput = z.infer<typeof projectListSchema>;
     ```
  4. Update `executeProjectList` signature to accept `ProjectListInput` and destructure `{ search }`.
  5. Refactor the three agent-building loops (running projects via `agentMap`, non-running Nostr projects via `storedAgents`, offline storage projects via `storedAgents`). In each, initialize the agent map with null prototype and use `addAgentRole`:
     ```ts
     const agents = Object.create(null) as Record<string, string>;
     // then:
     addAgentRole(agents, agent.slug, agent.role, isPM);
     ```
     Remove the `NDKPrivateKeySigner` + `signer.user()` calls that currently exist solely to resolve a pubkey for display — pubkey is no longer in the output, so that async step is eliminated for the non-running agent branches. (The running-project branch reads `agent.pubkey` from `agentMap` only for the `isPM` comparison, which still works fine without the display pubkey.)
  6. After collecting all projects, normalize the search query and apply the filter before computing summary counts:
     ```ts
     const normalizedSearch = search?.trim().toLowerCase();

     const returnedProjects = normalizedSearch
         ? projects.filter((project) => matchesProjectSearch(project, normalizedSearch))
         : projects;

     const totalAgents = returnedProjects.reduce(
         (sum, project) => sum + Object.keys(project.agents).length,
         0
     );

     const runningCount = returnedProjects.filter((p) => p.isRunning).length;
     ```
     Remove any collection-time `totalAgents` accumulator that was previously populated during the project collection loop (unless it is kept solely for unfiltered logging).
  7. Update the return value to use `returnedProjects` for the `projects` array and the derived summary counts.
  8. Update logging to distinguish collected vs. returned projects:
     ```ts
     collectedProjects: projects.length,
     returnedProjects: returnedProjects.length,
     search: normalizedSearch,
     ```
  9. Update `createProjectListTool` to:
     - Update the tool description to mention search: `"List known projects with their agents and running status. Optionally filter by search text."`
     - Note in the description that agent keys ending with `" (PM)"` indicate the project manager, and to use the slug without the suffix when calling `delegate_crossproject`.
     - Pass input to `executeProjectList`:
       ```ts
       execute: async (input) => {
           return await executeProjectList(context, input);
       }
       ```
  10. Remove the now-unused `shortenPubkey` import (used only for pubkey display).
  11. Remove the now-unused `NDKPrivateKeySigner` import.
- **Why**: Implements all changes in the single file that owns the logic. The semantic helpers (`addAgentRole`, `matchesProjectSearch`) ensure consistent behavior across all three agent-building loops and make the code testable in isolation.

### `src/agents/execution/ToolOutputTruncation.ts`

- **Action**: modify
- **What**: Add `"project_list"` to `TRUNCATION_EXEMPT_TOOLS`:
  ```ts
  const TRUNCATION_EXEMPT_TOOLS = new Set([
      // ai-sdk-fs-tools (own truncation)
      "fs_read",
      "fs_glob",
      "fs_grep",
      // Conversation retrieval
      "conversation_get",
      "conversation_list",
      // Project listing (no pagination — truncated result is unrecoverable)
      "project_list",
      // RAG tools
      ...,
  ]);
  ```
- **Why**: `project_list` has no pagination. If truncated, the agent sees a placeholder with no way to retrieve the rest. Same rationale already documented in the existing `conversation_get` exemption comment.

### `src/tools/implementations/__tests__/project_list.test.ts`

- **Action**: modify
- **What**:
  1. Update existing tests (`"prefers canonical repo/content project metadata"` and `"falls back to legacy..."`) — verify they still pass after the type change and pubkey-resolution simplification. Fix any mock shapes that depended on `NDKPrivateKeySigner` or `nsec` handling in non-running branches.
  2. Add new tests:
     - **Agent format — running project with PM**: mock an `agentMap` with two agents (one whose pubkey matches `pmPubkey`), verify the output `agents` object has `"slug (PM)": "role"` for the PM and `"slug": "role"` for the non-PM.
     - **Agent format — non-running stored project**: mock `getProjectAgents` returning agents (no PM concept), verify flat `Record<string, string>` output.
     - **Agent format — offline storage-only project (non-running, second non-running branch)**: verify agents from the storage-only path also produce `Record<string, string>` output correctly.
     - **Search — match by id**: pass `search: "tenex"`, verify only matching projects returned.
     - **Search — match by title**: pass `search: "canonical"`, verify filter works on `title`.
     - **Search — match by description**: verify filter works on `description`.
     - **Search — match by repository**: pass a repository substring, verify filter works on `repository`.
     - **Search — no match**: pass `search: "zzznomatch"`, verify empty `projects` array and `summary.totalProjects === 0`.
     - **Search — case-insensitive**: pass `search: "CANONICAL"`, verify match on lowercase stored title.
     - **Search — empty string / undefined**: verify all projects returned (no filtering).
     - **Search — whitespace only**: pass `search: "   "`, verify all projects returned (whitespace trims to empty → no filter).
     - **Filtered summary counts**: with two projects (one running, one not), filter to return only one; verify `summary.totalProjects === 1`, `summary.runningProjects` and `summary.totalAgents` reflect only the returned project, not both.
     - **Removal of `NDKPrivateKeySigner` behavior**: pass an agent with an invalid or missing `nsec`; verify the call still succeeds and returns agents correctly (no async signer calls).
  3. Add a truncation-exemption assertion to `src/agents/execution/__tests__/ToolOutputTruncation.test.ts` confirming `project_list` is in the exempt set.
- **Why**: Tests document and protect new behavior. Coverage of whitespace search, filtered summary counts, offline branch, and `NDKPrivateKeySigner` removal closes gaps identified in the review.

## Execution Order

1. **Modify `ToolOutputTruncation.ts`** — add `"project_list"` to `TRUNCATION_EXEMPT_TOOLS`. Verify: `grep -n "project_list" src/agents/execution/ToolOutputTruncation.ts` should show the entry.

2. **Modify `project_list.ts`** — apply all changes described above in one edit:
   - Remove `ProjectAgent` type
   - Change `ProjectInfo.agents` to `Record<string, string>`
   - Add `AgentRoleMap` type alias, `formatAgentKey`, `addAgentRole`, and `matchesProjectSearch` helpers
   - Add `ProjectListInput` Zod-inferred type; add `search` to `projectListSchema`
   - Update `executeProjectList` to accept `ProjectListInput`
   - Refactor all three agent-building loops: null-prototype init, use `addAgentRole`
   - Eliminate `NDKPrivateKeySigner` + `signer.user()` calls in non-running branches
   - Add post-collection `normalizedSearch` + `returnedProjects` filter
   - Derive `totalAgents` and `runningCount` from `returnedProjects`
   - Remove collection-time `totalAgents` accumulator if present
   - Update logging with `collectedProjects`, `returnedProjects`, `search`
   - Update tool description (mention search + PM suffix note)
   - Update `createProjectListTool` `execute` to pass `input`
   - Remove unused `shortenPubkey` import
   - Remove unused `NDKPrivateKeySigner` import
   - Verify: `bun run typecheck` passes with no errors in `project_list.ts`

3. **Verify cleanup** — confirm dead imports are gone:
   ```bash
   grep -n "NDKPrivateKeySigner\|shortenPubkey" src/tools/implementations/project_list.ts
   ```
   Should return no matches.

4. **Run tests** — update and run the project_list test suite:
   ```bash
   bun test src/tools/implementations/__tests__/project_list.test.ts
   ```
   All tests should pass.

5. **Verify truncation exemption** — confirm the exemption was added:
   ```bash
   grep -n "project_list" src/agents/execution/ToolOutputTruncation.ts
   ```

6. **Typecheck** — full typecheck:
   ```bash
   bun run typecheck
   ```

## Rollback Plan

If issues arise:

1. **Revert `project_list.ts`** — restore from git: `git checkout HEAD -- src/tools/implementations/project_list.ts`
2. **Revert `ToolOutputTruncation.ts`** — restore: `git checkout HEAD -- src/agents/execution/ToolOutputTruncation.ts`
3. **Revert tests** — restore: `git checkout HEAD -- src/tools/implementations/__tests__/project_list.test.ts`
4. Re-run typecheck and tests to confirm clean state.

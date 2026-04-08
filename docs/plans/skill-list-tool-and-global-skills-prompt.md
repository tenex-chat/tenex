# Implement `skill_list` Tool and Modify Global Skills System Prompt

## Context

Agents currently have no programmatic way to enumerate all available skills. The `<available-skills>` system reminder shows full details for every scope, but listing is passive (injected into context) and not agent-initiated.

The `<global-skills>` section currently emits one line per shared skill with truncated descriptions. With many global skills, this bloats every agent's context. The goal is to collapse global skills to a count + discovery hint, and provide a `skill_list` tool for on-demand full enumeration.

Relevant files:
- `src/tools/types.ts` — `ToolName` union (line 18–61), `AISdkTool` type (line 66–78)
- `src/tools/registry.ts` — `toolFactories` map (lines 71–105), imports (lines 29–50)
- `src/tools/implementations/skills_set.ts` — reference implementation (238 lines)
- `src/agents/execution/skill-reminder-renderers.ts` — `renderAvailableSkillsBlock()` (lines 185–308), `<global-skills>` block at lines 282–292
- `src/services/skill/types.ts` — `SkillStoreScope` type (line 61)
- `src/services/skill/SkillService.ts` — `listAvailableSkills()` with 5-second TTL cache (lines 931–983)

## Approach

**`skill_list` tool**: A read-only tool (no `ConversationToolContext` needed — `SkillLookupContext` can be derived directly from the agent field in `ToolExecutionContext`) that calls `SkillService.getInstance().listAvailableSkills()` and returns skills grouped by scope with per-scope counts and a total. It respects blocked skills by checking against `buildExpandedBlockedSet()`, consistent with how `renderAvailableSkillsBlock()` works. Since `listAvailableSkills()` uses a 5-second TTL cache with file-signature invalidation, it's safe to call from a tool.

**System prompt modification**: Change only the `<global-skills>` section in `renderAvailableSkillsBlock()` (lines 282–292 of `skill-reminder-renderers.ts`). Instead of listing each skill item, emit a count line: `"N global skills available — use \`skill_list\` to see them all"`. All other sections (`<your-skills>`, `<project-skills>`, `<built-in>`) remain unchanged, as they are scoped to the agent's own context and tend to be small.

**Why not collapse built-in or project skills too?** Built-in skills are static and few (~12), so context cost is low. Agent/project skills are directly relevant to the current context and should remain fully visible. Only the shared/global pool grows unboundedly and benefits from summarization.

**Alternatives considered:**
- Show global skill details as before but truncate more aggressively — rejected because truncation still scales with count.
- Collapse all scopes — rejected because agent/project skills are directly actionable and agents shouldn't have to call a tool to see their own skills.
- Add `blockedSkills` param to `skill_list` — not needed as a param; the tool derives blocked skills from the conversation context the same way `renderAvailableSkillsBlock` does.

## File Changes

### `src/tools/types.ts`
- **Action**: modify
- **What**: Add `"skill_list"` to the `ToolName` union at line 61, after `"skills_set"` and before `"send_message"` (alphabetical order places it between `skills_set` and `send_message`)
- **Why**: `ToolName` is the source of truth for the live tool surface; every new tool must be registered here

### `src/tools/implementations/skill_list.ts`
- **Action**: create
- **What**: New tool factory `createSkillListTool(context: ToolExecutionContext): AISdkTool`. Input schema: empty Zod object `z.object({})`. Execute:
  1. Extract `agentPubkey` from `context.agent.pubkey` and `projectPath` from project context via `getProjectContext()?.projectPath` (same pattern as `skills_set.ts` line 8)
  2. Call `SkillService.getInstance().listAvailableSkills({ agentPubkey, projectPath })`
  3. Build `blockedSet` via `buildExpandedBlockedSet()` from `context.agent.blockedSkills` — if `blockedSkills` is not directly on `AgentInstance`, derive it from `agentStorage.getAgentConfig(agentPubkey)` (same approach used in `renderAvailableSkillsBlock`)
  4. Filter out blocked skills
  5. Group by scope using the same `classifyScope()` logic from `skill-reminder-renderers.ts` (inline the switch or import from a shared location)
  6. Return structured object:
     ```typescript
     {
       total: number,
       scopes: {
         yourProject: SkillSummary[],   // agent-project
         yourAll: SkillSummary[],        // agent
         project: SkillSummary[],        // project
         global: SkillSummary[],         // shared
         builtIn: SkillSummary[],        // built-in
       },
       counts: {
         yourProject: number,
         yourAll: number,
         project: number,
         global: number,
         builtIn: number,
         total: number,
       }
     }
     ```
  Where `SkillSummary` is:
  ```typescript
  { identifier: string; name?: string; description?: string; scope: SkillStoreScope; eventId?: string }
  ```
  The `description` field should be truncated to 150 characters (matching `MAX_DESCRIPTION_LENGTH` in `skill-reminder-renderers.ts` line 148) if it comes from `skill.description ?? skill.content`.
- **Why**: Gives agents a machine-readable enumeration of all available skills on demand, without bloating the system prompt

### `src/tools/registry.ts`
- **Action**: modify
- **What**:
  1. Add import at line ~41 (after the existing skills tools comment block): `import { createSkillListTool } from "./implementations/skill_list";`
  2. Add entry to `toolFactories` map at line ~91 (after `skills_set`): `skill_list: createSkillListTool,`
  3. Do NOT add to `CONVERSATION_REQUIRED_TOOLS` — `skill_list` is read-only and does not need conversation store access
- **Why**: Registry is the canonical source of tool instantiation

### `src/agents/execution/skill-reminder-renderers.ts`
- **Action**: modify
- **What**: Replace the `<global-skills>` block body (lines 282–292) with a count-only rendering:
  ```typescript
  // Global/shared skills — show count only; agent can call skill_list for full details
  parts.push("<global-skills>");
  const sharedSkills = grouped.get("shared") ?? [];
  const unhydratedCount = unhydratedWhitelisted.length;
  const totalGlobal = sharedSkills.length; // unhydrated items already merged into "shared" group above
  if (totalGlobal > 0) {
      parts.push(`${totalGlobal} global skill${totalGlobal === 1 ? "" : "s"} available — use \`skill_list\` to see them all`);
  } else {
      parts.push("(none)");
  }
  parts.push("</global-skills>");
  ```
  Note: The unhydrated whitelisted items are already added into `grouped.get("shared")` at lines 233–243 before this block runs, so `sharedSkills.length` already includes them. No double-counting issue.
- **Why**: Reduces context window usage proportional to the number of global skills, while preserving discoverability via the count hint

## Execution Order

1. **Add `"skill_list"` to `ToolName` union** in `src/tools/types.ts` — add after `"skills_set"` on line 60. Verify: `bun run typecheck` should still pass (no references yet).

2. **Create `src/tools/implementations/skill_list.ts`** — implement factory function following the pattern in `skills_set.ts`. Key imports needed:
   - `z` from `"zod"`
   - `tool` from `"ai"`
   - `AISdkTool`, `ToolExecutionContext` from `"@/tools/types"`
   - `SkillService` from `"@/services/skill/SkillService"`
   - `getProjectContext` from `"@/services/projects"`
   - `buildExpandedBlockedSet`, `buildSkillAliasMap`, `isSkillBlocked` from `"@/services/skill/skill-blocking"`
   - `agentStorage` from `"@/agents/AgentStorage"`
   - `SkillStoreScope` from `"@/services/skill"`
   
   Verify: `bun run typecheck` passes.

3. **Register `skill_list` in `src/tools/registry.ts`** — add import and `toolFactories` entry. Verify: `bun run typecheck` passes.

4. **Modify `<global-skills>` in `src/agents/execution/skill-reminder-renderers.ts`** — replace lines 282–292 with count-only rendering described above. Verify: `bun run typecheck` passes.

5. **Write unit tests** in `src/tools/__tests__/skill_list.test.ts`:
   - Mock `SkillService.getInstance().listAvailableSkills()` to return skills across all scopes
   - Assert correct grouping and counts in returned object
   - Assert blocked skills are excluded
   - Assert empty scopes have zero counts (not missing keys)

6. **Write unit tests for renderer change** in `src/agents/execution/__tests__/skill-reminder-renderers.test.ts` (or add to existing test file if present):
   - Mock skills with shared-scope items
   - Assert `<global-skills>` block contains count line, not individual skill entries
   - Assert count is correct when global skills list is empty (outputs `(none)`)

7. **Run full test suite**: `bun test` — confirm no regressions. Run `bun run typecheck` and `bun run lint`.

## Verification

**Automated:**
```bash
bun run typecheck        # No type errors
bun run lint             # No lint violations
bun run lint:architecture # No layer violations (skill_list.ts imports only from services/agents layers)
bun test                 # All tests pass
```

**Manual checks:**
- Start a conversation with an agent that has global skills available. Confirm the `<available-skills>` system reminder shows `N global skills available — use \`skill_list\` to see them all` in the `<global-skills>` section rather than individual skill lines.
- Call `skill_list` from an agent. Confirm the result includes all expected scopes, correct counts, and truncated descriptions.
- Call `skill_list` when some skills are blocked. Confirm blocked skills do not appear in results.
- Confirm `skill_list` appears in the tool surface when the agent has the tool available (not gated by any skill).

**Edge cases:**
- Zero global skills: `<global-skills>` should show `(none)`, not `0 global skills available`.
- One global skill: singular form — `1 global skill available`.
- Unhydrated whitelisted items (not installed locally): already merged into `grouped.get("shared")` at lines 233–243, so they are counted correctly.
- Agent with all global skills blocked: count of 0 → shows `(none)`.

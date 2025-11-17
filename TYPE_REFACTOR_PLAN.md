# Type System Refactor Plan

## Goals
1. **Clarify ownership** – Every domain (agents, conversations, tools, services, nostr) should expose types via a predictable entry point and avoid leaking internal or legacy shapes.
2. **Eliminate dead/duplicate types** – Remove unused interfaces (e.g., old tool-call payloads) and consolidate repeated unions (like tool names) into shared modules.
3. **Support long-term consistency** – Establish conventions so new features reuse existing type files instead of embedding ad-hoc interfaces inside implementation files.

## Current Issues
| Area | Pain Point |
| --- | --- |
| Agents (`src/agents/types.ts`) | Mixes runtime, storage, and legacy tool-call types inside one file. `ToolCall`/`ToolCallArguments` are unused, while `AgentSummary` and `AgentConfig` share the same namespace but serve different consumers. |
| Tool names | `ToolName` union lives inside `src/tools/registry.ts`, yet agent definitions and services refer to raw strings. There is no single source of truth. |
| Barrel exports | `src/agents/index.ts` re-exports everything (including private helper types) while other modules (conversations) only re-export a single class plus types. The lack of a standard makes it unclear how to import types safely. |
| Inline service DTOs | Services like `DelegationService` and `DynamicToolService` define interfaces inside implementation files, leading to hidden coupling and inconsistent usage. |
| Cross-domain type leakage | Conversations re-export all types via `src/conversations/index.ts`, so downstream modules depend on internal data shapes rather than service APIs. |

## Refactor Steps
1. **Split agent types by concern**
    - Create `src/agents/types/runtime.ts` (AgentInstance, AgentSummary, execution-only interfaces).
    - Create `src/agents/types/storage.ts` (StoredAgentData, AgentConfig, ProjectAgentsConfig).
    - Add a `src/agents/types/index.ts` barrel that re-exports only the intended public surface.
    - Remove legacy `ToolCallArguments` and `ToolCall` if no usages exist (verify via search and delete).
    - Update imports (`agents/execution`, `event-handler`, etc.) to reference the new modules.

2. **Centralize tool names & metadata**
    - Add `src/tools/types.ts` hosting `ToolName`, `AISdkTool`, and any shared tool metadata interfaces.
    - Update `src/tools/registry.ts`, agent config types, and services referencing tool names to import from the new file.
    - Adjust persistence schema (agents storage) to use `ToolName[]` instead of `string[]` where possible, or add type-safety adapters if storage must remain flexible.

3. **Standardize domain barrels**
    - For each top-level module (`agents`, `conversations`, `tools`, `services`, `nostr`, etc.) decide on a convention:
        * `index.ts` should export only the public API (classes/services/types meant for cross-module use).
        * Internal helpers stay private (no `export *` from directories containing implementation files).
    - Document the standard in `MODULE_INVENTORY.md` and update barrels accordingly.

4. **Extract service DTO types**
    - For services with notable input/output shapes (DelegationService, DynamicToolService, SchedulerService, RAG services), create adjacent `types.ts` files or extend existing ones.
    - Import those types wherever the service is consumed rather than re-defining structural types inline.

5. **Reduce cross-domain leakage**
    - Update `src/conversations/index.ts` to export only its public coordinators/interfaces (e.g., `ConversationCoordinator`, `Conversation`, `ConversationMetadata` if truly needed). Keep internal types or utility-only shapes private to conversations.
    - Audit other modules that re-export all types and trim them to explicit exports.

6. **Enforce follow-up rules**
    - Add a lint script or CI check (TypeScript project references or `tsc --noEmit` on type-only modules) to ensure reorganized modules still compile.
    - Update `AGENTS.md` / `MODULE_INVENTORY.md` documenting the new type organization policy.

## Implementation Guidance
- Each step should be its own PR (or grouped logically) to keep reviewable chunks.
- After splitting files, run `tsc --noEmit` and `bun test` to confirm there are no missing imports.
- Preserve backwards compatibility by adding transitional exports (e.g., re-exporting new type modules from the old path) but mark them as deprecated with TODO comments to remove once downstream code is updated.
- Maintain changelog notes describing which types moved and how consumers should adjust imports.

## Open Questions / Follow-ups
- Do we want to enforce strict project references for type-only modules? Investigate TypeScript project references to isolate type packages if necessary.
- Consider generating API docs from type definitions (e.g., `tsdoc`) once the layout is stabilized.

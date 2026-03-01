# tools/ — Tool Implementations (Layer 3)

Actions that agents can invoke. Tools delegate to services for all business logic — they never hold state.

## Structure

- `implementations/` — 57+ tool files, one per tool
- `registry.ts` — Tool registration and metadata
- `utils.ts` — Tool utilities
- `types.ts` — Tool type definitions

## Naming

Files follow `<domain>_<action>.ts`: `rag_search.ts`, `delegation_create.ts`, `agents_list.ts`, `file_read.ts`, `shell_execute.ts`, etc.

## Rules

- One file = one tool. If a tool does multiple things, split it.
- Tools are thin: validate params via Zod, delegate to a service, return result.
- No state in tools (no module-level variables, no caches).
- No direct DB/file/NDK access — use the appropriate service.

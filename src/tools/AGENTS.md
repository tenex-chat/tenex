# tools/ — Tool System (Layer 3)

Actions that agents can invoke. Tools own validation, call into services or lower-layer wrappers, and return structured results. They do not hold long-lived state.

## Structure

- `implementations/` — concrete tool factories plus `fs-hooks.ts`, the shared adapter for filesystem-tool analysis/load hooks
- `registry.ts` — canonical tool registry, auto-injection rules, skill allow/deny handling, and `fs_*` / `home_fs_*` wiring
- `types.ts` — `ToolName`, execution contexts, and factory/result types
- `utils.ts` and `utils/transcript-args.ts` — shared tool helpers

## Current Tool Families

- Agent orchestration: `agents_write`, `ask`, `delegate`, `delegate_followup`, `self_delegate`
- Project and conversation context: `conversation_get`, `conversation_list`, `conversation_search`, `todo_write`, `lesson_learn`
- Knowledge and indexing: `rag_search`, `rag_add_documents`, `rag_collection_*`, `skills_set`
- Execution control: `shell`, `kill`, `schedule_task`, `no_response` (Telegram-triggered turns only)
- Integrations: injected MCP tools (`mcp__<server>__<tool>`), `nostr_publish_as_user`, `send_message`
- Filesystem access: `fs_*` and `home_fs_*` are instantiated in `registry.ts` via `ai-sdk-fs-tools`, not dedicated per-tool files

## Naming

- Tool implementation files follow `<domain>_<action>.ts`: `rag_search.ts`, `agents_write.ts`, `schedule_task.ts`
- Single-word tools keep the plain filename: `ask.ts`, `delegate.ts`, `kill.ts`
- `fs-hooks.ts` is the main exception: it supports the registry-managed filesystem tools rather than defining a user-visible tool itself

## Rules

- `registry.ts` and `types.ts` are the source of truth for the live tool surface. Add or remove tool names there in the same change as the implementation.
- Keep prompt/docs/tests in sync when tools are added, merged, or removed.
- Tools are thin: validate params via Zod, delegate to a service or approved lower-layer wrapper, return structured results.
- No module-level state or caches inside tool implementations. If state must persist across calls, move it to a service.
- Conversation-required tools must be safe to filter when no conversation context is available.
- Auto-injected tools (`self_delegate`, `change_model`, `home_fs_*`, `send_message`) are registry/runtime concerns, not per-agent configuration.
- Built-in MCP resource and subscription tools are removed. External MCP remains available only through injected `mcp__<server>__<tool>` tools; resource browsing and subscriptions are deferred future work.
- Do not access NDK, config paths, or storage ad hoc from tools. Use `src/nostr/` wrappers, `ConfigService`, and the owning service.

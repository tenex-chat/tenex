# agents/ — Agent Runtime (Layer 3)

Core multi-agent coordination. Agent definitions, registration, execution orchestration, tool invocation, and session lifecycle.

## Key Files

- `AgentRegistry.ts` — Built-in agent definitions
- `AgentStorage.ts` — On-disk agent metadata persistence
- `agent-loader.ts` — Dynamic agent loading
- `agent-installer.ts` — Agent installation
- `script-installer.ts` — Script-based agent installation
- `ConfigResolver.ts` — Agent configuration resolution
- `tool-names.ts` — Tool name parsing/categorization
- `tool-normalization.ts` — Tool input normalization
- `role-categories.ts` — Agent role categorization

## Subdirectories

- `execution/` — Core execution engine (~18 files): `AgentExecutor`, `MessageCompiler`, `StreamSetup`, `StreamCallbacks`, `ToolExecutionTracker`, `SessionManager`, etc.
- `supervision/` — Agent supervision logic
- `types/` — Shared type definitions

## Agent Identity Preservation

Agent files (`.tenex/agents/<pubkey>.json`) are never deleted when removed from projects. Instead they get `status: "inactive"` and retain their Nostr identity (pubkey/nsec). This prevents identity churn and enables reactivation. Use `removeAgentFromProject()`, not `deleteAgent()`.

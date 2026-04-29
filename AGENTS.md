# TENEX

Multi-agent AI coordination system built on Nostr. Bun CLI application.

## Key References

- **`CLAUDE.md`** — coding standards, layer architecture, naming conventions, import rules, anti-patterns
- **`MODULE_INVENTORY.md`** — canonical map of all modules; consult before writing code
- **`README.md`** — project overview and setup

## File Size

- Target: under 300 LOC per file
- Hard limit: 500 LOC
- When a file approaches 300 LOC, split it by responsibility before adding more

## End-to-End Runtime Probes

When adding a new feature or changing runtime behavior, prefer validating it with a real end-to-end probe in addition to focused unit tests. A good probe should run the actual TENEX binaries, use the local TENEX relay, create an isolated TENEX base directory, seed realistic projects/agents, drive signed Nostr events, and inspect the published events and telemetry to verify the behavior occurred.

For agent/runtime behavior, use or extend the runtime probe harness (for example `scripts/tenex-runtime-probe.ts`) rather than relying only on mocks around individual functions. Mock LLM responses are acceptable at the LLM boundary for deterministic probes, but the process, relay, event routing, tool execution, persistence, and status publication should be as real as practical.

If the probe exposes a gap, keep the probe as the reproduction and fix the runtime until the event timeline matches the expected behavior. Record any missing telemetry as part of the feature work when internal state transitions are needed to debug failures.

## Rust Agent Design Decisions

### RAG: Agents Do Not Manage Collections
Agents may only add documents with an **audience scope** (`self` or `project`) — they do not create, list, or delete RAG collections. The `rag_add_documents` tool maps `self` → `agent_{pubkey}` and `project` → `project_{id}` internally. There is no `rag_collection_list` or `rag_collection_delete` tool available to agents. Do not add them back.

### Lessons: LLM-Maintained `+INDEX.md`, Not RAG
The `learn` tool does **not** store lessons in a RAG collection. Instead, it asks an LLM to incorporate the new lesson into `+INDEX.md` in the agent's home directory, organized by category. The `+INDEX.md` file is automatically injected into the agent's system prompt (all `+` prefix files in the agent home are). This diverges intentionally from the TypeScript runtime.

## Commands

```bash
bun test                   # Run all tests
bun run typecheck          # TypeScript strict check
bun run lint               # ESLint
bun run lint:architecture  # Layer violation check
```

# TENEX

Multi-agent AI coordination system built on Nostr. Rust workspace.

## Key References

- **`CLAUDE.md`** — coding standards, layer architecture, naming conventions, import rules, anti-patterns
- **`MODULE_INVENTORY.md`** — canonical map of all modules; consult before writing code
- **`README.md`** — project overview and setup
- **`MIGRATION_PENDING.md`** — feature parity gaps between the old TypeScript runtime and the Rust stack

## TypeScript Reference

The TypeScript runtime has been removed. If you need to look up how a feature worked in TypeScript, a read-only reference worktree is available at:

```
/home/pablo/Work/tenex-typescript-ref
```

This is a detached-HEAD checkout of commit `35738290` (2026-04-27, "Allow concurrent RALs via lock-handoff for mid-tool dispatches") — the last stable state before cleanup. Do not modify it.

## File Size

- Target: under 300 LOC per file
- Hard limit: 500 LOC
- When a file approaches 300 LOC, split it by responsibility before adding more

## End-to-End Runtime Probes

When adding a new feature or changing runtime behavior, prefer validating it with a real end-to-end probe in addition to focused unit tests. A good probe should run the actual TENEX binaries, use the local TENEX relay, create an isolated TENEX base directory, seed realistic projects/agents, drive signed Nostr events, and inspect the published events and telemetry to verify the behavior occurred.

For agent/runtime behavior, use or extend the runtime probe harness (for example `scripts/tenex-runtime-probe.ts`) rather than relying only on mocks around individual functions. Mock LLM responses are acceptable at the LLM boundary for deterministic probes, but the process, relay, event routing, tool execution, persistence, and status publication should be as real as practical.

For new or uncertain probe scenarios, prefer a real first pass with Ollama when practical and record it as a replay cassette. The probe harness supports:

- Record: `TENEX_PROBE_LLM=ollama TENEX_PROBE_RECORD_CASSETTE=/path/to/file.jsonl`
- Replay: `TENEX_PROBE_LLM=cassette TENEX_PROBE_CASSETTE=/path/to/file.jsonl`
- Scale replay waits while debugging: `TENEX_PROBE_LLM_GENERATION_TIME_FACTOR=0.1`

The same settings are available as `--llm`, `--record-cassette`, `--cassette`, and `--llm-generation-time-factor` flags. Replay preserves recorded LLM generation delays by default.

If the probe exposes a gap, keep the probe as the reproduction and fix the runtime until the event timeline matches the expected behavior. Record any missing telemetry as part of the feature work when internal state transitions are needed to debug failures.

## Rust Agent Design Decisions

### RAG: Agents Do Not Manage Collections
Agents may only add documents with an **audience scope** (`self` or `project`) — they do not create, list, or delete RAG collections. The `rag_add_documents` tool maps `self` → `agent_{pubkey}` and `project` → `project_{id}` internally. There is no `rag_collection_list` or `rag_collection_delete` tool available to agents. Do not add them back.

### Lessons: LLM-Maintained `+INDEX.md`, Not RAG
The `learn` tool does **not** store lessons in a RAG collection. Instead, it asks an LLM to incorporate the new lesson into `+INDEX.md` in the agent's home directory, organized by category. The `+INDEX.md` file is automatically injected into the agent's system prompt (all `+` prefix files in the agent home are). This diverges intentionally from the TypeScript runtime.

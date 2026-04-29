# tenex-agent

One-shot Rust binary. Receives one Nostr event on stdin, runs a multi-tool LLM loop via `rig-core`, emits NDJSON on stdout, then exits. No relay connections. No persistent state.

Spawned by the bun project runtime (via `AgentExecutor`) or by the future Rust orchestrator over a Unix socket. In both cases the wire protocol is the same NDJSON frame format.

Canonical spec: `docs/RUST-AGENT-SPEC.md`. Fleet context: `docs/plans/2026-04-28-architecture-map.md`.

## I/O contract — do not break

**stdin:** one JSON object — a complete Nostr event (`id`, `pubkey`, `created_at`, `kind`, `tags`, `content`, `sig`).

**stdout (NDJSON):**
- Zero or more intermediate frames: kind:1, `["e", root_event_id, "", "root"]` tag, no `p` tag, no `status` tag.
- Final visible text is a completion frame only when the turn has no successfully emitted pending external work: kind:1, with `["p", triggering_event.pubkey]` and `["status", "completed"]`.
- If the turn successfully emitted `delegate`, `delegate_followup`, `delegate_crossproject`, `self_delegate`, or `ask`, final visible text is a conversation frame instead: no `p` tag and no `status` tag.

**stderr:** human-readable progress. Never parsed.

**`TENEX_PROJECT_ID` env var:** required. Set by the daemon before spawning. Accepts a NIP-33 coordinate or bare dTag (passed to `tenex-project::Project::open_default`).

**`TENEX_MCP_MANIFEST` + `TENEX_MCP_SOCKET` env vars:** optional. Set together by the runtime when a project-scoped MCP bridge is active. The agent only registers proxy tools from this manifest; it never starts MCP servers.

## Critical invariants

- **NDJSON-over-stdio generalizes to NDJSON-over-Unix-socket.** The same frame format must remain valid when the runtime orchestrator wraps this process over a socket. Protect this property in any spec edits.
- **Completion only when work is actually done.** The final stdout line is a signed completion unless the turn started pending external work; pending-work text is emitted as a non-notifying conversation frame.
- **Root event ID derivation** (`src/nostr.rs`): first `["e", id, _, "root"]` tag → else first `["e", id, ...]` tag → else the triggering event's own ID.
- **Project context via `tenex-project`.** Agent definitions, model resolution, and project metadata come from `tenex-project::Project`. Do not parse agent JSON files directly.
- **Tools in `src/tools/`.** `shell`, `fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep`, `todo_write`, `delegate`, and MCP proxy tools. Add new static tools as separate files in that directory; register them in `main.rs` via the `run_agent!` macro.
- **No relay connections.** This binary never opens a relay. Signing and publishing happen only to stdout.

## How to approach changes

1. `cargo build -p tenex-agent && cargo test -p tenex-agent`.
2. System prompt fragments live in `crates/tenex-system-prompt`. Runner-owned prompt inputs such as root `AGENTS.md` loading live in `src/project_instructions.rs`.
3. Nostr event construction and signing: `src/nostr.rs`. Keep the hook (`NostrHook`) and signer (`AgentSigner`) in sync.
4. Model/provider resolution: `src/config.rs`. Reads `~/.tenex/llms.json` and `~/.tenex/providers.json`.
5. Any change to the stdout frame format must be coordinated with the bun `AgentExecutor` and the runtime orchestrator spec.

## Intentionally absent

- No streaming intermediate events (roadmap; not in v1).
- No conversation history passed to the LLM (roadmap).
- No `no_response` or `ask` tools (roadmap).
- No token budgeting or compaction (roadmap).
- No relay client.
- No lessons.

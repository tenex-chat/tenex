# TENEX Architecture Map (WIP)

Working document. Captures current state and target state of the Rust decomposition. Updated as specs land.

---

## Today (April 2026)

```
                              ┌─────────────────────┐
                              │    Nostr relays     │
                              └──────────┬──────────┘
                                         │
            ┌────────────────────────────┴────────────────────────────┐
            │                                                         │
            ▼                                                         ▼
   ┌──────────────────┐                                    ┌────────────────────┐
   │ tenex (Rust)     │                                    │ Bun project runtime│
   │   supervisor     │── boots ──▶ bun src/boot.ts ──▶    │  (one per project) │
   │  (one per host)  │                                    │                    │
   └──────────────────┘                                    │  - NDK subscribe   │
            │                                              │  - Dispatch / RAL  │
            │ uses                                         │  - Supervision     │
            ▼                                              │  - AgentExecutor   │
   ┌──────────────────┐                                    │  - Tools           │
   │ whitelist (Rust) │◀─── trust check ────────────────── │  - Telegram gw     │
   │   (Unix socket)  │                                    │  - MCP             │
   └──────────────────┘                                    │  - RAG             │
                                                           │  - Scheduler       │
                                                           │  - Intervention    │
                                                           │  - Summarizer      │
                                                           │  - Conv. summarizer│
                                                           └────────┬───────────┘
                                                                    │
                                                                    │ spawns (sometimes)
                                                                    ▼
                                                           ┌────────────────────┐
                                                           │ tenex-agent (Rust) │
                                                           │  one-shot, stdio   │
                                                           │  (rarely used yet) │
                                                           └────────────────────┘

Storage today:
  ~/.tenex/config.json            - global config
  ~/.tenex/agents/<slug>/         - agent definitions + nsecs (JSON)
  ~/.tenex/projects/<dTag>/
      conversations/*.json        - conversation transcripts
      conversation-catalog.db     - SQLite read-model
      schedules.json              - scheduled tasks
      <misc per-project state>
  ~/.tenex/intervention_state_<dTag>.json
  ~/.tenex/data/conversation-categories.json
```

The bun runtime is doing almost everything per-project. The Rust pieces (supervisor, whitelist) are infrastructural and outside the project hot path. `tenex-agent` exists but is rarely the actual execution path.

---

## Target end state

```
                                        ┌─────────────────────┐
                                        │    Nostr relays     │
                                        └──────────┬──────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────────┐
                                        │  tenex relay-mux    │
                                        │   (one per host)    │  (roadmap)
                                        │                     │
                                        │  whitelist filter   │
                                        │  fanout to children │
                                        └──┬──────────────┬───┘
                                           │              │
                  ┌────────────────────────┘              │
                  │ project events (filtered)             │ raw subscriptions
                  ▼                                       ▼
       ┌───────────────────┐                    ┌─────────────────────┐
       │ tenex supervise   │                    │ tenex-summarizer    │
       │  (boot dispatcher)│                    │ tenex-cron          │
       └─────────┬─────────┘                    │ tenex-intervention  │
                 │                              │ (each: own daemon,  │
                 │ boots                        │  each: SQLite read) │
                 ▼                              └──────────┬──────────┘
       ┌───────────────────┐                               │
       │ tenex-runtime     │◀─── routed events ────────────┘
       │ (per active proj) │
       │                   │
       │  - dispatch       │
       │  - RAL state      │ ──── publishes via NIP-46 signer ──▶ relay-mux ──▶ relays
       │  - delegation     │
       │  - runner mgmt    │
       └────────┬──────────┘
                │ NDJSON / Unix socket
                ▼
       ┌─────────────────────┐
       │ tenex-agent runners │
       │ (one per active     │      ◀───── tenex-context (projection lib)
       │  conversation×agent)│      ◀───── tenex-project (read)
       │                     │      ◀───── tenex-conversations (read+write)
       │  - LLM loop         │      ◀───── tenex-identity (pubkey resolver)
       │  - tools            │
       └─────────────────────┘

Storage end state (consolidated):
  ~/.tenex/config.json
  ~/.tenex/identity-cache.db                     - host-wide kind:0 cache
  ~/.tenex/projects/<dTag>/project.db            - agents, metadata, skills
  ~/.tenex/projects/<dTag>/conversation.db       - messages, prompt-history,
                                                   tool messages, completions,
                                                   delegations, ctx state

Single user-facing binary:
  tenex supervise / cron / intervention / summarize / agent / whitelist
```

The bun runtime is gone. Every component is small, single-purpose, and reads/writes typed SQLite via library crates.

---

## What is what

### Library crates (no daemon, just code)

| Crate | Purpose | Status |
|-------|---------|--------|
| `tenex-conversations` | Conversation storage: messages, tool messages, prompt-history, completions, delegations | Spec ✅, building 🔧 |
| `tenex-project` | Project state: agents, metadata, skills, allowlists, MCP, signer trait | Spec ✅, building 🔧 |
| `tenex-context` | LLM-facing projection: history → `messages[]`, context management, cache anchoring | Spec ✅ |
| `tenex-identity` | `pubkey → IdentityView` via kind:0 + cache | Spec ✅ |
| `tenex-runtime` (lib parts) | Shared lockfile, tracing, config helpers used by every binary | Implicit; lands during umbrella restructure |

### Daemons (long-lived)

| Daemon | Purpose | Status |
|--------|---------|--------|
| `tenex supervise` | Boots project runtimes on inbound events | ✅ shipped (as `tenex daemon` today; renaming) |
| `tenex whitelist` | Trust checks via Unix socket | ✅ shipped (as standalone today; folding under umbrella) |
| `tenex summarize` | Generates kind:513 metadata events | ✅ implemented (as standalone crate; folding under umbrella) |
| `tenex cron` | Scheduled and one-off task firing | Spec ✅ |
| `tenex intervention` | Human-replica review on agent-completion timeout | Spec ✅ |
| **relay-multiplexer** | Single host-wide relay client; filtered fanout to children | Roadmap, not specced |
| **NIP-46 signer** | Holds nsecs out of the LLM-touching processes | Roadmap, not specced |
| `tenex-runtime` (orchestrator) | Per-project: subscribe, dispatch, RAL, delegation, runner mgmt | Spec ✅ (forward plan; **not v1 build**) |

### One-shot binaries

| Binary | Purpose | Status |
|--------|---------|--------|
| `tenex agent` | Single-turn LLM loop; reads event from stdin, emits NDJSON | ✅ shipped |
| `tenex cron list/add/rm` | Cron management subcommands | Spec ✅ |
| `tenex whitelist check` | Single trust check from shell | ✅ shipped |
| `tenex doctor migrate` | One-time migration runner (JSON → SQLite) | Each crate's migration helper; runs from here |

---

## Phases of the migration

### Phase 0 — done
- Rust supervisor (`tenex daemon`).
- Whitelist daemon.
- `tenex-agent` v1 (one-shot, stdio, no delegation).

### Phase 1 — current
- Library foundations: `tenex-conversations`, `tenex-project`. (Building now.)
- `tenex-summarizer` daemon. (Built; awaiting cutover.)
- Specs for: `tenex-context`, `tenex-identity`, `tenex-cron`, `tenex-intervention`, umbrella binary, runtime orchestrator (forward plan).

### Phase 2 — next concrete steps
- Implement `tenex-cron` and `tenex-intervention` daemons. (Specs ready.)
- Umbrella binary restructure: collapse all binaries under `tenex` subcommands.
- Runner integration interim: bun's `AgentExecutor` shrinks to "talk to long-lived `tenex-agent` over Unix socket." Bun still orchestrates; `tenex-agent` becomes the only LLM execution path. Validates the NDJSON-over-Unix-socket protocol without porting orchestration.
- Cutover the bun-side writers for `tenex-conversations` and `tenex-project` (TS opens SQLite via bindings, stops writing JSON).

### Phase 3 — further out
- Relay-multiplexer.
- NIP-46 signer daemon.
- `tenex-context` Rust implementation.
- `tenex-identity` Rust implementation.

### Phase 4 — the moonshot
- `tenex-runtime` orchestrator v1 (simple turns, no delegation, opt-in per project).
- v2: long-lived sessions, prompt cache reuse.
- v3: delegation, parity with bun.
- Bun project runtime retires per-project as v3 hits parity.

---

## The contracts that don't change as we go

These are commitments made now that every later piece depends on:

- **NDJSON over Unix sockets** is the canonical local IPC. `tenex-agent` already uses NDJSON over stdio; the same frames generalize to socket. The runtime orchestrator and runner speak this. The whitelist daemon's line protocol migrates to it eventually.
- **Schema-as-contract for `tenex-conversations` and `tenex-project`.** Both bun (TS binding) and Rust open the same SQLite, the schema is the contract, no service in front.
- **`Signer` trait.** Agent signing is always behind this trait. One impl today (nsec), one tomorrow (NIP-46). Single-line swap when the bunker lands.
- **Project-id input flexibility.** Every Rust API that takes a project ID accepts either the full NIP-33 coordinate (`"31933:<pubkey>:<dTag>"`) or the bare dTag.
- **Three-role separation in the future orchestrator.** Subscribe (relay-mux) ≠ orchestrate (`tenex-runtime`) ≠ execute (`tenex-agent`). The runner never opens a relay connection.
- **Lessons are not in either DB.** Lessons are out of scope for `tenex-project` and `tenex-conversations`. They will get their own home or no home; not bundled into the foundation crates.

---

## Specs index

- `2026-04-28-architecture-map.md` — this file.
- `2026-04-28-tenex-conversations-library.md` — conversation storage.
- `2026-04-28-tenex-project-library.md` — project state.
- `2026-04-28-tenex-context-library.md` — LLM projection.
- `2026-04-28-tenex-identity-library.md` — pubkey resolver.
- `2026-04-28-tenex-summarizer.md` — kind:513 daemon.
- `2026-04-28-tenex-scheduler.md` — cron daemon + management CLI.
- `2026-04-28-tenex-intervention.md` — completion-timeout watcher.
- `2026-04-28-tenex-runtime-orchestrator.md` — forward plan; per-project orchestrator.
- `2026-04-28-umbrella-binary.md` — workspace restructure to single `tenex` binary.

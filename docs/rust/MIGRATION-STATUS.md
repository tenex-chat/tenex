# TENEX Rust Migration — Live Status

**Last updated:** 2026-04-24  
**Active branch:** `rust-agent-worker-publishing`  
**Audited commit:** `e37a4342`

## TL;DR

Rust already owns the daemon control plane on this branch. Bun remains the bounded worker execution layer plus shared runtime contracts.

The important status update is that the old TypeScript daemon surface is already structurally gone at `HEAD`:

- `src/daemon/` is gone
- `src/commands/` is gone
- `src/index.ts` is now an internal-only guard that tells operators to use the Rust binary

The remaining blockers are no longer "delete the TS daemon tree". The remaining blockers are:

- transport acceptance and restart behavior
- real-client verification
- correlation / rollback / restart / performance quality gates
- lingering TypeScript runtime coupling such as `getProjectContext()` and TS-owned transport/chat-context stores

## Verified Current Branch State

| Area | Current state | Evidence |
| --- | --- | --- |
| Daemon control plane | Rust-owned | `crates/tenex-daemon/src/daemon_foreground.rs`, `daemon_loop.rs`, `daemon_maintenance.rs`, `inbound_dispatch.rs`, `publish_outbox.rs`, `relay_publisher.rs` |
| Backend/status publishing | Rust-owned | `crates/tenex-daemon/src/project_status_runtime.rs`, backend status/tick modules documented in `MODULE_INVENTORY.md` |
| Telegram daemon-side runtime | Rust slices present | `crates/tenex-daemon/src/telegram/inbound.rs`, `telegram/ingress_runtime.rs`, `telegram/chat_context.rs` |
| TypeScript package entrypoint | internal-only | `src/index.ts` exits with "Use the Rust TENEX binary" |
| Old TS daemon tree | removed | no `src/daemon/**` files at `HEAD` |
| Old TS command tree | removed | no `src/commands/**` files at `HEAD` |
| Bun execution layer | still active | `src/agents/execution/**`, `src/tools/**`, `src/llm/**`, `src/nostr/**`, `src/services/projects/**` |

## Milestone Read

| Milestone | State at `HEAD` | Notes |
| --- | --- | --- |
| M0-M7 | effectively landed | worker protocol, Rust daemon spine, filesystem/RAL authority, Rust publishing, and status slices are present in-tree |
| M8 transport/runtime | partially landed, still gated | Rust Telegram and daemon transport slices exist, but acceptance gates remain open |
| M9 structural TS daemon deletion | materially landed | old `src/daemon` and `src/commands` surfaces are gone |
| Release-ready complete migration | not yet | remaining gates are transport, restart, real-client, correlation, rollback, perf, and runtime-coupling cleanup |

## Remaining Blockers

These are the blockers that still matter for this branch.

### Transport and real-client gates

| Blocker | Why it still matters |
| --- | --- |
| Telegram inbound acceptance | The Rust Telegram inbound path exists in-tree, but the milestone quality gates still require full inbound behavior coverage before calling the migration complete |
| Telegram outbound idempotence across restart | `docs/rust/implementation-milestones-and-quality-gates.md` explicitly requires durable, idempotent Telegram delivery across daemon restarts |
| Real-client verification | The milestone plan explicitly requires web, iOS, CLI, and Telegram to keep working against the Rust daemon, including restart recovery |

### Cross-cutting quality gates

These come directly from `docs/rust/implementation-milestones-and-quality-gates.md` and remain the right bar for completion:

- correlation-ID chain across Rust logs, worker protocol messages, RAL journal entries, worker state files, and telemetry spans
- rollback tests with in-flight state, not only idle-state rollback
- no stuck active RALs after restart
- no duplicate completions beyond the explicitly accepted semantics
- cold/warm TTFT performance gate

### Remaining TypeScript runtime coupling

The tree still has active TypeScript runtime dependencies that are not old daemon shims but do matter for the long-term migration boundary:

| Surface | Current evidence | Why it matters |
| --- | --- | --- |
| `getProjectContext()` | imported across execution, tools, prompts, Nostr, MCP, search, and scheduling | Bun execution is still heavily coupled to AsyncLocalStorage-backed TS runtime state |
| `src/services/ingress/TransportBindingStoreService.ts` | imported by `src/tools/registry.ts`; read by `src/prompts/fragments/08-project-context.ts` | Bun prompt/tool behavior still depends on TS-owned transport binding persistence |
| `src/services/telegram/TelegramChatContextStoreService.ts` | read by `src/prompts/fragments/08-project-context.ts` | Bun prompt assembly still depends on TS-owned Telegram chat context persistence |
| `src/services/mcp/McpSubscriptionService.ts` | requires project context during setup and captures `mcpManager` because MCP callbacks run outside ALS scope | MCP push notification behavior is still tied to TypeScript runtime state |
| `src/services/ral/**` and active `RALRegistry` usage | still exercised by execution and notification flows | RAL is still part of the active Bun execution model, not dead daemon scaffolding |

## What Should Not Be Reported As Current Blockers

These claims were true earlier in the migration but are stale on this branch now:

- "`src/daemon/Daemon.ts` is still the live blocker"
- "`getDaemon()` keeps the old TS daemon alive"
- "`src/commands/daemon.ts` is still the live entrypoint"
- "M9 has barely started because the TS daemon tree still exists"

Those statements contradict the current checkout.

## Current Architectural Boundary

The branch should now be described this way:

```text
Rust
  - daemon/control plane
  - routing, dispatch, publish outbox, relay publishing
  - backend/project-status maintenance
  - long-lived daemon and Telegram transport ownership

Bun / TypeScript
  - bounded worker execution
  - AgentExecutor, tool registry, prompts, providers, MCP client behavior
  - runtime contracts still consumed by the worker
  - remaining transport/chat/project context coupling that has not yet been fully re-homed
```

## Recommended Next Focus

If the goal is to move this branch toward release rather than do more historical cleanup, the next work should target:

1. real-client verification against the Rust daemon
2. Telegram inbound/outbound acceptance, especially restart idempotence
3. correlation/rollback/restart/perf gates from the milestone plan
4. deliberate reduction of `getProjectContext()` and TS-owned transport/chat-context coupling

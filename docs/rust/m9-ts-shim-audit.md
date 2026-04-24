# M9 TS Shim Audit — 2026-04-24

## Scope

- Branch: `rust-agent-worker-publishing`
- Commit audited: `e37a4342`
- Audit basis: current tree at `HEAD`, not historical assumptions from earlier migration passes

## Executive Summary

The previous M9 audit is stale. In the current checkout:

- `src/daemon/` does not exist.
- `src/commands/` does not exist.
- There is no live `getDaemon()` call chain left in TypeScript.

That means the old claim that M9 is blocked by 14 still-live `src/daemon/*` files is no longer true on this branch. The structural TypeScript daemon deletion has already happened.

The remaining migration risk is not "old TS daemon files still exist". The remaining risk is that Bun execution code is still coupled to TypeScript runtime state and transport-side data stores that Rust has not fully replaced yet.

## Current-Tree Findings

### Removed TS daemon surfaces

These surfaces are absent from the working tree at `HEAD`:

| Surface | Current state | Evidence |
| --- | --- | --- |
| `src/daemon/**` | removed | `rg --files src/daemon` returns no files |
| `src/commands/**` | removed | `rg --files src/commands` returns no files |
| `getDaemon()` call chain | removed | `rg -n "getDaemon"` only finds stale documentation, not live code |

### Rust owns the daemon control plane

The control plane now lives in `crates/tenex-daemon`, including:

- foreground daemon loop: `crates/tenex-daemon/src/daemon_foreground.rs`, `daemon_loop.rs`, `daemon_maintenance.rs`
- worker dispatch and publish ownership: `inbound_dispatch.rs`, `publish_outbox.rs`, `relay_publisher.rs`
- backend/status ownership: `project_status_runtime.rs`
- Telegram-side daemon slices: `telegram/inbound.rs`, `telegram/ingress_runtime.rs`, `telegram/chat_context.rs`

This matches the current package boundary in `src/index.ts`, which now exits with an internal-only message and tells operators to use the Rust TENEX binary.

## What Still Couples Bun to TypeScript Runtime State

These are the current migration-relevant TypeScript surfaces. They are not old daemon shims, but they still prevent the Bun worker layer from being a minimal, cleanly isolated execution substrate.

### `getProjectContext()` remains pervasive

`getProjectContext()` is still imported across execution, prompt compilation, tools, Nostr encoding, MCP, and search flows. Current importers include:

- execution path: `src/agents/execution/AgentExecutor.ts`, `StreamSetup.ts`, `StreamCallbacks.ts`, `PostCompletionChecker.ts`, `ToolSupervisionWrapper.ts`
- prompt/tool path: `src/prompts/utils/systemPromptBuilder.ts`, `src/tools/registry.ts`, `src/tools/implementations/ask.ts`, `delegate.ts`, `learn.ts`, `rag_add_documents.ts`
- Nostr/runtime path: `src/nostr/AgentEventEncoder.ts`, `src/nostr/utils.ts`
- services path: `src/services/agents/AgentResolution.ts`, `src/services/agents/EscalationService.ts`, `src/services/scheduling/SchedulerService.ts`

This is the biggest remaining TypeScript runtime coupling in the current tree.

### Transport binding and Telegram chat context still live in TypeScript

These stores are still consumed by prompt and tool assembly:

| File | Why it still matters |
| --- | --- |
| `src/services/ingress/TransportBindingStoreService.ts` | persists `transport-bindings.json`; imported by `src/tools/registry.ts` and read by `src/prompts/fragments/08-project-context.ts` |
| `src/services/telegram/TelegramChatContextStoreService.ts` | persists `telegram-chat-contexts.json`; read by `src/prompts/fragments/08-project-context.ts` for Telegram DM/group/topic rendering |

Rust already has corresponding daemon-side slices (`crates/tenex-daemon/src/telegram/chat_context.rs` and transport/inbound runtime code), but Bun still reads TypeScript-owned stores during prompt assembly and tool gating.

### MCP resource features are removed; tool execution remains

The old TypeScript MCP resource list/read helpers and subscription path have been removed from the current tree. MCP remains active only through per-project `MCPManager` startup and injected `mcp__<server>__<tool>` tools exposed via `src/tools/registry.ts`.

That means external MCP tool execution is still part of the active TypeScript worker runtime, but MCP resource browsing, reads, subscriptions, and wakeups are no longer part of the current migration scope. They are deferred future work if the product needs them again.

### RAL remains Bun-runtime critical

`RALRegistry` still participates in worker execution, delegation, injections, and notification delivery. It is not an "old daemon shim" that can be deleted by directory sweep. It is still part of the active Bun execution runtime.

## Current Blockers For "Complete Migration"

The blockers at `HEAD` are now quality, transport, and runtime-boundary issues rather than undeleted `src/daemon/*` files:

| Blocker | Why it is still open |
| --- | --- |
| Telegram inbound acceptance | Rust Telegram inbound files exist, but the milestone acceptance gates for full inbound behavior are still the relevant bar |
| Telegram outbound idempotence across restart | called out as a quality gate in `docs/rust/implementation-milestones-and-quality-gates.md`; still needs explicit verification |
| Real-client verification | milestone plan requires web/iOS/CLI/Telegram to keep working against the Rust daemon |
| Correlation-ID chain | milestone plan requires correlation IDs in Rust logs, worker protocol, RAL journal, worker state, and telemetry spans |
| Restart/rollback quality gates | milestone plan still requires in-flight rollback tests, no stuck RALs after restart, and no duplicate completions |
| Cold/warm TTFT performance gate | still an explicit migration-quality gate |
| TypeScript runtime coupling | `getProjectContext()`, transport binding store, Telegram chat context store, injected MCP tool execution/runtime ownership, and active RAL usage still bind Bun execution to TS runtime state |

## What Is No Longer A Blocker

These older claims should not be repeated for this branch anymore:

- "M9 is blocked by `src/daemon/Daemon.ts` and friends"
- "`getDaemon()` keeps the old TS daemon tree alive"
- "`src/commands/daemon.ts` is still a live entrypoint"

All of those statements are stale for `e37a4342`.

## Conclusion

At current `HEAD`, the structural deletion portion of M9 is largely done: the old TypeScript daemon tree is gone, the old TypeScript command tree is gone, and the package entrypoint is now explicitly internal while Rust owns the operator-facing binaries.

The remaining work is not tree-deletion cleanup. It is:

1. closing the transport and restart-quality gates
2. completing real-client verification
3. reducing the remaining Bun runtime dependence on `getProjectContext()` and TS-owned transport/chat context stores

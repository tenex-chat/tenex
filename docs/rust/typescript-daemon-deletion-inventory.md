# TypeScript Daemon Deletion Inventory

This document tracks the current `HEAD` state of the TypeScript side after the Rust daemon migration work on `rust-agent-worker-publishing`.

It is intentionally split into three buckets:

1. TypeScript daemon/control-plane code that is already gone
2. TypeScript execution/runtime code that must still remain
3. TypeScript surfaces that look daemon-adjacent but are still runtime-coupled and therefore not safe to delete yet

This is an inventory, not a deletion checklist.

## Current Tree Snapshot

At audited commit `e37a4342`:

- `src/daemon/**` is absent
- `src/commands/**` is absent
- `src/index.ts` is internal-only and points operators to the Rust binary
- Rust control-plane code lives under `crates/tenex-daemon/**`

That means the "delete the TS daemon directory" phase is no longer hypothetical on this branch. It has already happened.

## Already Deleted TypeScript Daemon / Control-Plane Surfaces

### Whole trees already gone

| Surface | Current state |
| --- | --- |
| `src/daemon/**` | removed |
| `src/commands/**` | removed |

### Additional removed TS daemon/control-plane modules

These are still useful to track historically because they were part of the daemon/control-plane cleanup and are no longer present:

| File | Removed responsibility |
| --- | --- |
| `src/services/dispatch/AgentDispatchService.ts` | old TS inbound routing / delegation completion / wake-up orchestration |
| `src/services/dispatch/AgentRouter.ts` | old TS routing helpers |
| `src/services/dispatch/DelegationCompletionHandler.ts` | old TS delegation completion path |
| `src/services/agents/AgentConfigUpdateService.ts` | TS daemon-side kind `24020` config update handling |
| `src/services/agents/ProjectMembershipPublishService.ts` | old TS project membership sync/publish logic |
| `src/services/ingress/ChannelSessionStoreService.ts` | old long-lived transport session state |
| `src/events/runtime/diagnostic-event-snapshot.ts` | TS daemon diagnostics snapshotting |
| daemon-only routing/classification helpers formerly in `src/nostr/AgentEventDecoder.ts` | relay classification moved to Rust-side ownership |

## TypeScript Execution / Runtime Code That Must Remain

These are still part of the active Bun worker/runtime surface.

| Scope | Must remain |
| --- | --- |
| Worker entrypoint and protocol | `src/agents/execution/worker/**`, `src/events/runtime/AgentWorkerProtocol.ts`, `src/events/runtime/InboundEnvelope.ts` |
| Execution core | `src/agents/execution/**` including `AgentExecutor.ts`, `ExecutionContextFactory.ts`, `StreamSetup.ts`, `StreamExecutionHandler.ts`, `StreamCallbacks.ts`, `MessageCompiler.ts`, `PostCompletionChecker.ts`, `RALResolver.ts`, context-management, prompt history/cache, and tool supervision helpers |
| Tool runtime | `src/tools/registry.ts`, `src/tools/implementations/**` |
| Nostr runtime path | `src/nostr/AgentPublisher.ts`, `AgentEventEncoder.ts`, `RustPublishOutbox.ts`, `NostrInboundAdapter.ts`, trace/publish helpers |
| Worker support services | `src/services/projects/**`, `src/services/mcp/**`, `src/services/skill/**`, `src/services/analysis/**`, `src/services/agents/**`, `src/services/rag/**`, `src/services/ConfigService.ts`, `src/services/LLMOperationsRegistry.ts`, `src/services/CooldownRegistry.ts` |
| Shared runtime contracts and fixtures | `src/events/runtime/LocalInboundAdapter.ts`, `RecordingRuntimePublisher.ts`, runtime publisher contracts, test fixtures still consumed by worker/protocol tests |
| Prompts / conversations / LLM | `src/prompts/**`, `src/conversations/**`, `src/llm/**` |

## Ambiguous Or Runtime-Coupled TypeScript Surfaces

These are the important "do not delete by smell" areas in the current tree.

| File / area | Why it is not safe to delete yet | Evidence in current tree |
| --- | --- | --- |
| `src/services/projects/ProjectContext.ts` and `getProjectContext()` | Core Bun execution still depends on AsyncLocalStorage-backed project context | imported across execution, prompts, tools, Nostr, MCP, search, scheduling |
| `src/services/ingress/TransportBindingStoreService.ts` | looks control-plane-ish, but still drives worker prompt/tool behavior | imported by `src/tools/registry.ts`; read by `src/prompts/fragments/08-project-context.ts` |
| `src/services/telegram/TelegramChatContextStoreService.ts` | Rust has daemon-side Telegram chat context, but Bun still reads TS-owned chat context during prompt rendering | read by `src/prompts/fragments/08-project-context.ts` |
| `src/services/mcp/MCPManager.ts` plus MCP tool injection in `src/tools/registry.ts` | still backs active external MCP tool execution inside the Bun worker | MCP resource browsing, reads, and subscriptions were removed, but injected `mcp__<server>__<tool>` execution remains a live TS runtime surface |
| `src/services/ral/**` | still part of the active Bun execution/delegation/injection model | not a dead daemon shim; still used by execution flows |
| `src/events/runtime/LocalInboundAdapter.ts` | adapter/test/runtime contract boundary, not just dead control-plane residue | still part of runtime-contract/test surface |
| `src/events/runtime/RecordingRuntimePublisher.ts` | compatibility/test helper, still useful while the worker protocol remains under active migration | still part of runtime-contract/test surface |

## What This Means For Future Cleanup

The highest-value remaining TS cleanup is no longer "delete `src/daemon`". That work is already done.

The remaining cleanup categories are:

1. reduce `getProjectContext()` dependence so the Bun worker depends on explicit execution inputs rather than broad ambient TS runtime state
2. re-home or replace TS-owned transport/chat-context persistence still read during prompt/tool assembly
3. keep MCP tool execution only for now; if resource browsing or subscriptions return later, reintroduce them as an explicit future design rather than reviving the deleted TS paths
4. only then re-evaluate whether runtime-coupled helpers like `LocalInboundAdapter`, `RecordingRuntimePublisher`, or parts of `services/ral` are truly removable

## Practical Validation Gates

Any future TypeScript-removal batch should still use:

- `bun run typecheck`
- `bun test`
- `bun run lint`
- `bun run lint:architecture`
- `scripts/rust-daemon-quality-gates.sh`

For migration-boundary removals, the Rust worker/runtime interop gates matter more than static search alone.

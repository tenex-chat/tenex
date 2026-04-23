# TypeScript Daemon Deletion Inventory

This document is an inventory, not a deletion plan. It assumes the target architecture described in `docs/rust/agent-execution-worker-migration.md`: Rust is the always-on daemon/control plane, and Bun/TypeScript is execution-only worker code plus the shared runtime contracts the worker still needs.

The classification below is based on local file inspection and import search. Where a file is shared between the worker and the old daemon surface, it is marked ambiguous until the Rust worker-spine and end-to-end gates prove the TS path is no longer required.

## Deleted Daemon / Control-Plane Modules

These files were old TS daemon/control-plane code rather than execution support. They have been deleted from the Rust-daemon branch; Bun/TypeScript keeps only worker execution and shared runtime contracts.

| File | Removed responsibility |
| --- | --- |
| `src/services/dispatch/AgentDispatchService.ts` | Legacy inbound routing, delegation completion, kill wake-up, and message injection coordination. |
| `src/services/dispatch/AgentRouter.ts` | Routing helpers for delegation completion and agent-target selection. |
| `src/services/dispatch/DelegationCompletionHandler.ts` | Delegation completion recognition and RAL recording for the TS daemon path. |
| `src/services/agents/AgentConfigUpdateService.ts` | Kind `24020` agent config event interpretation for TS daemon event handling. |
| `src/services/agents/ProjectMembershipPublishService.ts` | Project membership sync and publish helper. |
| `src/services/ingress/ChannelSessionStoreService.ts` | Persistent channel-session state for old transport handling. |
| `src/events/runtime/diagnostic-event-snapshot.ts` | Runtime diagnostic snapshot builder for TS daemon diagnostics. |
| `src/nostr/AgentEventDecoder.ts` daemon/routing helpers and tests | Legacy TS daemon event classification (`classifyForDaemon`, never-route helpers, project/config/boot classification helpers) plus unused routing/tag helpers that were only re-exported through `src/nostr/index.ts`. Rust owns relay classification in `crates/tenex-daemon/src/nostr_classification.rs`; TypeScript keeps only worker-needed Nostr tag helpers. |

## Must Remain for Bun Worker Execution

These modules are part of the worker runtime, worker protocol, or execution-time support. They should stay until the worker entrypoint and the execution stack no longer depend on them.

| Scope | Must remain |
| --- | --- |
| Worker entrypoint and protocol | `src/agents/execution/worker/agent-worker.ts`, `src/agents/execution/worker/bootstrap.ts`, `src/agents/execution/worker/protocol.ts`, `src/agents/execution/worker/protocol-emitter.ts`, `src/agents/execution/worker/publisher-bridge.ts`, `src/events/runtime/AgentWorkerProtocol.ts`, `src/events/runtime/InboundEnvelope.ts` |
| Execution core | `src/agents/execution/AgentExecutor.ts`, `src/agents/execution/ExecutionContextFactory.ts`, `src/agents/execution/StreamSetup.ts`, `src/agents/execution/StreamExecutionHandler.ts`, `src/agents/execution/StreamCallbacks.ts`, `src/agents/execution/ToolEventHandlers.ts`, `src/agents/execution/ToolExecutionTracker.ts`, `src/agents/execution/ToolOutputTruncation.ts`, `src/agents/execution/ToolSupervisionWrapper.ts`, `src/agents/execution/MessageCompiler.ts`, `src/agents/execution/MessageSyncer.ts`, `src/agents/execution/PostCompletionChecker.ts`, `src/agents/execution/RALResolver.ts`, `src/agents/execution/ProgressMonitor.ts`, `src/agents/execution/request-preparation.ts`, `src/agents/execution/context-management/**`, `src/agents/execution/prompt-history.ts`, `src/agents/execution/prompt-cache.ts`, `src/agents/execution/system-reminders.ts`, `src/agents/execution/skill-reminder-renderers.ts`, `src/agents/execution/types.ts`, `src/agents/execution/utils.ts`, `src/agents/execution/ToolResultUtils.ts` |
| Nostr publish path | `src/nostr/AgentPublisher.ts`, `src/nostr/AgentEventEncoder.ts`, `src/nostr/NostrInboundAdapter.ts`, `src/nostr/RustPublishOutbox.ts`, `src/nostr/trace-context.ts`, `src/nostr/AgentPublishError.ts` |
| Tool surface | `src/tools/registry.ts`, `src/tools/implementations/**` |
| Worker support services | `src/services/ConfigService.ts`, `src/services/LLMOperationsRegistry.ts`, `src/services/CooldownRegistry.ts`, `src/services/projects/**`, `src/services/mcp/**`, `src/services/skill/**`, `src/services/analysis/**`, `src/services/ingress/TransportBindingStoreService.ts`, `src/services/telegram/TelegramChatContextStoreService.ts`, `src/services/agents/AgentProvisioningService.ts`, `src/services/agents/AgentResolution.ts`, `src/services/agents/EscalationService.ts`, `src/agents/**`, `src/conversations/**`, `src/llm/**` |
| Shared runtime contracts | `src/events/runtime/AgentRuntimePublisher.ts`, `src/events/runtime/AgentRuntimePublisherFactory.ts`, `src/events/runtime/RuntimeAgent.ts`, `src/events/runtime/LocalInboundAdapter.ts`, `src/events/runtime/RecordingRuntimePublisher.ts` |

## Ambiguous Items Requiring E2E Verification

These are not safe to delete just because they smell like daemon code. They are shared with execution-time behavior, test fixtures, or migration-only compatibility paths.

| File / area | Why it is ambiguous | Verify with |
| --- | --- | --- |
| `src/services/ral/**` | The worker still depends on in-process RAL state for claim transfer, delegation, injections, kill behavior, and runtime accounting. Some of this may eventually move to Rust, but not all of it is daemon-only today. | Worker protocol smoke tests, delegation completion tests, kill-cascade tests, and any Rust worker-spine test that exercises resumption and injection handoff. |
| `src/events/runtime/envelope-classifier.ts` | Shared by conversation resolution, diagnostics, and routing code. It is part runtime contract, part old routing helper. | Conversation-resolution E2E and any Rust ingress tests that prove TS no longer needs the helper. |
| `src/events/runtime/LocalInboundAdapter.ts` | Test/gateway adapter for constructing canonical inbound envelopes. | Remove only if test coverage no longer needs the adapter or Rust owns the corresponding adapter path. |
| `src/events/runtime/RecordingRuntimePublisher.ts` | Test-only publisher, but still useful for branch-safe execution and protocol validation. | Delete only after tests stop consuming it or an equivalent fixture is moved elsewhere. |
| `src/services/ingress/TransportBindingStoreService.ts` | It looks transport/control-plane-ish, but the worker prompt/tool surface still reads it for `send_message` and project context. | `tools/registry` and prompt-context E2E, especially `send_message` and project-context rendering. |
| `src/services/telegram/TelegramChatContextStoreService.ts` | The Rust telegram gateway owns live ingress, but the worker still consumes chat context for prompt assembly and related execution flows. | Worker prompt/context E2E and Telegram-related execution tests. |

## Suggested Deletion Order and Gates

1. Remove the compatibility/test scaffolding only after the worker and protocol test suites have been reshaped:
   `src/events/runtime/RecordingRuntimePublisher.ts`, `src/events/runtime/LocalInboundAdapter.ts`, and any fixtures that become dead after the worker/daemon split settles.
   Gate: test migration completed, not just production parity.

2. Defer `src/services/ral/**` until last.
   This tree is shared with worker execution, so it should only be deleted if the Rust side has taken over the full claim/resume/injection/kill model and the Bun worker no longer needs local RAL state.
   Gate: full worker-spine E2E, including delegation, injections, aborts, and warm-reuse behavior.

## Practical Gate Set

Use the existing repo gates before and after each removal batch:

- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun run lint:architecture`
- `scripts/rust-daemon-quality-gates.sh`

For migration-sensitive removals, also run the targeted Rust interop gates already encoded in `scripts/rust-daemon-quality-gates.sh`, especially the worker protocol probe, real worker execution, publish interop, and daemon worker runtime spine checks.

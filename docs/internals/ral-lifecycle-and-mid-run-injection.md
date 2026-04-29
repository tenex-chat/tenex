---
title: "RAL Lifecycle And Mid-Run Injection"
date: "2026-04-29"
audience: "llms"
scope: "How the TypeScript runtime creates, resumes, preempts, and clears RALs, and how user messages are injected while an agent is already running."
status: "investigated"
related_docs:
  - "docs/DELEGATION-AND-RAL-PROCESSING.md"
  - "docs/SUPERVISION.md"
---

# RAL Lifecycle And Mid-Run Injection

## Question

How does the TypeScript TENEX runtime manage a RAL's lifecycle, and what exactly happens when a new user message arrives while the target agent is already in the middle of a run?

## Short Answer

A RAL is the runtime's per-agent, per-conversation execution slot. `RALRegistry` owns volatile orchestration state: numbered RAL entries, queued injections, pending and completed delegations, active tools, abort controllers, driver ownership, and resumption claims. `ConversationStore` owns durable transcript state: messages, delegation markers, and a persisted active-RAL index used to hide messages from other active RALs and reconcile daemon restarts.

Mid-run user delivery is decided in `AgentDispatchService.handleDeliveryInjection()`. If the existing RAL still owns the driver slot, the message is queued onto that RAL and TENEX optionally delivers it to a live provider-side injector. If the existing RAL is streaming but has released the driver because a tool is running, TENEX creates a fresh concurrent RAL and gives that new RAL the driver. If the existing RAL is idle, TENEX queues the message and atomically claims that RAL for one resumption execution.

## System Map

`RuntimeIngressService` is the transport-neutral ingress seam. It remembers identities and forwards `InboundEnvelope` objects to `AgentDispatchService`.

`AgentDispatchService` performs conversation resolution, target-agent selection, delegation-completion routing, and mid-run injection decisions. Its `handleDeliveryInjection()` method is the critical routing branch for incoming user messages when a RAL already exists.

`AgentExecutor` is the per-agent execution orchestrator. It calls `resolveRAL()`, prepares runtime context, runs `StreamSetup`, delegates streaming to `StreamExecutionHandler`, then decides whether to publish `conversation()` or `complete()` based on `RALRegistry.hasOutstandingWork()`.

`RALRegistry` is a facade over focused in-memory registries:

- `RALStateRegistry` owns live RAL entries, RAL numbering, streaming flags, driver ownership, active tools, abort controllers, resumption claims, silent-completion flags, and TTL cleanup.
- `MessageInjectionQueue` owns queued user/system injections stored on a live RAL entry.
- `DelegationRegistry` owns pending/completed delegation maps and delegation-id to parent-RAL lookup.
- `KillSwitchRegistry` owns abort, cascade, killed-delegation, and implicit parent-wake behavior.
- `ExecutionTimingTracker` tracks accumulated LLM runtime per RAL.

`ConversationStore` persists canonical conversation history. During stream setup, the executor calls `ensureRalActive()`. When a RAL is truly done, it calls `completeRal()`. `buildMessagesForRal()` uses the active-RAL set to hide messages from other active RALs while keeping completed-RAL history visible.

`LLMOperationsRegistry` tracks active LLM requests and optional provider-side `MessageInjector`s. Codex app-server sessions expose an injector through `onStreamStart`; `StreamSetup` registers it in this registry.

## Runtime Flow

### New Agent Execution

1. A transport adapter turns an inbound event into an `InboundEnvelope`.
2. `RuntimeIngressService.handleChatMessage()` records principal metadata and calls `AgentDispatchService.dispatch()`.
3. The dispatcher resolves or creates the conversation, adds the inbound envelope to `ConversationStore` unless it is a duplicate or internal agent event, chooses the target agent, and calls `dispatchToAgent()`.
4. `dispatchToAgent()` calls `handleDeliveryInjection()` before creating a new execution context. With no active RAL, it proceeds normally.
5. `AgentExecutor.execute()` calls `resolveRAL()`. If no resumable or injectable RAL exists, `RALStateRegistry.create()` creates the next numbered RAL for `(agentPubkey, conversationId)`.
6. `StreamSetup.setupStreamExecution()` marks the RAL active in `ConversationStore`, consumes queued injections, persists consumed injections as user-role conversation messages, registers the LLM operation, and creates the provider service.
7. `StreamExecutionHandler.execute()` sets `isStreaming = true`, which also acquires the driver slot for that agent and conversation, starts runtime timing, and calls `llmService.stream()`.
8. Tool lifecycle events update RAL state. `tool-will-execute` calls `startTool()`, which records the active tool and releases the driver. `tool-did-execute` calls `finishTool()`, which reacquires the driver if possible.
9. After streaming, `AgentExecutor.executeOnce()` checks silent completion and `hasOutstandingWork()`, runs post-completion supervision, and publishes either `conversation()` while work remains or `complete()` when no work remains.
10. `cleanupRalAfterTurn()` clears the in-memory RAL and marks it complete in `ConversationStore` only when no queued injections, pending delegations, or completed delegations remain.

### Delegation Completion Resumption

Delegation tools register pending delegations immediately through `RALRegistry.mergePendingDelegations()`. The agent can continue running, but a final publish while delegations remain is treated as ordinary conversation output rather than a terminal completion.

When a delegate replies, `DelegationCompletionHandler.handleDelegationCompletion()` scans reply targets from newest to oldest, verifies that the sender matches the delegated recipient, and calls `RALRegistry.recordCompletion()`. `DelegationRegistry` moves the delegation from pending to completed unless the delegation was killed or still has pending sub-delegations. Sub-delegation completions can release a deferred parent completion.

The dispatcher then resumes the parent agent. If the parent RAL is actively streaming, it updates durable delegation markers and returns so the running stream can observe state later. Otherwise, it restores the original triggering envelope when available, creates execution context, and lets `resolveRAL()` choose the resumable RAL. `resolveRAL()` writes completed/aborted delegation markers into the parent `ConversationStore`, then clears completed-delegation entries from `RALRegistry` so the same completion is not reprocessed.

### Mid-Run User Message Injection

`AgentDispatchService.handleDeliveryInjection()` branches on two fields that mean different things:

- `activeRal.isStreaming`: this RAL has an active stream handler.
- `RALRegistry.getDriver(agent, conversation)`: which RAL currently owns the right to make LLM calls for this `(agent, conversation)`.

The source shows three cases:

1. **Driver is held.** The existing RAL is between tool boundaries and actively driving an LLM call. TENEX queues the inbound user message onto that RAL and skips starting another execution. It then tries `LLMOperationsRegistry.getMessageInjector()`; if a provider injector exists and delivery succeeds, only the matching queued injection is cleared by event id. If live delivery fails or no injector exists, the queued injection remains for the next `prepareStep()`.
2. **Streaming RAL has no driver.** The existing RAL is inside tool execution. Because that RAL cannot safely receive the user's new intent before the tool returns, TENEX calls `tryCreateConcurrentRAL()`. That synchronously creates a fresh RAL, claims the driver for it, and returns a claim token. The new execution receives `preferredRalNumber` and `preferredRalClaimToken`.
3. **Idle RAL has no driver.** The RAL is not streaming, but it still has state worth preserving, such as queued injections or completed delegations. TENEX queues the message onto that exact RAL and calls `tryAcquireResumptionClaim()`. One dispatcher wins and resumes the RAL. Losing concurrent dispatches leave their messages in the same queue and skip execution.

The claim token is dispatch-scoped because `createExecutionContext()` can fail before `AgentExecutor.execute()` starts. `StreamExecutionHandler.execute()` clears the claim with `handOffResumptionClaimToStream()` immediately after setting `isStreaming = true`. The dispatch `finally` block releases the claim only if it still matches; for a fresh-spawn concurrent RAL that never started streaming, it also clears that RAL to release the driver.

## State And Data

`RALRegistryEntry` is in-memory only. It includes the RAL id and number, agent pubkey, project d-tag, conversation id, queued injections, streaming state, execution claim token, active tool map, original triggering event id, trace ids, runtime counters, silent-completion flag, and heuristic state. RAL state expires after 24 hours of inactivity.

The driver slot is per `(agentPubkey, conversationId)`, not per RAL. It serializes LLM-driving work while still allowing a tool-running RAL to be preempted by a new RAL. This is the core concurrency invariant behind lock handoff.

Queued injections are per RAL and carry content, role, original sender pubkey, transport principal snapshots, target principal snapshots, and source event id. Consumption is destructive: `getAndConsumeInjections()` returns a copy and empties the queue.

`ConversationStore.activeRal` is durable and separate from `RALRegistry`. It is used for prompt visibility and startup reconciliation, not for live orchestration. `ProjectRuntime.reconcileOrphanedRals()` loads only conversations listed in `active-rals.json`; if a durable active RAL has no in-memory registry entry after daemon restart, it appends an interruption note and marks that RAL complete.

Delegation state is in-memory in `DelegationRegistry`, keyed by parent `(agent, conversation)` and indexed by delegation event id. The durable transcript representation is a `delegation-marker` in `ConversationStore`; marker expansion happens when building prompt messages.

## Contracts And Invariants

Only one RAL may hold the driver for a given `(agent, conversation)` at a time. `setStreaming(true)` acquires it; `setStreaming(false)` releases it; `startTool()` releases it; `finishTool()` reacquires it or reports preemption.

A dispatcher that pre-claims a RAL must either release the claim on early failure or hand it off to a stream after `isStreaming` becomes true. The preferred RAL number must be threaded into `resolveRAL()`; otherwise first-match lookup can resume a different RAL than the one the dispatcher claimed.

Queued injections must be persisted into `ConversationStore` before building prompt messages. `StreamSetup` does this for initial setup, and `StreamCallbacks.prepareStep()` repeats it before each later LLM step.

Tool-call and tool-result adjacency must be preserved for AI SDK validation. `MessageBuilder` defers user messages and delegation markers that appear between a tool call and its result, then flushes them after the result.

Final completion is allowed only when `hasOutstandingWork()` is false. If work remains, visible agent text is published as a conversation message. Empty text with outstanding work causes the executor to defer finalization.

`no_response` and lock-handoff preemption use the same silent-completion flag. Silent completion is honored only when the final message is empty; if visible text was produced, the flag is cleared and ignored.

## Failure And Recovery

If two user messages race against the same idle RAL, `tryAcquireResumptionClaim()` serializes resumption. The winner runs; the loser only queues its message. `src/services/dispatch/__tests__/concurrent-message-race.test.ts` captures this production race.

If a user message arrives while a RAL is mid-tool, the new concurrent RAL can become the driver. When the original tool finishes, `finishTool()` returns `preempted`; `ToolEventHandlers` requests silent completion so the old stream exits without publishing an empty completion. Its tool result is already persisted and becomes visible to later prompt construction.

If live provider injection succeeds, the matching queued injection is removed by event id. If live injection fails, the queue remains. This preserves correctness for providers without injection support but means delivery waits for a later `prepareStep()` or later resumption.

If the daemon restarts, in-memory `RALRegistry` state is gone. Durable `ConversationStore.activeRal` entries are reconciled as interrupted work, not resumed. This source-visible behavior means pending in-memory delegation and injection queues do not survive restart.

Killed delegations reject later completions. Cascading abort marks pending delegations killed, aborts active LLM operations, writes an abort message into the conversation, creates aborted completion entries for parent wake-up, and dispatches a synthetic local kill wake-up that deliberately bypasses normal user-injection paths.

## Observability

Important RAL span events include `ral.created`, `ral.resumption_claim_acquired`, `ral.resumption_claim_handed_off`, `ral.concurrent_ral_created`, `ral.tool_started`, `ral.tool_completed`, `ral.injection_queued`, `ral.injections_consumed`, `ral.outstanding_work_detected`, `ral.cleared`, `ral.completion_recorded`, and `ral.completion_deferred_pending_subdelegations`.

Important dispatch events include `dispatch.injection_stream_no_abort_skip_execution`, `dispatch.injection_live_delivered`, `dispatch.lock_handoff_spawn_acquired`, `dispatch.lock_handoff_spawn_lost`, `dispatch.injection_resumption`, `dispatch.injection_resumption_claim_lost`, `dispatch.delegation_completion_routed`, and `dispatch.delegation_markers_inserted_for_active_stream`.

Important executor events include `executor.ral_resumed`, `executor.ral_resumed_for_injection`, `executor.initial_injections_consumed`, `ral_injection.process`, `executor.outstanding_work_decision`, `executor.publish`, `executor.preempted_by_concurrent_ral`, `executor.silent_completion_honored`, and `executor.ral_cleared_post_supervision_check`.

Useful tests:

- `src/services/ral/__tests__/RALRegistry.test.ts` covers queue consumption, delegation recording, cleanup, and driver lock-handoff.
- `src/services/dispatch/__tests__/AgentDispatchService.test.ts` covers live injection queue clearing and failed delivery.
- `src/services/dispatch/__tests__/concurrent-message-race.test.ts` covers idle-RAL resumption claims.
- `src/agents/execution/__tests__/delegation-race-condition.test.ts` covers outstanding-work finalization guards.
- `src/llm/providers/agent/__tests__/CodexProvider.test.ts` covers Codex `injectMessage()` registration through provider session startup.

## Source Guide

Read `src/services/dispatch/AgentDispatchService.ts` for the authoritative routing and injection decision tree.

Read `src/services/ral/RALStateRegistry.ts` for RAL creation, driver ownership, resumption claims, lock handoff, active tools, cleanup, and outstanding-work checks.

Read `src/services/ral/DelegationRegistry.ts` for pending/completed delegation transitions, sub-delegation deferral, killed-delegation handling, and implicit kill wake targets.

Read `src/agents/execution/RALResolver.ts` for how an executor chooses a resumable, injectable, or new RAL, and why preferred RAL numbers must be honored.

Read `src/agents/execution/StreamSetup.ts` and `src/agents/execution/StreamCallbacks.ts` for where queued injections become durable prompt messages.

Read `src/agents/execution/ToolEventHandlers.ts` for tool start/finish state transitions and preemption behavior.

Read `src/agents/execution/AgentExecutor.ts` for finalization, supervision re-engagement, publish mode, silent completion, and RAL cleanup.

Read `src/conversations/ConversationStore.ts` and `src/conversations/MessageBuilder.ts` for durable active-RAL tracking, prompt visibility, delegation-marker expansion, and tool-call/result ordering.

Read `src/services/LLMOperationsRegistry.ts` and `src/llm/providers/agent/CodexProvider.ts` for provider-side live injection support.

## Open Questions

The source proves that queued injection survives failed live delivery, but it does not prove that every provider path will promptly reach another `prepareStep()` after a message arrives during a single-step text-only response. For non-injecting providers, a queued message can therefore remain pending until a later resumption trigger.

Delegation and injection queues are in-memory. The durable active-RAL reconciliation path marks interrupted RALs as incomplete after restart rather than reconstructing pending work. That appears intentional in the current TypeScript runtime, but future Rust runtime plans may change the ownership model.

---
title: "Delegation Runtime"
date: "2026-04-29"
audience: "llms"
scope: "How TENEX agents create delegated work, route completions, resume parent RALs, and represent delegation state in the current TypeScript runtime, with Rust intent-path notes where they affect the shared protocol."
status: "investigated"
related_docs:
  - "docs/DELEGATION-AND-RAL-PROCESSING.md"
  - "docs/internals/ral-lifecycle-and-mid-run-injection.md"
  - "docs/SUPERVISION.md"
  - "docs/RUST-AGENT-SPEC.md"
confidence: "high for the TypeScript runtime, medium for Rust parity"
---

# Delegation Runtime

## Question

How does TENEX represent a delegated task, route it to another agent, wait for it, resume the delegating agent, and keep the prompt/history coherent across normal delegation, followups, self-delegation, cross-project delegation, and `ask`?

## Short Answer

In the current TypeScript runtime, a delegation is a fresh kind:1 Nostr event from the delegating agent to the delegatee. It p-tags the delegatee, has no root `e` tag, and is treated as the root of the child conversation. `AgentPublisher.delegate()` also adds a `delegation` tag pointing back to the parent conversation so the child conversation can build a delegation chain.

The parent RAL does not end when the tool publishes the delegation. The tool immediately registers a `PendingDelegation` in `RALRegistry`, while `PendingDelegationsRegistry` holds the published event id long enough for `ToolExecutionTracker` to add a q-tag to the delayed tool-use event. The executor may keep streaming, but final completion is blocked while pending or completed delegation work remains.

When the delegatee completes, it publishes a kind:1 reply in the child conversation with `status=completed`. `DelegationCompletionHandler` scans the reply's `e` tags, verifies that the sender is the expected recipient, and asks `RALRegistry.recordCompletion()` to move the parent state from pending to completed. `AgentDispatchService` then resumes the parent RAL, inserts delegation markers into `ConversationStore`, and the parent agent sees the delegated result in its next prompt.

The older `docs/DELEGATION-AND-RAL-PROCESSING.md` is still useful background, but its "delegate returns `StopExecutionSignal` and stops the loop" path is stale for the current TypeScript tool implementation. The source now registers pending delegations directly from the delegation tools and returns an ordinary tool result.

## System Map

`src/tools/implementations/delegate.ts` is the normal delegation tool. It resolves agent slugs before team names, blocks circular delegation unless `force` is set, publishes through `AgentPublisher.delegate()`, and registers the resulting event id as a pending delegation on the current RAL.

`src/tools/implementations/self_delegate.ts` publishes a delegation to the current agent's own pubkey. It can request a meta-model variant. `src/tools/registry.ts` hides `self_delegate` when the triggering principal is already linked to the same agent, preventing chained self-delegation loops.

`src/tools/implementations/delegate_followup.ts` sends additional context to an existing delegation. It accepts 10-character prefixes and 64-character ids, canonicalizes followup ids back to the original delegation id, publishes a followup event with an `e` tag to the delegation root, and merges followup metadata into the same pending delegation record.

`src/tools/implementations/delegate_crossproject.ts` publishes a p-tagged event to an agent in another project and registers the pending state as type `external`. It uses the target project's `a` tag, while the local parent still tracks the delegation in its own RAL.

`src/tools/implementations/ask.ts` uses the same pending-delegation machinery for human questions. It records pending entries of type `ask`, can escalate to an agent delegate, and registers ask/subdelegation relationships so a delegated child cannot complete its parent while human input is still outstanding.

`src/nostr/AgentPublisher.ts` and `src/nostr/AgentEventEncoder.ts` define the wire contract. They publish delegation, ask, followup, conversation, completion, and tool-use events. Tool-use q-tags are delayed until after the delegation event id is known.

`src/conversations/services/ConversationResolver.ts`, `src/utils/delegation-chain.ts`, and `src/services/event-context/EventContextService.ts` build and use delegation chains. The chain controls circular-delegation checks, system reminders, and completion recipient selection.

`src/services/dispatch/DelegationCompletionHandler.ts`, `src/services/dispatch/AgentDispatchService.ts`, and `src/services/dispatch/AgentRouter.ts` route completed child work back to the waiting parent agent and conversation.

`src/services/ral/RALRegistry.ts` and `src/services/ral/DelegationRegistry.ts` own volatile live state: pending delegations, completed delegations, id canonicalization, sub-delegation deferral, kill handling, and "which RAL is waiting for this event id" lookup.

`src/agents/execution/RALResolver.ts`, `src/agents/execution/AgentExecutor.ts`, `src/agents/execution/ToolEventHandlers.ts`, `src/agents/execution/MessageCompiler.ts`, and `src/agents/execution/system-reminders.ts` make delegation state visible to the LLM and decide whether the parent agent should publish an intermediate message or a final completion.

## Runtime Flow

### Starting A Delegation

1. Tool availability is filtered before the LLM sees tools. `self_delegate` is a core injected tool, but `src/agents/constants.ts` restricts `delegate`, `delegate_crossproject`, and `delegate_followup` by agent category: domain experts get only `ask`, workers get `ask` plus `delegate_followup`, and coordinator-style agents get the full delegation set.
2. The agent calls `delegate` with a recipient and prompt. The tool resolves a recipient pubkey, checks the current conversation's delegation chain for circular delegation, and calls `context.agentPublisher.delegate()`.
3. `AgentPublisher.delegate()` publishes a kind:1 event with a p-tag for the recipient, optional `branch`, `team`, and `variant` tags, standard project/runtime/model tags, and a `delegation` tag pointing at the parent conversation id. It also registers the delegation event id in `PendingDelegationsRegistry` for q-tag correlation.
4. The tool registers a `PendingDelegation` on the current RAL with `RALRegistry.mergePendingDelegations()`. The delegation event id is the child conversation id and the canonical key for completion matching.
5. `ToolExecutionTracker.completeExecution()` later consumes `PendingDelegationsRegistry` and publishes the delayed tool-use event with q-tags that reference the delegation event ids produced by this tool call.

### Creating The Child Conversation

When the delegatee receives the p-tagged delegation event, `ConversationResolver` treats it as a new conversation because it has no reply target. The `delegation` tag links that child conversation to the parent conversation. `buildDelegationChain()` copies the parent chain and appends the current delegatee, so the child prompt knows who delegated to whom.

The chain entries are semantic participants from origin to current delegatee. Each entry carries the conversation id where that participant was delegated. This is why circular checks can reject delegation to an agent already in the chain, while self-delegation remains allowed for the delegating agent's own fresh child run.

### Waiting Without Ending The Parent RAL

The parent RAL may continue after a delegation tool result. At the end of a streaming pass, `AgentExecutor` checks `RALRegistry.hasOutstandingWork()`. Pending delegations, completed delegations not yet shown to the parent, queued injections, and active tools all count as outstanding work.

If there is visible text but outstanding work remains, the executor publishes `agentPublisher.conversation()` instead of `complete()`. That creates an ordinary intermediate message without `status=completed`. If there is no visible text and outstanding work remains, the executor leaves the RAL active and does not publish a final frame. `cleanupRalAfterTurn()` clears the RAL only when outstanding work is gone and the turn did not start with pending delegations.

### Completing And Resuming

The delegatee's final answer is published by `AgentPublisher.complete()`. `createEventContext()` pre-resolves the completion recipient from the delegation chain, so the completion p-tags the immediate delegator rather than always p-tagging the original user.

`AgentDispatchService.handleReplyLogic()` checks delegation completion before ordinary delivery. `DelegationCompletionHandler` scans reply targets from newest to oldest because threaded Nostr replies can include multiple `e` tags. For the first pending delegation match, it verifies that the event sender equals the recorded `recipientPubkey`.

`RALRegistry.recordCompletion()` canonicalizes the id, rejects killed delegations, and moves the record from pending to completed. If the pending delegation has unresolved sub-delegations, it stores a deferred completion and returns `deferred: true` instead of waking the parent yet.

After a normal record, the dispatcher debounces parent wake-up briefly so multiple completions can batch. If the parent RAL is currently streaming, the dispatcher only updates delegation markers and lets the live stream observe state later. Otherwise it restores the original triggering envelope when possible, resolves the parent agent with `AgentRouter`, and calls `AgentExecutor.execute()`.

On resumed execution, `RALResolver` chooses the resumable RAL, reads completed and pending delegation state, writes `DelegationMarker` records into the parent `ConversationStore`, and clears completed entries from `RALRegistry` so the same child response is not reprocessed.

### Prompt Reconstruction

`ConversationStore` keeps durable delegation markers. A pending marker says "delegation in progress"; a completed or aborted marker points at the child conversation and completion state. `ConversationStore.updateDelegationMarker()` appends the completed/aborted marker idempotently rather than mutating the pending marker away.

`MessageBuilder` expands markers during prompt construction. Direct child delegation markers expand the child transcript enough for the parent to see the delegated work. Nested markers are represented as minimal references to avoid exponential prompt growth. Deferred marker ordering also preserves AI SDK tool-call/tool-result adjacency.

`system-reminders.ts` separately tells the agent which delegations are pending or completed and directs followup context through `delegate_followup`, not by addressing the delegatee in normal prose.

## Variants

`delegate_followup` does not create a new child conversation. It publishes a reply-like event to the original delegation root and registers a pending record with `type: "followup"` plus `followupEventId`. `DelegationRegistry` maps both the followup event id and the canonical delegation id back to the same pending delegation so either id can be used for completion matching and user-facing prefixes.

`self_delegate` uses the normal delegation path but targets the same agent pubkey. Its child conversation is still separate, so it is useful for focused sub-work or model variant isolation. The tool registry prevents a self-delegated child from self-delegating again by hiding the tool in that context.

`delegate_crossproject` targets another project by adding the target project's `a` tag and the target agent's p-tag. The local parent RAL still records the pending delegation. Completion routing therefore depends on the normal Nostr reply tags plus the local waiting RAL still existing.

`ask` is modeled as a delegation to a human or escalation agent. Direct human-triggered runs skip escalation. If an ask happens inside a delegated child, `registerPendingSubDelegation()` attaches the ask to the parent delegation. A child completion that arrives before the human answer is deferred until the ask completes, then the stored parent completion is released.

## State And Data

`PendingDelegation` lives in `src/services/ral/types.ts`. Important fields are `delegationConversationId`, `recipientPubkey`, `senderPubkey`, `prompt`, `ralNumber`, optional `type`, optional `followupEventId`, optional `projectId`, optional `parentDelegationConversationId`, optional `pendingSubDelegations`, and optional killed/deferred-completion metadata.

`CompletedDelegation` records the delegation id, recipient, prompt, transcript, completion time, RAL number, and `status` of `completed` or `aborted`. Completed records stay in RAL state until `RALResolver` converts them into conversation markers and clears them.

`DelegationMarker` is the durable conversation-history representation. It is stored in `ConversationStore`, not `RALRegistry`, and is what prompt history uses after live RAL state has been consumed.

`delegationChain` is conversation metadata. It is built when a p-tagged delegation creates a child conversation and is later used for response routing reminders, circular-delegation checks, and completion recipient selection.

`PendingDelegationsRegistry` is only a q-tag bridge. It is keyed by parent agent and conversation, receives event ids from `AgentPublisher.delegate()`/`ask()`/cross-project publishing, and is consumed by `ToolExecutionTracker` when the delayed tool-use event is published.

## Contracts And Invariants

The delegation event id is the child conversation id. Followups may have their own event ids, but the original delegation id remains canonical for the pending work item.

A fresh delegation has a p-tag recipient and no root `e` tag. A followup has an `e` tag to the delegation root. A completion has an `e` tag that lets the parent match the pending delegation and `status=completed` so dispatch can classify it as a completion.

Only the recorded recipient pubkey may satisfy a pending delegation. Completions from other senders are ignored.

The parent RAL must not be cleared while it has pending delegations or completed delegations not yet injected into the parent prompt. This is enforced through `hasOutstandingWork()` and `cleanupRalAfterTurn()`.

Delegation tool-use events must be delayed until after the delegation event is published, otherwise the tool-use event cannot include q-tags referencing the child event id.

A child delegation with pending sub-delegations cannot complete its parent. `DelegationRegistry` stores the completion as deferred and releases it only when all child sub-delegations clear.

Prompt expansion must avoid recursive transcript blow-up. Direct child markers may expand full text transcript; nested delegation markers stay as references.

## Failure And Recovery

Publish failure surfaces as an `AgentPublishError`; `AgentPublisher.safePublish()` is the retry/failure-notification path behind the publishing methods.

If a completion arrives without a waiting RAL, `AgentDispatchService` logs `reply.completion_dropped_no_waiting_ral` and does not route it to normal chat delivery. This can happen when live in-memory RAL state is missing.

If a sender does not match the pending delegation's `recipientPubkey`, `DelegationCompletionHandler` skips that reply target and continues scanning. This prevents unrelated threaded replies from satisfying the delegation.

Killed delegations reject later completions. Kill handling can also create an aborted completed-delegation record and a synthetic local wake-up so the parent agent observes that the child was aborted.

The TypeScript RAL delegation registry is in-memory. Conversation markers and delegation chains are durable once written, but pending/completed live waiting state is not reconstructed from Nostr events after a daemon restart in the source reviewed here. The Rust side has a SQLite conversations schema with delegation-oriented data, but the richer TypeScript RAL orchestration model is not fully mirrored there yet.

## Observability

Important RAL and dispatch span events include `ral.delegations_merged`, `ral.completion_recorded`, `ral.completion_deferred_pending_subdelegations`, `ral.deferred_completion_released`, `dispatch.delegation_completion_routed`, `dispatch.delegation_completion_deferred`, `dispatch.delegation_markers_inserted_for_active_stream`, `executor.ral_resumed`, `executor.outstanding_work_decision`, and `executor.publish`.

Important logs and error events include `[delegate_followup] Canonicalized followup ID`, `[delegate_followup] Publishing follow-up`, `[self_delegate] Published self-delegation`, `[RALRegistry.recordCompletion] Rejected completion - delegation was killed`, and `reply.completion_dropped_no_waiting_ral`.

Useful tests:

- `src/tools/implementations/__tests__/delegate-tool-validation.test.ts` covers direct pending registration, concurrent merge safety, circular delegation checks, and followup id canonicalization.
- `src/services/ral/__tests__/delegation-flow.test.ts` covers e-tag matching, killed completions, full pending-to-completed lifecycle, and deferred parent completion while ask sub-delegations are pending.
- `src/services/ral/__tests__/RALRegistry.test.ts` covers lower-level completion recording, followup aliasing, killed delegation invariants, and sub-delegation release.
- `src/agents/execution/__tests__/delegation-race-condition.test.ts` covers parent finalization guards when delegation completion races with executor cleanup.
- `src/event-handler/__tests__/reply.delegation-completion-routing.test.ts` asserts that completion wake-up decisions belong in dispatch/RAL, not the generic event handler.
- `scripts/tenex-runtime-probe-scenarios.ts` and `scripts/tenex-runtime-probe-verdicts.ts` include `delegation-basic`, an end-to-end runtime probe that expects PM delegation, delegate tool publication, worker execution, PM observation of worker completion, and a final `status=completed` frame.

## Source Guide

Read `src/tools/implementations/delegate.ts`, `self_delegate.ts`, `delegate_followup.ts`, `delegate_crossproject.ts`, and `ask.ts` for tool-level behavior and what each variant registers.

Read `src/nostr/AgentPublisher.ts`, `src/nostr/AgentEventEncoder.ts`, and `src/nostr/NostrInboundAdapter.ts` for event tags, q-tags, completion tags, and inbound metadata extraction.

Read `src/conversations/services/ConversationResolver.ts`, `src/utils/delegation-chain.ts`, and `src/services/event-context/EventContextService.ts` for child conversation creation, delegation-chain construction, circular checks, and completion recipient resolution.

Read `src/services/ral/DelegationRegistry.ts`, `src/services/ral/RALRegistry.ts`, `src/services/ral/PendingDelegationsRegistry.ts`, and `src/services/ral/types.ts` for live delegation state and transitions.

Read `src/services/dispatch/DelegationCompletionHandler.ts`, `src/services/dispatch/AgentDispatchService.ts`, and `src/services/dispatch/AgentRouter.ts` for completion detection, sender validation, debounced wake-up, and parent execution.

Read `src/agents/execution/RALResolver.ts`, `src/agents/execution/AgentExecutor.ts`, `src/agents/execution/ToolEventHandlers.ts`, `src/agents/execution/ToolExecutionTracker.ts`, `src/agents/execution/MessageCompiler.ts`, and `src/agents/execution/system-reminders.ts` for prompt-visible state and finalization behavior.

Read `src/conversations/ConversationStore.ts` and `src/conversations/MessageBuilder.ts` for durable markers and transcript expansion.

Read `crates/tenex-agent/src/tools/delegate.rs`, `delegate_followup.rs`, `self_delegate.rs`, `crates/tenex-protocol/src/intent.rs`, and `crates/tenex-protocol/src/nostr/encoder.rs` for the Rust intent path. Fresh Rust delegations carry the TypeScript-style `delegation` parent tag, and Rust `delegate_followup` emits an `e` root tag to the original delegation so the followup stays in the child conversation.

## Open Questions

Rust followup id lookup now resolves original delegation ids, 10-character prefixes, and prior followup event ids from the local conversation store. Cross-project or not-yet-indexed followups still need an explicit recipient because there is no local route to derive the delegatee from.

The TypeScript runtime's pending/completed delegation state is volatile. If restart-safe delegation recovery is a product requirement, source needs a persistence and replay path beyond durable conversation markers.

`docs/DELEGATION-AND-RAL-PROCESSING.md` should either be refreshed or explicitly marked historical because its `StopExecutionSignal` explanation no longer matches the current `delegate` tool.

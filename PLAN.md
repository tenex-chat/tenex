# Transport Layer Abstraction: Complete the Migration

## Goal
Make the core dispatch/conversation/execution pipeline consume `InboundEnvelope` directly, eliminating the `InboundEnvelopeEventBridge` and removing NDKEvent from all transport-agnostic code paths.

## Key Architectural Insight

There are **two distinct pipelines** that must be treated differently:

1. **Daemon pipeline** (stays NDKEvent): Nostr subscription → Daemon → `event-handler/index.ts` → `classifyForDaemon()`. These are raw Nostr protocol events (kind:0 metadata, kind:31933 project, kind:4129 lesson, etc.). This is Nostr-specific and correctly uses NDKEvent.

2. **Dispatch pipeline** (refactor to InboundEnvelope): Any transport → Adapter → `InboundEnvelope` → `RuntimeIngressService` → `AgentDispatchService` → `ConversationResolver` → `ConversationStore` → `ExecutionContext` → tools. This is the transport-agnostic pipeline where NDKEvent should not appear.

## Steps

### Step 1: Enrich InboundEnvelope metadata

**File:** `src/events/runtime/InboundEnvelope.ts`

Add semantic fields that the dispatch pipeline currently extracts from NDKEvent tags:

```typescript
metadata: {
    eventKind?: number;
    eventTagCount?: number;
    // New fields:
    toolName?: string;          // from "tool" tag — marks agent-internal messages
    statusValue?: string;       // from "status" tag — marks delegation completions
    branchName?: string;        // from "branch" tag — for worktree resolution
    articleReferences?: string[]; // from "a" tags starting with "30023:" — for referenced articles
    replyTargets?: string[];    // from "e" tags — all e-tag values (delegation completion needs multiple)
};
```

**Why `replyTargets` as array?** `DelegationCompletionHandler` iterates all e-tags in reverse to find which delegation a completion responds to. `message.replyToId` only holds one value. We need the full list on the envelope.

Update `NostrInboundAdapter` to populate these from NDKEvent tags. Other adapters (Telegram, Local) set them as appropriate (mostly undefined — non-Nostr transports don't produce tool/status/branch messages).

### Step 2: Split AgentEventDecoder

**Current:** Single class with both daemon-level and dispatch-level methods, all accepting NDKEvent.

**After:** Two concerns:

1. **`AgentEventDecoder`** (stays in `src/nostr/AgentEventDecoder.ts`) — Daemon-level methods only. These operate on raw NDKEvent from Nostr subscriptions:
   - `classifyForDaemon()`, `isNeverRouteKind()`, `isProjectEvent()`, `isLessonEvent()`, `isLessonCommentEvent()`
   - `isConfigUpdate()`, `isMetadata()`, `isStopCommand()`
   - `extractProjectId()`, `extractAgentDefinitionIdFromLesson()`
   - `hasProjectATags()`, `extractProjectATags()`

2. **New functions** in `src/events/runtime/envelope-classifier.ts` — Dispatch-level functions that accept `InboundEnvelope`:
   - `isDirectedToSystem(envelope, systemAgents)` — checks `envelope.recipients` against agent pubkeys
   - `isFromAgent(envelope, systemAgents)` — checks `envelope.principal.linkedPubkey` against agent pubkeys
   - `getReplyTarget(envelope)` — returns `envelope.message.replyToId`
   - `getMentionedPubkeys(envelope)` — returns pubkeys from `envelope.recipients`
   - `isAgentInternalMessage(envelope)` — checks `envelope.metadata.toolName` or `envelope.metadata.statusValue`
   - `isDelegationCompletion(envelope)` — checks `eventKind === 1 && statusValue === "completed"`
   - `getDelegationRequestId(envelope)` — returns first entry from `envelope.metadata.replyTargets`

Layer placement: `events/runtime/` is Layer 2, same as `nostr/`. No layer violation.

### Step 3: Refactor ConversationStore to accept InboundEnvelope

**Files:**
- `src/conversations/ConversationStore.ts`
- `src/conversations/ConversationRegistry.ts`

Changes:
- `ConversationStore.create(envelope: InboundEnvelope, ...)` instead of `create(event: NDKEvent, ...)`
  - Uses `envelope.message.nativeId` as conversation ID
  - Uses `envelope.principal`, `envelope.content`, `envelope.occurredAt`
- `ConversationStore.addEvent(id, envelope, ...)` instead of `addEvent(id, event, ...)`
  - Rename to `addEnvelopeMessage` for clarity
- `addEventMessage(envelope, isFromAgent, principalContext?)` refactored similarly
- `extractTargetedPubkeys` reads from `envelope.recipients` instead of p-tags
- `buildDefaultSenderPrincipal` reads from `envelope.principal` instead of `event.pubkey`
- Event cache (`cacheEvent`/`getCachedEvent`) stores `InboundEnvelope` instead of `NDKEvent`

### Step 4: Refactor ConversationResolver

**File:** `src/conversations/services/ConversationResolver.ts`

- `resolveConversationForEvent(envelope: InboundEnvelope, ...)` instead of NDKEvent
- Uses `envelope.message.replyToId` instead of `AgentEventDecoder.getReplyTarget(event)`
- Uses `envelope.recipients` instead of `AgentEventDecoder.getMentionedPubkeys(event)`
- `extractReferencedArticle` uses `envelope.metadata.articleReferences` and `envelope.channel.projectBinding`
- `buildDelegationChain` accepts envelope fields instead of NDKEvent
- Orphaned reply handling: `handleOrphanedReply` needs special consideration since it fetches events from the Nostr network — those are raw NDKEvents. We should convert fetched NDKEvents to InboundEnvelopes using `NostrInboundAdapter.toEnvelope()` before adding them to the conversation.

### Step 5: Refactor DelegationCompletionHandler

**File:** `src/services/dispatch/DelegationCompletionHandler.ts`

- `handleDelegationCompletion(envelope: InboundEnvelope)` instead of NDKEvent
- Uses `envelope.metadata.replyTargets` instead of `TagExtractor.getETags(event)`
- Uses `envelope.principal.linkedPubkey` instead of `event.pubkey` for sender validation
- Uses `envelope.content` instead of `event.content`
- `ConversationStore.addEvent` calls updated to use envelope

### Step 6: Refactor AgentRouter

**File:** `src/services/dispatch/AgentRouter.ts`

- `resolveTargetAgents(envelope, projectContext, conversation)` instead of NDKEvent
- Uses envelope-classifier functions instead of AgentEventDecoder
- `processStopSignal` and `unblockAgent` use `envelope.recipients` instead of p-tags and `envelope.principal` instead of `event.pubkey`

### Step 7: Refactor AgentDispatchService

**File:** `src/services/dispatch/AgentDispatchService.ts`

- `dispatch(envelope: InboundEnvelope, context)` — primary signature change
- Remove `NDKEvent` import
- All internal methods switch from `event: NDKEvent` to `envelope: InboundEnvelope`
- Telemetry attributes read from envelope fields
- Uses envelope-classifier functions for routing decisions
- `dispatchToAgents` passes envelope fields (`content`, `principal.linkedPubkey`, `message.nativeId`) to `handleDeliveryInjection`

### Step 8: Refactor ExecutionContext and its factory

**Files:**
- `src/agents/execution/types.ts` — change `triggeringEvent: NDKEvent` → `triggeringEnvelope: InboundEnvelope`
- `src/agents/execution/ExecutionContextFactory.ts` — reads `envelope.metadata.branchName` instead of `event.tags.find(t => t[0] === "branch")`
- `src/tools/types.ts` — `ToolExecutionContext.triggeringEvent` → `triggeringEnvelope: InboundEnvelope`

### Step 9: Refactor EventContextService

**File:** `src/services/event-context/EventContextService.ts`

- `createEventContext` reads from `InboundEnvelope` instead of NDKEvent
- `fallbackPrincipalFromTriggeringEvent` becomes trivially `envelope.principal`
- `getTagValue` helper deleted — no longer needed
- `inferTransport` helper deleted — envelope already carries transport
- `resolveCompletionRecipientPrincipal` takes envelope instead of NDKEvent
- The `rootEvent.id` resolves from `envelope.message.nativeId`

### Step 10: Refactor EventContext (nostr/types.ts) and AgentEventEncoder

**File:** `src/nostr/types.ts`
- `EventContext.triggeringEvent` → `triggeringEnvelope: InboundEnvelope`

**File:** `src/nostr/AgentEventEncoder.ts`
- Uses `envelope.principal.linkedPubkey` instead of `triggeringEvent.pubkey`
- Uses `envelope.metadata.branchName` instead of tag lookup
- Completion p-tag uses pre-resolved `completionRecipientPubkey` or `envelope.principal.linkedPubkey`

### Step 11: Update publishers and remaining consumers

**Files:**
- `src/nostr/AgentPublisher.ts` — EventContext changes cascade here
- `src/events/runtime/RecordingRuntimePublisher.ts` — reads from envelope instead of event
- `src/services/LLMOperationsRegistry.ts` — reads `envelope.message.nativeId` instead of `event.id`
- `src/prompts/fragments/debug-mode.ts` — reads `envelope.content`
- `src/agents/execution/PostCompletionChecker.ts`, `StreamSetup.ts`, `ToolSupervisionWrapper.ts` — update triggeringEvent references
- `src/utils/delegation-chain.ts` — accept envelope or extracted fields instead of NDKEvent

### Step 12: Update RuntimeIngressService and delete bridge

**File:** `src/services/ingress/RuntimeIngressService.ts`
- Remove `InboundEnvelopeEventBridge` import and instantiation
- Remove `legacyEvent` parameter and logic
- `dispatch(envelope, { agentExecutor })` directly
- Return type changes from `NDKEvent` to `void` (or `InboundEnvelope`)

**File:** `src/event-handler/reply.ts`
- No longer passes `legacyEvent` to RuntimeIngressService

**Delete:** `src/nostr/InboundEnvelopeEventBridge.ts` and its test

### Step 13: Update Telegram gateway

**Files:**
- `src/services/telegram/TelegramGatewayCoordinator.ts`
- `src/services/telegram/TelegramGatewayService.ts`
- Remove `legacyEvent` usage — they produce `InboundEnvelope` via `TelegramInboundAdapter` and pass that directly

### Step 14: Update all tests

- Tests that construct `NDKEvent` for the dispatch pipeline switch to constructing `InboundEnvelope`
- `LocalInboundAdapter` already produces envelopes — test helpers can use it
- `RecordingRuntimePublisher` tests update to envelope-based EventContext
- `AgentEventDecoder` tests for daemon-level methods stay unchanged
- Delete `InboundEnvelopeEventBridge.test.ts`
- Update dispatch/conversation/execution tests

### Step 15: Update doctor commands

**Files:**
- `src/commands/doctor-transport-chat.ts`
- `src/commands/doctor-transport-smoke.ts`
- Update to validate envelope flow end-to-end without the bridge

## Files Touched (Summary)

### New files
- `src/events/runtime/envelope-classifier.ts`

### Deleted files
- `src/nostr/InboundEnvelopeEventBridge.ts`
- `src/nostr/__tests__/InboundEnvelopeEventBridge.test.ts`

### Modified files (core)
- `src/events/runtime/InboundEnvelope.ts`
- `src/nostr/NostrInboundAdapter.ts`
- `src/nostr/AgentEventDecoder.ts` (remove dispatch-level methods)
- `src/nostr/AgentEventEncoder.ts`
- `src/nostr/AgentPublisher.ts`
- `src/nostr/types.ts`
- `src/services/ingress/RuntimeIngressService.ts`
- `src/services/dispatch/AgentDispatchService.ts`
- `src/services/dispatch/AgentRouter.ts`
- `src/services/dispatch/DelegationCompletionHandler.ts`
- `src/services/event-context/EventContextService.ts`
- `src/conversations/ConversationStore.ts`
- `src/conversations/ConversationRegistry.ts`
- `src/conversations/services/ConversationResolver.ts`
- `src/agents/execution/types.ts`
- `src/agents/execution/ExecutionContextFactory.ts`
- `src/tools/types.ts`

### Modified files (consumers)
- `src/events/runtime/RecordingRuntimePublisher.ts`
- `src/services/LLMOperationsRegistry.ts`
- `src/services/telegram/TelegramGatewayCoordinator.ts`
- `src/services/telegram/TelegramGatewayService.ts`
- `src/prompts/fragments/debug-mode.ts`
- `src/agents/execution/PostCompletionChecker.ts`
- `src/agents/execution/StreamSetup.ts`
- `src/agents/execution/ToolSupervisionWrapper.ts`
- `src/utils/delegation-chain.ts`
- `src/event-handler/reply.ts`
- `src/commands/doctor-transport-chat.ts`
- `src/commands/doctor-transport-smoke.ts`

### Modified tests (~20-30 files)
- All test files that construct NDKEvent for dispatch pipeline testing

## What Does NOT Change

- **Daemon pipeline**: `event-handler/index.ts` continues receiving raw NDKEvent from Nostr subscriptions and routing by kind. Only kind:1 text events enter the dispatch pipeline.
- **AgentEventDecoder daemon methods**: `classifyForDaemon()`, `isNeverRouteKind()`, etc. stay as NDKEvent consumers.
- **TagExtractor**: Stays for daemon-level tag extraction. Dispatch pipeline no longer uses it.
- **Nostr publishing**: `AgentPublisher` still creates NDKEvent for outbound Nostr publishing — that's correct, outbound is transport-specific.
- **NostrInboundAdapter**: Still converts NDKEvent → InboundEnvelope — that's its job as an edge adapter.

## Risk Mitigation

- **Orphaned reply handling** in `ConversationResolver` fetches raw NDKEvents from Nostr relays. These need conversion to InboundEnvelope via `NostrInboundAdapter.toEnvelope()` before storing. This is the one place where a Nostr-specific conversion happens inside the dispatch pipeline, but it's justified — we're fetching from the Nostr network.
- **Event cache**: Currently `ConversationStore.cacheEvent()` stores NDKEvent by ID for delegation trigger restoration. Must store InboundEnvelope instead. The `getCachedEvent` callers in `AgentDispatchService.dispatchToAgents` and `handleDelegationResponse` need updating.

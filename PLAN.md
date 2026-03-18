# Transport Layer Abstraction: Complete the Migration

## Goal
Make the core dispatch/conversation/execution pipeline consume `InboundEnvelope` directly, eliminating the `InboundEnvelopeEventBridge` and removing NDKEvent from all transport-agnostic code paths.

## Key Architectural Insight

There are **two distinct pipelines** that must be treated differently:

1. **Daemon pipeline** (stays NDKEvent): Nostr subscription → Daemon → `event-handler/index.ts` → `classifyForDaemon()`. These are raw Nostr protocol events (kind:0 metadata, kind:31933 project, kind:4129 lesson, etc.). This is Nostr-specific and correctly uses NDKEvent.

2. **Dispatch pipeline** (refactor to InboundEnvelope): Any transport → Adapter → `InboundEnvelope` → `RuntimeIngressService` → `AgentDispatchService` → `ConversationResolver` → `ConversationStore` → `ExecutionContext` → tools. This is the transport-agnostic pipeline where NDKEvent should not appear.

## ID Normalization Strategy

**Problem:** `InboundEnvelope.message.replyToId` is transport-qualified (`nostr:abc123`, `local:xyz`), but `ConversationStore` cache and conversation IDs currently use raw native IDs (plain `abc123`).

**Solution:** The envelope already carries both forms:
- `message.id` — transport-qualified: `nostr:abc123`
- `message.nativeId` — raw: `abc123`
- `message.replyToId` — transport-qualified: `nostr:def456`

When the dispatch pipeline needs to match against cached events or conversation anchors, it must use `message.nativeId` for cache keys and `nativeId`-derived values for lookups. The `replyToId` on envelopes is for envelope-to-envelope reference; when looking up cached entries, strip the transport prefix or use a helper:

```typescript
function toNativeId(qualifiedId: string): string {
    const colonIndex = qualifiedId.indexOf(":");
    return colonIndex >= 0 ? qualifiedId.substring(colonIndex + 1) : qualifiedId;
}
```

This helper goes in `src/events/runtime/envelope-classifier.ts` alongside the other envelope utility functions.

Cache keys in `ConversationRegistry.cacheEvent()` / `cacheEnvelope()` use `envelope.message.nativeId`. Lookups from `replyToId` normalize first via `toNativeId()`.

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
    delegationParentConversationId?: string; // from "delegation" tag — parent conversation for chain building
    nudgeEventIds?: string[];   // from "nudge" tags — nudge event IDs for inheritance
    skillEventIds?: string[];   // from "skill" tags — skill event IDs for loading
};
```

**Why `replyTargets` as array?** `DelegationCompletionHandler` iterates all e-tags in reverse to find which delegation a completion responds to. `message.replyToId` only holds one value. We need the full list on the envelope.

**Why `delegationParentConversationId`?** `buildDelegationChain` reads the `["delegation", parentConvId]` tag from the triggering event. Without it, delegation-chain reconstruction breaks — the function can't find the parent conversation to walk up the ancestry tree. This also applies when rebuilding chains from cached events: `getCachedEvent` returns an `InboundEnvelope` (post-migration), so its `metadata.delegationParentConversationId` must carry the original delegation tag value.

**Why `nudgeEventIds` and `skillEventIds`?** Three consumers currently read these from `triggeringEvent`:
- `StreamSetup.ts` — fetches nudges (with permissions) and skills before building tool objects
- `PostCompletionChecker.ts` — fetches nudges for post-completion context
- `ToolSupervisionWrapper.ts` — fetches nudges for pre-tool supervision context
- `delegate.ts` — reads inherited nudges for forwarding to delegated agents

Without these on the envelope metadata, nudge inheritance, tool gating, and skill loading silently stop working.

Update `NostrInboundAdapter.toEnvelope()` to populate all new fields from NDKEvent tags, using the existing `getTagValues`/`getTagValue` defensive pattern consistently. Other adapters (Telegram, Local) set them as appropriate (mostly undefined).

### Step 2: Split AgentEventDecoder

**Current:** Single class with both daemon-level and dispatch-level methods, all accepting NDKEvent.

**After:** Two concerns:

1. **`AgentEventDecoder`** (stays in `src/nostr/AgentEventDecoder.ts`) — Daemon-level methods only. These operate on raw NDKEvent from Nostr subscriptions:
   - `classifyForDaemon()`, `isNeverRouteKind()`, `isProjectEvent()`, `isLessonEvent()`, `isLessonCommentEvent()`
   - `isConfigUpdate()`, `isMetadata()`, `isStopCommand()`
   - `extractProjectId()`, `extractAgentDefinitionIdFromLesson()`
   - `hasProjectATags()`, `extractProjectATags()`

2. **New functions** in `src/events/runtime/envelope-classifier.ts` — Dispatch-level functions that accept `InboundEnvelope`:
   - `toNativeId(qualifiedId)` — strips transport prefix from qualified IDs
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
  - Uses `envelope.message.nativeId` as conversation ID (raw ID, not transport-qualified)
  - Uses `envelope.principal`, `envelope.content`, `envelope.occurredAt`
- `ConversationStore.addEvent(id, envelope, ...)` → `addEnvelopeMessage(id, envelope, ...)`
- `addEventMessage(envelope, isFromAgent, principalContext?)` refactored similarly
- `extractTargetedPubkeys` reads from `envelope.recipients` instead of p-tags
- `buildDefaultSenderPrincipal` reads from `envelope.principal` instead of `event.pubkey`
- Event cache stores `InboundEnvelope` instead of `NDKEvent`:
  - `cacheEvent(event: NDKEvent)` → `cacheEnvelope(envelope: InboundEnvelope)`
  - Cache key: `envelope.message.nativeId` (raw ID, matching current `event.id` format)
  - `getCachedEvent(eventId)` → `getCachedEnvelope(nativeId)`: returns `InboundEnvelope | undefined`
  - Lookups from `replyToId` (transport-qualified) strip prefix via `toNativeId()` before cache access

**`getRootEventId()` semantics preserved:** Returns `state.messages[0]?.eventId` — still the raw native ID of the first message. This is the conversation root, not the triggering message.

### Step 4: Refactor ConversationResolver

**File:** `src/conversations/services/ConversationResolver.ts`

- `resolveConversationForEvent(envelope: InboundEnvelope, ...)` instead of NDKEvent
- Uses `envelope.message.replyToId` for reply target (normalize via `toNativeId()` when needed for cache lookups)
- Uses `envelope.recipients` instead of `AgentEventDecoder.getMentionedPubkeys(event)`
- `extractReferencedArticle` uses `envelope.metadata.articleReferences` and `envelope.channel.projectBinding`
- `buildDelegationChain` refactored (see Step 5 changes) — reads `envelope.metadata.delegationParentConversationId` instead of the "delegation" tag directly from NDKEvent
- Orphaned reply handling: `handleOrphanedReply` fetches events from Nostr network — those are raw NDKEvents. Convert fetched NDKEvents to InboundEnvelopes using `NostrInboundAdapter.toEnvelope()` before adding to the conversation. This is the Nostr-specific conversion at the network boundary.

### Step 5: Refactor delegation-chain.ts

**File:** `src/utils/delegation-chain.ts`

Change `buildDelegationChain` signature:
```typescript
export function buildDelegationChain(
    envelope: InboundEnvelope,
    currentAgentPubkey: string,
    projectOwnerPubkey: string,
    currentConversationId: string
): DelegationChainEntry[] | undefined
```

Key changes:
- Read delegation parent from `envelope.metadata.delegationParentConversationId` instead of `event.tags.find(t => t[0] === "delegation")`
- Read sender pubkey from `envelope.principal.linkedPubkey` instead of `event.pubkey`
- Walking the chain upward: `getCachedEvent(rootEventId)` becomes `getCachedEnvelope(rootEventId)`. The cached envelope's `metadata.delegationParentConversationId` carries the delegation tag value — no data loss.
- All other logic (conversation store lookups, display name resolution) remains the same since it operates on conversation IDs and pubkeys, not NDKEvent objects.

### Step 6: Refactor DelegationCompletionHandler

**File:** `src/services/dispatch/DelegationCompletionHandler.ts`

- `handleDelegationCompletion(envelope: InboundEnvelope)` instead of NDKEvent
- Uses `envelope.metadata.replyTargets` instead of `TagExtractor.getETags(event)`
- Uses `envelope.principal.linkedPubkey` instead of `event.pubkey` for sender validation
- Uses `envelope.content` instead of `event.content`
- `ConversationStore` calls updated to use envelope

### Step 7: Refactor AgentRouter

**File:** `src/services/dispatch/AgentRouter.ts`

- `resolveTargetAgents(envelope, projectContext, conversation)` instead of NDKEvent
- Uses envelope-classifier functions instead of AgentEventDecoder
- `processStopSignal` and `unblockAgent` use `envelope.recipients` instead of p-tags and `envelope.principal` instead of `event.pubkey`

### Step 8: Refactor AgentDispatchService

**File:** `src/services/dispatch/AgentDispatchService.ts`

- `dispatch(envelope: InboundEnvelope, context)` — primary signature change
- Remove `NDKEvent` import
- All internal methods switch from `event: NDKEvent` to `envelope: InboundEnvelope`
- Telemetry attributes read from envelope fields
- Uses envelope-classifier functions for routing decisions
- `dispatchToAgents` passes envelope fields (`content`, `principal.linkedPubkey`, `message.nativeId`) to `handleDeliveryInjection`
- Delete `measureEventLoopLag()` — it measures two consecutive `hrtime` calls (always ~0), not actual event loop lag. The telemetry attributes referencing it are removed.

### Step 9: Refactor ExecutionContext and its factory

**Files:**
- `src/agents/execution/types.ts` — change `triggeringEvent: NDKEvent` → `triggeringEnvelope: InboundEnvelope`
- `src/agents/execution/ExecutionContextFactory.ts` — reads `envelope.metadata.branchName` instead of `event.tags.find(t => t[0] === "branch")`; param changes from `triggeringEvent: NDKEvent` to `triggeringEnvelope: InboundEnvelope`
- `src/tools/types.ts` — `ToolExecutionContext.triggeringEvent` → `triggeringEnvelope: InboundEnvelope`

### Step 10: Refactor EventContextService

**File:** `src/services/event-context/EventContextService.ts`

- `createEventContext` reads from `InboundEnvelope` instead of NDKEvent
- `fallbackPrincipalFromTriggeringEvent` becomes trivially `envelope.principal`
- `getTagValue` helper deleted — no longer needed
- `inferTransport` helper deleted — envelope already carries transport
- `resolveCompletionRecipientPrincipal` takes envelope instead of NDKEvent
- **`rootEvent.id` correctly resolves from `conversation.getRootEventId()`** — NOT from `envelope.message.nativeId`. The conversation's root event ID is the first message stored in the conversation, which is the conversation anchor. The triggering envelope's `nativeId` is just the current inbound message. These must remain distinct for threading to work correctly.

### Step 11: Refactor EventContext (nostr/types.ts) and AgentEventEncoder

**File:** `src/nostr/types.ts`
- `EventContext.triggeringEvent` → `triggeringEnvelope: InboundEnvelope`

**File:** `src/nostr/AgentEventEncoder.ts`
- Uses `envelope.principal.linkedPubkey` instead of `triggeringEvent.pubkey`
- Uses `envelope.metadata.branchName` instead of tag lookup
- Completion p-tag uses pre-resolved `completionRecipientPubkey` or `envelope.principal.linkedPubkey`

### Step 12: Update execution consumers (nudge/skill/delegation)

**Files:**
- `src/agents/execution/StreamSetup.ts`:
  - `AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent)` → `context.triggeringEnvelope.metadata.nudgeEventIds ?? []`
  - `AgentEventDecoder.extractSkillEventIds(context.triggeringEvent)` → `context.triggeringEnvelope.metadata.skillEventIds ?? []`
  - `context.triggeringEvent.pubkey` → `context.triggeringEnvelope.principal.linkedPubkey`

- `src/agents/execution/PostCompletionChecker.ts`:
  - `AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent)` → `context.triggeringEnvelope.metadata.nudgeEventIds ?? []`

- `src/agents/execution/ToolSupervisionWrapper.ts`:
  - `AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent)` → `context.triggeringEnvelope.metadata.nudgeEventIds ?? []`

- `src/tools/implementations/delegate.ts`:
  - `AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent)` → `context.triggeringEnvelope.metadata.nudgeEventIds ?? []`

### Step 13: Update publishers and remaining consumers

**Files:**
- `src/nostr/AgentPublisher.ts` — EventContext changes cascade here
- `src/events/runtime/RecordingRuntimePublisher.ts` — reads from envelope instead of event
- `src/services/LLMOperationsRegistry.ts` — reads `envelope.message.nativeId` instead of `event.id`
- `src/prompts/fragments/debug-mode.ts` — reads `envelope.content`

### Step 14: Refactor McpNotificationDelivery

**File:** `src/services/mcp/McpNotificationDelivery.ts`

Currently synthesizes an `NDKEvent` to pass as `triggeringEvent` to `createExecutionContext`. Must produce an `InboundEnvelope` instead:

```typescript
const syntheticEnvelope: InboundEnvelope = {
    transport: "local",
    principal: {
        id: `nostr:${subscription.agentPubkey}`,
        transport: "nostr",
        linkedPubkey: subscription.agentPubkey,
    },
    channel: {
        id: `mcp:${subscription.conversationId}`,
        transport: "local",
        kind: "conversation",
    },
    message: {
        id: `local:mcp:${Date.now()}`,
        transport: "local",
        nativeId: subscription.rootEventId,
        replyToId: undefined,
    },
    recipients: [{
        id: `nostr:${subscription.agentPubkey}`,
        transport: "nostr",
        linkedPubkey: subscription.agentPubkey,
    }],
    content: formattedContent,
    occurredAt: Math.floor(Date.now() / 1000),
    capabilities: [],
    metadata: {
        branchName: metadata.branch,
    },
};

const executionContext = await createExecutionContext({
    agent,
    conversationId: subscription.conversationId,
    projectBasePath: projectCtx.agentRegistry.getBasePath(),
    triggeringEnvelope: syntheticEnvelope,
    mcpManager: projectCtx.mcpManager,
});
```

Key: `message.nativeId` is set to `subscription.rootEventId` (same as the old synthetic event's `id`), preserving the threading semantics. `metadata.branchName` carries the branch tag from conversation metadata.

### Step 15: Update RuntimeIngressService and delete bridge

**File:** `src/services/ingress/RuntimeIngressService.ts`
- Remove `InboundEnvelopeEventBridge` import and instantiation
- Remove `legacyEvent` parameter and logic
- `dispatch(envelope, { agentExecutor })` directly
- Return type changes from `NDKEvent` to `void` (or `InboundEnvelope`)

**File:** `src/event-handler/reply.ts`
- No longer passes `legacyEvent` to RuntimeIngressService

**Delete:** `src/nostr/InboundEnvelopeEventBridge.ts` and its test

### Step 16: Update Telegram gateway

**Files:**
- `src/services/telegram/TelegramGatewayCoordinator.ts`
- `src/services/telegram/TelegramGatewayService.ts`
- Remove `legacyEvent` usage — they produce `InboundEnvelope` via `TelegramInboundAdapter` and pass that directly

### Step 17: Update all tests

- Tests that construct `NDKEvent` for the dispatch pipeline switch to constructing `InboundEnvelope`
- `LocalInboundAdapter` already produces envelopes — test helpers can use it
- `RecordingRuntimePublisher` tests update to envelope-based EventContext
- `AgentEventDecoder` tests for daemon-level methods stay unchanged
- Delete `InboundEnvelopeEventBridge.test.ts`
- Update dispatch/conversation/execution tests

### Step 18: Update doctor commands

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
- `src/services/mcp/McpNotificationDelivery.ts`
- `src/prompts/fragments/debug-mode.ts`
- `src/agents/execution/PostCompletionChecker.ts`
- `src/agents/execution/StreamSetup.ts`
- `src/agents/execution/ToolSupervisionWrapper.ts`
- `src/tools/implementations/delegate.ts`
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

## Review Comment Resolutions

### 1. Reply ID mismatch (line 90 comment)
**Addressed in:** ID Normalization Strategy section + Step 3.
Cache keys use `envelope.message.nativeId` (raw, no prefix). Lookups from `replyToId` (transport-qualified) normalize via `toNativeId()` helper in `envelope-classifier.ts`.

### 2. Delegation chain breakage (line 93 comment)
**Addressed in:** Step 1 (`delegationParentConversationId` on metadata) + Step 5 (refactored `buildDelegationChain`).
The delegation tag value is preserved as `envelope.metadata.delegationParentConversationId`. When walking the chain upward, cached envelopes carry this same field, so reconstruction works identically.

### 3. Root event vs triggering message (line 141 comment)
**Addressed in:** Step 10 (explicit note about `rootEvent.id`).
`rootEvent.id` resolves from `conversation.getRootEventId()` (first stored message), NOT from `envelope.message.nativeId`. The plan explicitly preserves this distinction.

### 4. Missing MCP caller (line 153 comment)
**Addressed in:** Step 14 (new dedicated step for McpNotificationDelivery).
Synthetic NDKEvent replaced with synthetic InboundEnvelope carrying `branchName` in metadata and `rootEventId` as `nativeId`.

### 5. Lost nudge/skill tags (line 160 comment)
**Addressed in:** Step 1 (`nudgeEventIds`, `skillEventIds` on metadata) + Step 12 (dedicated step for all nudge/skill consumers).
All four consumers (StreamSetup, PostCompletionChecker, ToolSupervisionWrapper, delegate tool) read from `envelope.metadata.nudgeEventIds`/`skillEventIds` instead of `AgentEventDecoder.extractNudgeEventIds(triggeringEvent)`.

### 6. measureEventLoopLag cleanup
**Addressed in:** Step 8. Dead code deleted during the migration.

# Delegation and RAL Processing Architecture

This document details the complete flow of agent delegation and the Request-Agent Loop (RAL) system with painful specificity.

## Table of Contents

1. [Overview](#overview)
2. [Key Components](#key-components)
3. [RAL (Request-Agent Loop)](#ral-request-agent-loop)
4. [Delegation Flow](#delegation-flow)
5. [Event Processing](#event-processing)
6. [Message Injection](#message-injection)
7. [Delegation Completion](#delegation-completion)
8. [Edge Cases and Gotchas](#edge-cases-and-gotchas)

---

## Overview

The delegation system allows agents to:
1. **Delegate** tasks to other agents and wait for responses
2. **Ask** humans questions and wait for answers
3. **Resume** execution when responses arrive
4. **Handle partial completions** - when some but not all delegations complete

The RAL (Request-Agent Loop) is the **single source of truth** for:
- Agent execution state (`executing`, `paused`, `done`)
- Conversation messages during execution
- Pending and completed delegations
- Queued message injections

---

## Key Components

### Files and Their Responsibilities

| File | Responsibility |
|------|----------------|
| `src/services/ral/RALRegistry.ts` | RAL state management singleton |
| `src/services/ral/types.ts` | Type definitions for RAL state |
| `src/services/ral/TimeoutResponder.ts` | Generates acknowledgments when agent is busy |
| `src/tools/implementations/delegate.ts` | The `delegate` tool agents use |
| `src/tools/implementations/ask.ts` | The `ask` tool for human questions |
| `src/event-handler/reply.ts` | Main event routing and handling |
| `src/event-handler/DelegationCompletionHandler.ts` | Processes delegation completions |
| `src/agents/execution/AgentExecutor.ts` | Executes agent LLM calls |
| `src/nostr/AgentPublisher.ts` | Publishes Nostr events |
| `src/nostr/AgentEventDecoder.ts` | Decodes and classifies events |

### Nostr Event Kinds

| Kind | Name | Purpose |
|------|------|---------|
| 1111 | GenericReply | Delegation requests, responses, conversations |
| 21111 | TenexStreamingResponse | Streaming LLM output chunks |
| 513 | Delegation | Explicit delegation marker (deprecated, now uses 1111) |

---

## RAL (Request-Agent Loop)

### RAL State Structure

```typescript
interface RALState {
  id: string;                           // Unique RAL identifier
  agentPubkey: string;                  // Agent this RAL belongs to
  messages: CoreMessage[];              // Conversation messages (single source of truth)
  pendingDelegations: PendingDelegation[];   // Delegations awaiting response
  completedDelegations: CompletedDelegation[]; // Delegations that have completed
  queuedInjections: QueuedInjection[];  // Messages to inject on next step
  status: "executing" | "paused" | "done";
  currentTool?: string;                 // Tool currently executing (for timeout context)
  toolStartedAt?: number;               // When current tool started
  createdAt: number;
  lastActivityAt: number;
}
```

### RAL Status Transitions

```
[No RAL] ──create()──> [executing] ──saveState()──> [paused]
                            │                           │
                            │                           │
                      clear() (on completion)    markResuming()
                            │                           │
                            v                           v
                        [cleared]               [executing] (resumed)
```

### RAL Lifecycle

1. **Creation** (`RALRegistry.create(agentPubkey)`):
   - Called when `AgentExecutor.execute()` starts fresh execution
   - Creates new RAL with status `"executing"`
   - Returns unique RAL ID

2. **Message Saving** (`RALRegistry.saveMessages(agentPubkey, messages)`):
   - Called after first message build in `AgentExecutor.executeStreaming()`
   - RAL becomes the **single source of truth** for messages
   - Subsequent iterations use RAL messages directly

3. **Pause for Delegation** (`RALRegistry.saveState(agentPubkey, messages, pendingDelegations)`):
   - Called in `onStopCheck` when delegate/ask tool returns `StopExecutionSignal`
   - **CRITICAL**: Called immediately in `onStopCheck`, not after streaming ends
   - Sets status to `"paused"`
   - Registers delegation event IDs for completion tracking

4. **Recording Completion** (`RALRegistry.recordCompletion(agentPubkey, completion)`):
   - Called by `DelegationCompletionHandler` when a response arrives
   - Moves delegation from `pendingDelegations` to `completedDelegations`

5. **Resumption** (`RALRegistry.markResuming(agentPubkey)`):
   - Called by `reply.ts` when delegation completion triggers resumption
   - Sets status back to `"executing"`

6. **Cleanup** (`RALRegistry.clear(agentPubkey)`):
   - Called when agent completes normally (finishReason: "stop" or "end")
   - Removes all RAL state for the agent

---

## Delegation Flow

### Step 1: Agent Calls Delegate Tool

**File**: `src/tools/implementations/delegate.ts`

```typescript
// Agent calls delegate with one or more delegations
delegate({
  delegations: [
    { recipient: "agent1", prompt: "Do task A" },
    { recipient: "agent2", prompt: "Do task B" }
  ]
})
```

The tool:
1. Resolves recipient names to pubkeys
2. Publishes kind:1111 events for each delegation via `AgentPublisher.delegate()`
3. Returns a `StopExecutionSignal`:

```typescript
{
  __stopExecution: true,
  pendingDelegations: [
    { eventId: "abc123", recipientPubkey: "...", recipientSlug: "agent1", prompt: "Do task A" },
    { eventId: "def456", recipientPubkey: "...", recipientSlug: "agent2", prompt: "Do task B" }
  ]
}
```

### Step 2: Stop Signal Detection

**File**: `src/agents/execution/AgentExecutor.ts` (lines 782-831)

The `onStopCheck` callback detects the stop signal:

```typescript
const onStopCheck = async (steps: any[]): Promise<boolean> => {
  const lastStep = steps[steps.length - 1];
  const toolResults = lastStep.toolResults ?? [];

  for (const toolResult of toolResults) {
    // AI SDK uses `output` for tool results, not `result`
    if (isStopExecutionSignal(toolResult.output)) {
      this.pendingDelegations = toolResult.output.pendingDelegations;

      // CRITICAL: Save RAL state immediately to avoid race condition
      // The delegation completion might arrive before streaming fully completes
      ralRegistry.saveState(context.agent.pubkey, messages, this.pendingDelegations);

      return true; // Stop execution
    }
  }
  return false;
};
```

**Why save immediately?** Delegation responses can arrive within microseconds. If we wait until after streaming completes, the response may arrive before we've registered as "paused", causing the response to be lost.

### Step 3: Delegation Event Published

**File**: `src/nostr/AgentPublisher.ts` (lines 81-134)

The delegation event structure:

```
Kind: 1111
Content: "Do task A"
Tags:
  - ["p", <recipient_pubkey>]           # Who should receive this
  - ["E", <conversation_root_id>]       # Conversation root
  - ["K", <conversation_root_kind>]     # Root event kind
  - ["P", <conversation_root_pubkey>]   # Root event author
  - ["e", <triggering_event_id>]        # What triggered this delegation
  - ["a", "31933:<project_pubkey>:<dtag>"] # Project reference
  - ["phase", <phase_name>]             # Optional: phase for self-delegation
  - ["branch", <branch_name>]           # Optional: git branch
```

### Step 4: Agent Pauses

After `onStopCheck` returns `true`, streaming ends. The agent is now paused:
- RAL status: `"paused"`
- `pendingDelegations`: Contains the delegations we're waiting for
- Agent does NOT publish a completion event

---

## Event Processing

### Main Entry Point

**File**: `src/event-handler/reply.ts`

```
handleChatMessage(event)
    │
    ├─> isDirectedToSystem(event)?
    │       No  ──> Add to history only, return
    │       Yes ──v
    │
    └─> handleReplyLogic(event)
            │
            ├─> resolveConversation(event)
            │
            ├─> addEvent(conversation, event)
            │
            ├─> DelegationCompletionHandler.handleDelegationCompletion(event)
            │       │
            │       ├─> shouldReactivate: true, isResumption: true
            │       │       └─> Resume agent with delegation status message
            │       │
            │       └─> shouldReactivate: false
            │               └─> Continue to normal routing
            │
            ├─> AgentRouter.resolveTargetAgents(event)
            │
            ├─> Check for active operations (injection vs new execution)
            │
            └─> executeAgent() for each target
```

### Event Filtering

**File**: `src/nostr/AgentEventDecoder.ts`

Events are routed to agents based on:
1. **p-tags**: Event must p-tag the agent or project
2. **Not self-reply**: Agents don't process their own messages (unless they have phases)
3. **Directed to system**: At least one p-tag must match a system agent/project

```typescript
static isDirectedToSystem(event: NDKEvent, systemAgents: Map<string, AgentInstance>): boolean {
  const pTags = event.tags.filter((tag) => tag[0] === "p");
  if (pTags.length === 0) return false;

  const mentionedPubkeys = pTags.map((tag) => tag[1]).filter(Boolean);
  const systemPubkeys = new Set([
    ...Array.from(systemAgents.values()).map((a) => a.pubkey),
    projectCtx.pubkey  // Also include project pubkey
  ]);

  return mentionedPubkeys.some((pubkey) => systemPubkeys.has(pubkey));
}
```

---

## Message Injection

When an agent is executing or paused, new messages can arrive. These are handled via injection:

### Injection Flow

```
New message arrives
    │
    ├─> Agent is executing?
    │       Yes ──> ralRegistry.queueEvent(agentPubkey, event)
    │               └─> TimeoutResponder generates acknowledgment
    │
    ├─> Agent is paused?
    │       Yes ──> ralRegistry.queueEvent(agentPubkey, event)
    │               └─> TimeoutResponder generates acknowledgment
    │
    └─> No active RAL ──> Start fresh execution
```

### Queue Processing

**File**: `src/agents/execution/AgentExecutor.ts` (lines 743-780)

The `prepareStep` callback processes queued injections:

```typescript
const prepareStep = (step: { messages: ModelMessage[]; stepNumber: number }) => {
  const ralRegistry = RALRegistry.getInstance();

  // Get newly queued injections - they're also persisted to RAL.messages
  const newInjections = ralRegistry.getAndPersistInjections(context.agent.pubkey);

  if (newInjections.length === 0) {
    return undefined;
  }

  // Convert to model messages and append
  const injectedMessages = newInjections.map((q) => ({
    role: q.type as "user" | "system",
    content: q.content,
  }));

  return {
    messages: [...step.messages, ...injectedMessages],
  };
};
```

### TimeoutResponder (BusyResponder)

**File**: `src/services/ral/TimeoutResponder.ts`

When a message arrives for a busy agent:

1. Generates an acknowledgment using the agent's LLM
2. Publishes acknowledgment to user
3. **Swaps** the queued user message with a system message for context

```typescript
// Example: User sends "What's the status?" while agent is working
// TimeoutResponder generates:
{
  message_for_user: "I'm currently working on your task. I'll address your question shortly.",
  system_message_for_active_ral: "[New user message received]: What's the status?",
  stop_current_step: false
}
```

The swap ensures the agent sees a context note rather than the raw user message (which it will address later).

---

## Delegation Completion

### Completion Detection

**File**: `src/event-handler/DelegationCompletionHandler.ts`

When an event arrives, we check if it completes a delegation:

```typescript
static async handleDelegationCompletion(event, conversation, coordinator) {
  // 1. Find which delegation this responds to (via e-tag)
  const delegationEventId = TagExtractor.getFirstETag(event);
  if (!delegationEventId) return { shouldReactivate: false };

  // 2. Look up which agent is waiting for this delegation
  const agentPubkey = ralRegistry.findAgentWaitingForDelegation(delegationEventId);
  if (!agentPubkey) return { shouldReactivate: false };

  // 3. Record the completion
  ralRegistry.recordCompletion(agentPubkey, {
    eventId: delegationEventId,
    recipientPubkey: event.pubkey,
    response: event.content,
    responseEventId: event.id,
    completedAt: Date.now(),
  });

  // 4. Build delegation status
  const delegationStatus = {
    completedCount: state.completedDelegations.length,
    pendingCount: state.pendingDelegations.length,
    completedDelegations: [...],
    pendingDelegations: [...]
  };

  // 5. ALWAYS reactivate - even for partial completions
  // Agent decides what to do with partial results
  return {
    shouldReactivate: true,
    targetAgent,
    replyTarget: conversation.history[0],
    isResumption: true,
    delegationStatus,
  };
}
```

### Partial Completion Handling

When only some delegations complete, the agent is **still reactivated** with a system message:

```
Delegation responses received (1/2):
- agent1: <response content>

Still waiting for responses from:
- agent2
```

The agent can then decide to:
- Wait for remaining delegations
- Respond with partial results
- Take other action

### Resumption Flow

**File**: `src/event-handler/reply.ts` (lines 178-240)

```typescript
if (delegationResult.shouldReactivate && delegationResult.isResumption && delegationResult.targetAgent) {
  const { delegationStatus } = delegationResult;
  const isPartialCompletion = delegationStatus && delegationStatus.pendingCount > 0;

  // 1. Inject system message about delegation status
  if (delegationStatus) {
    const statusMessage = formatDelegationStatusMessage(delegationStatus);
    ralRegistry.queueSystemMessage(delegationResult.targetAgent.pubkey, statusMessage);
  }

  // 2. Mark RAL as resuming
  ralRegistry.markResuming(delegationResult.targetAgent.pubkey);

  // 3. Create execution context
  const executionContext = await createExecutionContext({
    agent: delegationResult.targetAgent,
    conversationId: conversation.id,
    triggeringEvent: delegationResult.replyTarget || event,
    ...
  });

  // 4. Execute agent (will use RAL messages)
  await executeAgent(executionContext, agentExecutor, conversation, event);
  return; // Don't proceed with normal routing
}
```

---

## Edge Cases and Gotchas

### 1. Race Condition: Delegation Response Before Pause Registered

**Problem**: Delegation response arrives before `saveState()` is called.

**Solution**: `saveState()` is called **immediately in `onStopCheck`**, not after streaming completes.

**Location**: `AgentExecutor.ts` lines 818-824

### 2. Agent Events Not Triggering Agent Execution

**Problem**: Agent1 completes and p-tags Agent2 (delegating agent). This could trigger Agent2 to execute with a fresh context instead of resuming.

**Solution**: `DelegationCompletionHandler` checks if this is a delegation completion and handles resumption specially. The waiting agent is reactivated with its saved RAL state.

### 3. Partial Completion Triggering Fresh Execution

**Problem**: When agent1 completes (1 of 2 delegations), ABrouter could start fresh instead of resuming.

**Solution**: Even partial completions return `shouldReactivate: true`. The agent receives a system message with the status and can decide what to do.

### 4. Message Injection During Paused State

**Problem**: User sends message while agent is paused waiting for delegation.

**Solution**: Message is queued via `ralRegistry.queueEvent()`. TimeoutResponder generates acknowledgment. Message will be injected when agent resumes.

### 5. AI SDK Tool Result Property

**Problem**: AI SDK uses `output` for tool results, not `result`.

**Solution**: `onStopCheck` checks `toolResult.output`, not `toolResult.result`.

**Location**: `AgentExecutor.ts` line 797

### 6. Delegation Event Threading

**Problem**: Delegation completion needs to be matched to the original delegation.

**Solution**: Delegation events include `["e", <triggering_event_id>]` tag. Completion events reply to this ID. `TagExtractor.getFirstETag()` extracts it.

### 7. Self-Delegation

**Problem**: Agent delegating to itself could cause infinite loops.

**Solution**: Self-delegation requires a `phase` parameter. Without it, the delegate tool throws an error.

**Location**: `delegate.ts` lines 86-90

---

## Debugging Tips

### Jaeger Tracing

All operations are traced. Key spans:

- `tenex.agent.execute` - Agent execution
- `tenex.delegation.completion_check` - Delegation completion detection
- `tenex.delegation.resumption` - Agent resumption after delegation
- `tenex.busy_responder.generate` - TimeoutResponder acknowledgment
- `ral.event_queued` - Message queued for injection
- `ral.injections_persisted` - Messages injected into step

### Key Trace Attributes

```
delegation.all_complete: boolean
delegation.pending_count: number
delegation.completed_count: number
delegation.event_id: string
ral.status: "executing" | "paused" | "done"
ral.pending_delegations: number
```

### Trace ID Format

The trace ID is derived from the conversation ID (first 32 characters).

Query example:
```bash
curl "http://localhost:16686/api/traces/<conversation_id_first_32_chars>"
```

---

## Summary: The Complete Flow

```
1. User sends message to Agent A
     │
2. Agent A decides to delegate to Agent B and C
     │
3. Agent A calls delegate([{recipient: "B", ...}, {recipient: "C", ...}])
     │
4. delegate() publishes kind:1111 events, returns StopExecutionSignal
     │
5. onStopCheck detects signal, saves RAL state immediately, returns true
     │
6. Agent A pauses (status: "paused", pendingDelegations: [B, C])
     │
7. Agent B receives delegation, executes, completes
     │
8. Agent B's completion event arrives, p-tags Agent A
     │
9. DelegationCompletionHandler processes:
   - Records completion for B
   - Returns shouldReactivate: true (even with C pending)
   - delegationStatus: {completed: [B], pending: [C]}
     │
10. reply.ts injects system message:
    "Delegation responses received (1/2):
     - B: <response>
     Still waiting for: C"
     │
11. Agent A resumes, sees partial results
     │
12. Agent A decides what to do:
    - Wait? Continue tool use
    - Respond? Publish partial response
     │
13. Agent C completes
     │
14. Same flow: completion detected, resumption triggered
     │
15. Agent A sees:
    "Delegation responses received (2/2):
     - B: <response>
     - C: <response>"
     │
16. Agent A synthesizes and publishes final response
     │
17. RAL cleared (status: done)
```

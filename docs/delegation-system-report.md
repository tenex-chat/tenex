# Delegation System Architecture Report

## Overview

The delegation system enables agents to delegate tasks to other agents without blocking, pause their execution while waiting for results, and resume seamlessly when delegations complete. The system is entirely event-driven, using Nostr event tags for tracking and coordination.

---

## Core Components

### 1. RALRegistry (Request-Agent Loop Registry)

The central state manager for agent executions. Maintains:

- **Agent execution states** (executing, paused, done)
- **Pending delegations** (tasks sent to other agents, awaiting response)
- **Completed delegations** (responses received)
- **Queued injections** (messages to inject when execution resumes)
- **Abort controllers** (for canceling long-running operations)

### 2. DelegationCompletionHandler

Detects when delegation responses arrive by matching Nostr event tags. Triggers RAL resumption when all delegations complete.

### 3. TimeoutResponder

Handles user messages that arrive during active/paused executions. Uses AI to generate acknowledgments and queue context for later.

### 4. AgentExecutor

Orchestrates agent execution, manages RAL lifecycle, and handles the streaming LLM interaction.

### 5. AgentPublisher

Publishes Nostr events (delegation requests, responses, acknowledgments).

---

## RAL States

```
┌─────────────┐
│   (none)    │  No RAL exists for this agent
└──────┬──────┘
       │ create()
       ▼
┌─────────────┐
│  executing  │  Agent is actively processing
└──────┬──────┘
       │
       ├─────────────────────────────────────┐
       │ saveState() with pending            │ clear() on completion
       │ delegations                         │
       ▼                                     ▼
┌─────────────┐                       ┌─────────────┐
│   paused    │                       │   (none)    │
└──────┬──────┘                       └─────────────┘
       │
       │ markResuming() when all
       │ delegations complete
       ▼
┌─────────────┐
│  executing  │  (with completedDelegations > 0)
└─────────────┘
```

### State Transitions

| From | To | Trigger | Action |
|------|-----|---------|--------|
| (none) | executing | New message to agent | `create()` |
| executing | paused | Delegate tool returns stop signal | `saveState()` |
| executing | (none) | LLM finishes normally | `clear()` |
| paused | executing | All delegations complete | `markResuming()` |

---

## Delegation Event Tags

Delegation tracking relies entirely on Nostr event tags:

### Delegation Request Event (kind 1111)
```
Tags:
  ["p", "<recipient-pubkey>"]     # Who to delegate to
  ["e", "<triggering-event-id>"]  # Original user request
  ["phase", "<phase-name>"]       # Identifies as delegation
  ["a", "<project-tag>"]          # Project routing
  ["E", "<root-event-id>"]        # Conversation root
  ["K", "<root-event-kind>"]      # Root event kind
  ["P", "<root-event-pubkey>"]    # Root event author
```

### Delegation Response Event (kind 1111)
```
Tags:
  ["e", "<delegation-event-id>"]  # References the delegation request
  ["p", "<delegator-pubkey>"]     # Who delegated (signals completion)
```

The e-tag pointing to the delegation event + p-tag pointing to the delegator is what identifies a response as a delegation completion.

---

## Complete Flow Diagrams

### Flow 1: Basic Delegation

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   User   │     │ Agent A  │     │   RAL    │     │ Agent B  │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ "Help me"      │                │                │
     ├───────────────>│                │                │
     │                │ create()       │                │
     │                ├───────────────>│                │
     │                │                │ status=executing
     │                │                │                │
     │                │ [LLM decides   │                │
     │                │  to delegate]  │                │
     │                │                │                │
     │                │ delegate()     │                │
     │                ├────────────────┼───────────────>│
     │                │                │                │
     │                │ stop signal    │                │
     │                │<───────────────┤                │
     │                │                │                │
     │                │ saveState()    │                │
     │                ├───────────────>│                │
     │                │                │ status=paused  │
     │                │                │ pending=[B]    │
     │                │                │                │
     │                │    [Agent A pauses]             │
     │                │                │                │
     │                │                │                │ [Agent B executes]
     │                │                │                │
     │                │                │    response    │
     │                │                │<───────────────┤
     │                │                │                │
     │                │                │ recordCompletion()
     │                │                │ pending=[]     │
     │                │                │ completed=[B]  │
     │                │                │                │
     │                │                │ allDelegationsComplete()
     │                │                │ = true         │
     │                │                │                │
     │                │ markResuming() │                │
     │                ├───────────────>│                │
     │                │                │ status=executing
     │                │                │                │
     │                │ [Resume with   │                │
     │                │  B's response] │                │
     │                │                │                │
     │  "Here's the   │                │                │
     │   result"      │                │                │
     │<───────────────┤                │                │
     │                │                │                │
     │                │ clear()        │                │
     │                ├───────────────>│                │
     │                │                │ (RAL removed)  │
```

### Flow 2: Message During Paused Execution

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌─────────────┐
│   User   │     │ Agent A  │     │   RAL    │     │TimeoutResp. │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └──────┬──────┘
     │                │                │                   │
     │    [Agent A is paused waiting for delegation]       │
     │                │                │ status=paused     │
     │                │                │                   │
     │ "Update?"      │                │                   │
     ├───────────────>│                │                   │
     │                │                │                   │
     │                │ queueEvent()   │                   │
     │                ├───────────────>│                   │
     │                │                │ queued=[msg]      │
     │                │                │                   │
     │                │ schedule(5s)   │                   │
     │                ├────────────────┼──────────────────>│
     │                │                │                   │
     │                │ return (no new │                   │
     │                │ execution)     │                   │
     │                │                │                   │
     │                │                │     [5 seconds pass]
     │                │                │                   │
     │                │                │   handleTimeout() │
     │                │                │<──────────────────┤
     │                │                │                   │
     │                │                │   generateObject()│
     │                │                │   (AI generates   │
     │                │                │    acknowledgment)│
     │                │                │                   │
     │ "I'm working   │                │                   │
     │  on a task..." │                │                   │
     │<────────────────────────────────┼───────────────────┤
     │                │                │                   │
     │                │                │ swapQueuedEvent() │
     │                │                │<──────────────────┤
     │                │                │ queued=[system    │
     │                │                │  context msg]     │
     │                │                │                   │
     │    [Later: delegation completes, Agent A resumes    │
     │     with the system context message injected]       │
```

### Flow 3: Message During Active Execution

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│   User   │     │ Agent A  │     │   RAL    │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
     │    [Agent A is actively executing]
     │                │                │ status=executing
     │                │                │
     │ "Also do X"    │                │
     ├───────────────>│                │
     │                │                │
     │                │ queueEvent()   │
     │                ├───────────────>│
     │                │                │ queued=[msg]
     │                │                │
     │                │ return (no new │
     │                │ execution)     │
     │                │                │
     │    [Message injected via prepareStep callback]
     │                │                │
     │                │ getAndClearQueued()
     │                ├───────────────>│
     │                │                │ queued=[]
     │                │                │
     │                │ [LLM sees:     │
     │                │  "INJECTED:    │
     │                │   Also do X"]  │
```

---

## Detection Mechanisms

### How Delegation Completion is Detected

1. **Event arrives** at the system (kind 1111)
2. **DelegationCompletionHandler** extracts the e-tag (referenced event ID)
3. **RALRegistry.findAgentWaitingForDelegation()** searches all paused RALs
4. If found, **recordCompletion()** updates state
5. **allDelegationsComplete()** checks if pending list is empty
6. If all complete, returns `{ shouldReactivate: true, isResumption: true }`

### How Resumption is Distinguished from Fresh Execution

When `AgentExecutor.execute()` runs with `status === "executing"`:

| Condition | Interpretation | Action |
|-----------|---------------|--------|
| `completedDelegations.length > 0` | Resumption after delegation | Inject results, continue execution |
| `completedDelegations.length === 0` | Already running | Queue event, schedule timeout, return |

---

## Data Structures

### RALState
```
{
  id: string                        // Unique RAL identifier
  agentPubkey: string               // Agent this RAL belongs to
  messages: CoreMessage[]           // LLM conversation history
  pendingDelegations: [             // Awaiting responses
    {
      eventId: string               // Delegation event ID
      recipientPubkey: string       // Who was delegated to
      recipientSlug?: string        // Agent slug
      prompt: string                // What was delegated
    }
  ]
  completedDelegations: [           // Received responses
    {
      eventId: string               // Original delegation event ID
      recipientPubkey: string       // Who responded
      response: string              // Response content
      responseEventId?: string      // Response event ID
      completedAt: number           // Timestamp
    }
  ]
  queuedInjections: [               // Messages to inject
    {
      type: "user" | "system"
      content: string
      eventId?: string
      queuedAt: number
    }
  ]
  status: "executing" | "paused" | "done"
  currentTool?: string              // For timeout context
  toolStartedAt?: number
  createdAt: number
  lastActivityAt: number
}
```

### Stop Execution Signal
```
{
  __stopExecution: true
  pendingDelegations: PendingDelegation[]
}
```

Returned by the delegate tool to signal the LLM should stop and the RAL should pause.

---

## TimeoutResponder AI Generation

When a user message arrives during active/paused execution and isn't picked up within 5 seconds, TimeoutResponder uses structured generation:

### Schema
```
{
  message_for_user: string              // Acknowledgment to publish
  system_message_for_active_ral: string // Context for resumed execution
  stop_current_step: boolean            // Whether to abort current tool
}
```

### Context Provided to AI
- Agent's role, description, custom instructions
- Current RAL messages (conversation so far)
- Execution state summary (current tool, how long running)
- The new user message

---

## Multi-Delegation Support

An agent can delegate to multiple agents simultaneously:

```
Agent A delegates to:
  - Agent B (pending)
  - Agent C (pending)

Agent B responds → recordCompletion()
  - Agent B (completed)
  - Agent C (pending)
  allDelegationsComplete() = false

Agent C responds → recordCompletion()
  - Agent B (completed)
  - Agent C (completed)
  allDelegationsComplete() = true → trigger resumption
```

Only when ALL pending delegations have responses does resumption occur.

---

## Message Injection System

### prepareStep Callback

The AI SDK's `streamText` accepts a `prepareStep` callback called before each LLM step. This is where queued messages are injected:

1. **Check RAL for queued injections** via `getAndClearQueued()`
2. **Check legacy injection queue** (for active execution injection)
3. **Prepend messages** to the step's message array
4. LLM sees injected messages as part of conversation

### Injection Message Format

User messages are wrapped with a system signal:
```
[INJECTED USER MESSAGE]: A new message has arrived while you were working.
Prioritize this instruction.
```

---

## Error Handling

### Delegation Response Never Arrives

Currently, there's no timeout for pending delegations. A paused RAL will wait indefinitely. Future enhancement: implement delegation timeout with configurable duration.

### Delegatee Fails

If the delegated agent encounters an error and publishes an error event instead of a response, the current system doesn't recognize this as a completion. Future enhancement: detect error responses and handle appropriately.

### RAL State Persistence

RAL state is currently in-memory only. If the server restarts, all RAL state is lost. Paused agents will not resume. Future enhancement: persist RAL state to storage.

---

## Security Considerations

### Event Validation

- Delegation responses are validated by checking both e-tag (references delegation) AND p-tag (mentions delegator)
- This prevents arbitrary events from triggering resumption
- Only events from the expected recipient with proper tags are accepted

### Agent Isolation

- Each agent has its own RAL entry keyed by pubkey
- Agents cannot interfere with each other's RAL state
- Delegation must go through proper Nostr event publishing

---

## Configuration

### Timeout Duration

TimeoutResponder default: **5000ms** (5 seconds)

Configurable per-schedule via the `timeoutMs` parameter.

---

## Summary Table

| Scenario | RAL Status | Action | Result |
|----------|-----------|--------|--------|
| New message, no RAL | (none) | Create RAL, execute | Normal execution |
| New message, executing | executing | Queue, timeout | Injection or acknowledgment |
| New message, paused | paused | Queue, timeout | Acknowledgment, wait for delegation |
| Delegation response, partial | paused | Record completion | Continue waiting |
| Delegation response, all complete | paused | Trigger resumption | Resume with results |
| Resumption execution | executing (w/ completed) | Inject results | Continue execution |
| Normal completion | executing | Clear RAL | Clean up |

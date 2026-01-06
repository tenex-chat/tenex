# Experimental Delegation Architecture

> Status: Superseded. The current implementation uses `RALRegistry` with queued injections and ConversationStore-backed messages. The proposed `TimeoutResponder` does not exist. See `docs/DELEGATION-AND-RAL-PROCESSING.md` for the up-to-date flow.

## Overview

This design transforms agent delegation from a blocking synchronous model to an event-driven asynchronous model with RAL (Request-Agent Loop) state persistence.

## Goals

1. Delegation tools no longer block - they publish events and stop execution
2. RALs keep state across re-invocations via a registry
3. Agents are informed about pending delegations via system prompt injection
4. Agents receive p-tagged events even while executing (injection at tool boundaries)
5. Responsive UX - timeout responder acknowledges messages when agent is busy

## Data Structures

### RAL Registry Entry

```typescript
interface RALRegistryEntry {
  id: string;
  agentPubkey: string;

  messages: CoreMessage[];
  pendingDelegations: PendingDelegation[];
  completedDelegations: CompletedDelegation[];

  queuedUserEvents: NDKEvent[];
  queuedSystemMessages: string[];

  status: 'executing' | 'paused' | 'done';
  currentTool?: string;
  toolElapsedMs?: number;

  createdAt: number;
  lastActivityAt: number;
}

interface PendingDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  prompt: string;
}

interface CompletedDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  response: string;
  completedAt: number;
}
```

### Delegation Event ID Mapping

```typescript
// Reverse lookup: delegationEventId → ralId
// Used when completion e-tags a delegation event
```

## Components

### 1. RALRegistry

Responsibilities:
- Store/restore RAL state
- Queue events for injection
- Track execution status
- Map delegation event IDs to RAL IDs
- Provide abort controller for tool cancellation

### 2. AgentExecutor

Responsibilities:
- Route incoming events to fresh/resume/queue
- Run RAL loop with injection points
- Handle RAL completion (persist or clear)

```typescript
class AgentExecutor {
  async execute(agent: Agent, event: NDKEvent): Promise<void> {
    const ral = await this.ralRegistry.getStateByAgent(agent.pubkey);

    if (!ral) {
      return this.freshExecution(agent, event);
    }

    if (ral.status === 'executing') {
      return this.queueForInjection(ral, event);
    }

    if (ral.status === 'paused') {
      return this.resumeExecution(ral, event);
    }
  }
}
```

### 3. TimeoutResponder

Responsibilities:
- Generate acknowledgments when RAL is slow (5s timeout)
- Swap queued user message with system message
- Abort current tool if requested

Schema for generateObject:
```typescript
{
  message_for_user: string,
  system_message_for_active_ral: string,
  stop_current_step: boolean
}
```

### 4. Delegation Tools (All Non-Blocking)

All delegation-related tools follow the same pattern: publish event(s), return stop signal.

#### delegate

Note: "mode" parameter removed. The old "pair" mode (periodic check-ins) is superseded by
the injection mechanism - delegating agents can receive messages anytime during execution.

```typescript
async function delegate(params, context): Promise<DelegateResult> {
  const delegations: PendingDelegation[] = [];

  for (const d of params.delegations) {
    const recipientPubkey = await resolveRecipientToPubkey(d.recipient);

    const eventId = await context.publisher.delegate({
      recipient: recipientPubkey,
      prompt: d.prompt,
      phase: d.phase,
      branch: d.branch,
    });

    delegations.push({
      eventId,
      recipientPubkey,
      recipientSlug: d.recipient,
      prompt: d.prompt,
    });
  }

  return {
    __stopExecution: true,
    pendingDelegations: delegations,
  };
}
```

#### delegate_followup

Send follow-up question to a previous delegation recipient.

```typescript
async function delegateFollowup(params, context): Promise<DelegateFollowupResult> {
  const { recipient, message } = params;
  const recipientPubkey = resolveRecipientToPubkey(recipient);

  // Find previous delegation in RAL state to get threading context
  const previousDelegation = context.ralState.completedDelegations.find(
    d => d.recipientPubkey === recipientPubkey
  );

  if (!previousDelegation) {
    throw new Error(`No previous delegation to ${recipient} found`);
  }

  const eventId = await context.publisher.delegateFollowup({
    recipient: recipientPubkey,
    message,
    replyTo: previousDelegation.responseEventId,
  });

  return {
    __stopExecution: true,
    pendingDelegations: [{
      eventId,
      recipientPubkey,
      recipientSlug: recipient,
      prompt: message,
      isFollowup: true,
    }],
  };
}
```

#### delegate_external

Delegate to agents in other projects.

```typescript
async function delegateExternal(params, context): Promise<DelegateExternalResult> {
  const { content, recipient, projectId } = params;
  const pubkey = parseNostrUser(recipient);

  const eventId = await context.publisher.delegateExternal({
    recipient: pubkey,
    content,
    projectId,
  });

  return {
    __stopExecution: true,
    pendingDelegations: [{
      eventId,
      recipientPubkey: pubkey,
      prompt: content,
      isExternal: true,
      projectId,
    }],
  };
}
```

#### ask

Ask questions to project owner/human.

```typescript
async function ask(params, context): Promise<AskResult> {
  const { content, suggestions } = params;
  const ownerPubkey = getProjectContext()?.project?.pubkey;

  if (!ownerPubkey) {
    throw new Error("No project owner configured");
  }

  const eventId = await context.publisher.ask({
    recipient: ownerPubkey,
    content,
    suggestions,
  });

  return {
    __stopExecution: true,
    pendingDelegations: [{
      eventId,
      recipientPubkey: ownerPubkey,
      prompt: content,
      isAsk: true,
      suggestions,
    }],
  };
}
```

All tools:
- Publish their specific event type
- Return `__stopExecution: true`
- Include `pendingDelegations` array for RAL registry

## Flows

### Fresh Execution

```
Event arrives → No RAL state → Create RAL (executing) → Run loop → Completion
```

### Delegation Pause

```
Running RAL → delegate() called → Returns __stopExecution
→ stopWhen detects signal → Loop exits
→ Save state with pendingDelegations → Status: paused
→ Register delegationEventId → ralId mappings
```

### Resume on Delegation Completion

```
Completion event arrives → e-tag contains delegationEventId
→ Look up ralId → Record completion in RAL state
→ Build delegation status system prompt
→ Restore messages + inject status + add response
→ Status: executing → Run loop
```

### Injection During Execution

```
Event p-tags executing agent → Queue in RAL registry
→ Start 5s timeout
→ Next prepareStep in RAL loop:
  - Check queued events/messages
  - Inject into messages array
  - Continue to LLM call
→ Agent sees injected message, responds naturally
```

### Timeout Response

```
5s passes, event still queued → Run generateObject with full context
→ Check if still queued (race condition)
→ If yes:
  - Publish message_for_user to user
  - Swap queued user event → system message
  - If stop_current_step: abort current tool
→ RAL eventually picks up system message at next boundary
```

## State Transitions

```
(none) ──► executing ──► paused ──► executing ──► (cleared)
              │             ▲           │
              │   delegation│           │ finish_reason: done
              └─────────────┘           ▼
                                    (cleared)
```

- `executing`: RAL is actively running, tools executing
- `paused`: RAL stopped (delegation), waiting for events
- `(cleared)`: finish_reason: done - state deleted

## Deletions

- `DelegationService` - no longer needed (tools publish directly)
- `DelegationRegistryService` - replaced by RALRegistry
- Blocking wait logic in all delegation tools
- Complex response aggregation
- "pair" mode with check-ins - replaced by injection mechanism (user can message agent anytime)
- `PairModeController` and `PairModeRegistry` - no longer needed

## Injection Mechanism

Using AI SDK's `prepareStep` callback:

```typescript
prepareStep: async ({ messages: currentMessages }) => {
  const { userEvents, systemMessages } = await this.ralRegistry.getAndClearQueued(ralId);

  const injections: Message[] = [];

  for (const sysMsg of systemMessages) {
    injections.push({ role: 'system', content: sysMsg });
  }

  for (const event of userEvents) {
    injections.push({ role: 'user', content: event.content });
  }

  if (injections.length > 0) {
    return { messages: [...currentMessages, ...injections] };
  }

  return { messages: currentMessages };
}
```

## Tool Abort Mechanism

```typescript
// RALRegistry tracks abort controllers per RAL
const abortController = new AbortController();
ralRegistry.registerAbortController(ralId, abortController);

// Tools use the signal
const result = await exec(command, { signal: abortController.signal });

// TimeoutResponder can abort
if (response.stop_current_step) {
  await ralRegistry.abortCurrentTool(ralId);
}

// Tool returns abort result
{ error: 'aborted', reason: 'user interrupt' }
```

## Delegation Status Injection

When resuming a paused RAL:

```typescript
function buildDelegationStatusPrompt(ral: RALRegistryEntry): string {
  const completed = ral.completedDelegations.map(d => d.recipientSlug ?? d.recipientPubkey);
  const pending = ral.pendingDelegations
    .filter(p => !ral.completedDelegations.some(c => c.eventId === p.eventId))
    .map(d => d.recipientSlug ?? d.recipientPubkey);

  if (pending.length === 0) {
    return `All delegations completed. Responses received from: ${completed.join(', ')}.`;
  }

  return `Delegation status: ${completed.length} of ${completed.length + pending.length} completed.
Received responses from: ${completed.join(', ')}.
Still waiting on: ${pending.join(', ')}.`;
}
```

## Event Handler (reply.ts)

Stays thin - just routes to executor:

```typescript
async function handleChatMessage(event: NDKEvent) {
  const targetAgents = await AgentRouter.resolveTargetAgents(event);

  for (const agent of targetAgents) {
    await agentExecutor.execute(agent, event);
  }
}
```

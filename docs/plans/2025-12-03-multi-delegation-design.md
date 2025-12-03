# Multi-Delegation Design

## Overview

Add capability for agents to delegate different tasks to multiple agents in parallel, each with their own prompt, phase, and git worktree. The delegator waits for all agents to complete and receives aggregated responses.

**Use case example:**
```ts
delegate_multi({
  delegations: [
    { to: "coder", task: "Implement calculator using OOP patterns", branch: "calc-oop", phase: "implementation" },
    { to: "coder", task: "Implement calculator using FP patterns", branch: "calc-func", phase: "implementation" }
  ]
})
// Returns both responses once both agents complete
```

## Design Decisions

1. **New tool (`delegate_multi`)** — purpose-built for fork-join pattern
2. **Refactor `DelegationIntent`** — use `delegations[]` array everywhere, no backwards compat
3. **N distinct nostr events** — one event per delegation (not one event with N p-tags)
4. **N distinct worktrees** — per-delegation worktree creation
5. **Per-delegation event IDs** — each delegation record tracks its own event ID
6. **Tool returns all responses** — delegator's LLM continues with aggregated results

---

## Tool Schema

### `delegate_multi.ts`

```ts
const delegateMultiSchema = z.object({
  delegations: z
    .array(
      z.object({
        to: z.string().describe("Agent slug, name, npub, or hex pubkey"),
        task: z.string().describe("The specific task/prompt for this agent"),
        branch: z.string().optional().describe("Git branch name for worktree isolation"),
        phase: z.string().optional().describe("Phase to switch to for this delegation"),
      })
    )
    .min(1)
    .describe("Array of delegations to execute in parallel"),
});
```

**Tool description:**
> "Delegate different tasks to multiple agents in parallel, each with their own prompt and optional isolated git worktree. Waits for all agents to complete and returns all responses together. Use when you need to explore multiple approaches simultaneously or divide work across specialists."

---

## Type Changes

### `AgentEventEncoder.ts` — DelegationIntent

```ts
// OLD
export interface DelegationIntent {
  recipients: string[];
  request: string;
  phase?: string;
  phaseInstructions?: string;
  branch?: string;
  type?: "delegation" | "delegation_followup" | "ask";
}

// NEW
export interface DelegationIntent {
  delegations: Array<{
    recipient: string;
    request: string;
    phase?: string;
    phaseInstructions?: string;
    branch?: string;
  }>;
  type?: "delegation" | "delegation_followup" | "ask";
}
```

### `DelegationService.ts` — DelegationResponses

```ts
// OLD
export interface DelegationResponses {
  type: "delegation_responses";
  responses: Array<{
    response: string;
    summary?: string;
    from: string;
    event?: NDKEvent;
  }>;
  worktree?: {
    branch: string;
    path: string;
    message: string;
  };
}

// NEW
export interface DelegationResponses {
  type: "delegation_responses";
  responses: Array<{
    response: string;
    summary?: string;
    from: string;
    event?: NDKEvent;
  }>;
  worktrees?: Array<{
    branch: string;
    path: string;
  }>;
}
```

---

## Implementation Changes

### 1. `AgentEventEncoder.encodeDelegation()` — Return N events

```ts
encodeDelegation(intent: DelegationIntent, context: EventContext): NDKEvent[] {
  return intent.delegations.map(delegation => {
    const event = new NDKEvent(getNDK());
    event.kind = 1111;
    event.content = this.prependRecipientsToContent(
      delegation.request,
      [delegation.recipient]
    );
    event.created_at = Math.floor(Date.now() / 1000) + 1;

    this.addConversationTags(event, context);
    event.tag(["p", delegation.recipient]);

    if (delegation.phase) {
      event.tag(["phase", delegation.phase]);
      if (delegation.phaseInstructions) {
        event.tag(["phase-instructions", delegation.phaseInstructions]);
      }
    }

    if (delegation.branch) {
      event.tag(["branch", delegation.branch]);
    }

    this.addStandardTags(event, context);
    return event;
  });
}
```

### 2. `DelegationRegistry.registerDelegation()` — Per-delegation event IDs

```ts
async registerDelegation(params: {
  delegations: Array<{
    eventId: string;
    pubkey: string;
    request: string;
    phase?: string;
  }>;
  delegatingAgent: AgentInstance;
  rootConversationId: string;
}): Promise<string> {
  const batchId = this.generateBatchId();

  const batch: DelegationBatch = {
    batchId,
    delegatingAgent: params.delegatingAgent.pubkey,
    delegationKeys: [],
    allCompleted: false,
    createdAt: Date.now(),
    originalRequest: params.delegations.map(d => d.request).join(" | "),
    rootConversationId: params.rootConversationId,
  };

  for (const delegation of params.delegations) {
    const convKey = `${params.rootConversationId}:${params.delegatingAgent.pubkey}:${delegation.pubkey}`;

    const record: DelegationRecord = {
      delegationEventId: delegation.eventId,
      delegationBatchId: batchId,
      delegatingAgent: {
        slug: params.delegatingAgent.slug,
        pubkey: params.delegatingAgent.pubkey,
        rootConversationId: params.rootConversationId,
      },
      assignedTo: { pubkey: delegation.pubkey },
      content: {
        fullRequest: delegation.request,
        phase: delegation.phase,
      },
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      siblingDelegationIds: [],
    };

    this.delegations.set(convKey, record);
    batch.delegationKeys.push(convKey);
    this.indexDelegation(record);
  }

  // Update sibling IDs
  for (const convKey of batch.delegationKeys) {
    const record = this.delegations.get(convKey);
    if (record) {
      record.siblingDelegationIds = batch.delegationKeys.filter(k => k !== convKey);
    }
  }

  this.batches.set(batchId, batch);
  this.schedulePersistence();

  return batchId;
}
```

### 3. `AgentPublisher.delegate()` — Publish N events

```ts
async delegate(
  intent: DelegationIntent,
  context: EventContext
): Promise<{ events: NDKEvent[]; batchId: string }> {
  const events = this.encoder.encodeDelegation(intent, context);

  // Inject trace context
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    for (const event of events) {
      if (carrier.traceparent) {
        event.tags.push(["trace_context", carrier.traceparent]);
      }
    }
  }

  // Sign all events first (to get IDs)
  for (const event of events) {
    await this.agent.sign(event);
  }

  // Register with per-delegation event IDs
  const registry = DelegationRegistry.getInstance();
  const batchId = await registry.registerDelegation({
    delegations: intent.delegations.map((d, i) => ({
      eventId: events[i].id,
      pubkey: d.recipient,
      request: d.request,
      phase: d.phase,
    })),
    delegatingAgent: this.agent,
    rootConversationId: context.rootEvent.id,
  });

  // Publish all events
  for (const event of events) {
    await this.safePublish(event, "delegation request");
  }

  return { events, batchId };
}
```

### 4. `DelegationService.execute()` — Worktree loop

```ts
async execute(intent: DelegationIntent): Promise<DelegationResponses> {
  // Validate recipients, check self-delegation...

  // Create worktrees for delegations that specify a branch
  const worktrees: Array<{ branch: string; path: string }> = [];

  for (const delegation of intent.delegations) {
    if (delegation.branch) {
      const { createWorktree } = await import("@/utils/git/initializeGitRepo");
      const { trackWorktreeCreation } = await import("@/utils/git/worktree");

      const worktreePath = await createWorktree(
        context.projectPath,
        delegation.branch,
        context.currentBranch
      );

      await trackWorktreeCreation(context.projectPath, {
        path: worktreePath,
        branch: delegation.branch,
        createdBy: this.agent.pubkey,
        conversationId: this.conversationId,
        parentBranch: context.currentBranch,
      });

      worktrees.push({ branch: delegation.branch, path: worktreePath });
    }
  }

  // Publish and wait
  const result = await this.publisher.delegate(intent, eventContext);
  const registry = DelegationRegistry.getInstance();
  const completions = await registry.waitForBatchCompletion(result.batchId);

  return {
    type: "delegation_responses",
    responses: completions.map(c => ({
      response: c.response,
      summary: c.summary,
      from: c.assignedTo,
      event: c.event,
    })),
    worktrees: worktrees.length > 0 ? worktrees : undefined,
  };
}
```

### 5. Adapt existing tools

**`delegate.ts`:**
```ts
return await delegationService.execute({
  delegations: resolvedPubkeys.map(pubkey => ({
    recipient: pubkey,
    request: fullRequest,
  })),
});
```

**`delegate_phase.ts`:**
```ts
// Remove worktree creation (moved to DelegationService)
return await delegationService.execute({
  delegations: resolvedPubkeys.map(pubkey => ({
    recipient: pubkey,
    request: prompt,
    phase: actualPhaseName,
    phaseInstructions: phase_instructions,
    branch,
  })),
});
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/nostr/AgentEventEncoder.ts` | Update `DelegationIntent` type, `encodeDelegation()` returns N events |
| `src/nostr/AgentPublisher.ts` | Update `delegate()` to register per-delegation event IDs |
| `src/services/delegation/DelegationRegistry.ts` | Update `registerDelegation()` signature |
| `src/services/delegation/DelegationService.ts` | Add worktree loop, update response type |
| `src/tools/implementations/delegate.ts` | Adapt to `delegations[]` format |
| `src/tools/implementations/delegate_phase.ts` | Adapt to `delegations[]`, remove worktree creation |
| `src/tools/implementations/delegate_multi.ts` | **New file** — the new tool |

---

## Testing

1. **Unit tests for `encodeDelegation()`** — verify N events created with correct content/tags
2. **Unit tests for registry** — verify per-delegation event ID tracking
3. **Integration test** — delegate_multi creates 2 worktrees, 2 events, waits for both responses
4. **Existing delegate/delegate_phase tests** — ensure they still work with new format

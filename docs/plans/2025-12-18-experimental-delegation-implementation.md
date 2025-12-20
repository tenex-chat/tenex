# Experimental Delegation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform delegation from blocking/synchronous to event-driven/async with RAL state persistence.

**Architecture:** RALRegistry stores execution state keyed by agent pubkey. AgentExecutor checks registry on each invocation to route to fresh/resume/queue paths. Delegation tools return stop signals instead of blocking.

**Tech Stack:** TypeScript, AI SDK, Nostr/NDK, Zod

---

## Task 1: Create RALRegistry Types

**Files:**
- Create: `src/services/ral/types.ts`

**Step 1: Write the types file**

```typescript
import type { CoreMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export type RALStatus = "executing" | "paused" | "done";

export interface PendingDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  prompt: string;
  isFollowup?: boolean;
  isExternal?: boolean;
  isAsk?: boolean;
  projectId?: string;
  suggestions?: string[];
}

export interface CompletedDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  response: string;
  responseEventId?: string;
  completedAt: number;
}

export interface QueuedInjection {
  type: "user" | "system";
  content: string;
  eventId?: string;
  queuedAt: number;
}

export interface RALState {
  id: string;
  agentPubkey: string;
  messages: CoreMessage[];
  pendingDelegations: PendingDelegation[];
  completedDelegations: CompletedDelegation[];
  queuedInjections: QueuedInjection[];
  status: RALStatus;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface StopExecutionSignal {
  __stopExecution: true;
  pendingDelegations: PendingDelegation[];
}

export function isStopExecutionSignal(value: unknown): value is StopExecutionSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "__stopExecution" in value &&
    (value as StopExecutionSignal).__stopExecution === true
  );
}
```

**Step 2: Commit**

```bash
git add src/services/ral/types.ts
git commit -m "feat(ral): add RALRegistry types"
```

---

## Task 2: Create RALRegistry Service

**Files:**
- Create: `src/services/ral/RALRegistry.ts`

**Step 1: Write the RALRegistry implementation**

```typescript
import type { CoreMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import type {
  RALState,
  RALStatus,
  PendingDelegation,
  CompletedDelegation,
  QueuedInjection,
} from "./types";

export class RALRegistry {
  private static instance: RALRegistry;
  private states: Map<string, RALState> = new Map();
  private delegationToRal: Map<string, string> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  private constructor() {}

  static getInstance(): RALRegistry {
    if (!RALRegistry.instance) {
      RALRegistry.instance = new RALRegistry();
    }
    return RALRegistry.instance;
  }

  /**
   * Create a new RAL entry for an agent
   */
  create(agentPubkey: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();

    const state: RALState = {
      id,
      agentPubkey,
      messages: [],
      pendingDelegations: [],
      completedDelegations: [],
      queuedInjections: [],
      status: "executing",
      createdAt: now,
      lastActivityAt: now,
    };

    this.states.set(agentPubkey, state);

    logger.debug("[RALRegistry] Created RAL", {
      ralId: id.substring(0, 8),
      agentPubkey: agentPubkey.substring(0, 8),
    });

    return id;
  }

  /**
   * Get RAL state by agent pubkey
   */
  getStateByAgent(agentPubkey: string): RALState | undefined {
    return this.states.get(agentPubkey);
  }

  /**
   * Get RAL ID for a delegation event ID
   */
  getRalIdForDelegation(delegationEventId: string): string | undefined {
    return this.delegationToRal.get(delegationEventId);
  }

  /**
   * Update RAL status
   */
  setStatus(agentPubkey: string, status: RALStatus): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      state.status = status;
      state.lastActivityAt = Date.now();
    }
  }

  /**
   * Save messages and pending delegations (called when RAL pauses)
   */
  saveState(
    agentPubkey: string,
    messages: CoreMessage[],
    pendingDelegations: PendingDelegation[]
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) {
      logger.warn("[RALRegistry] No RAL found to save state", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
      return;
    }

    state.messages = messages;
    state.pendingDelegations = pendingDelegations;
    state.status = "paused";
    state.lastActivityAt = Date.now();

    // Register delegation event ID -> RAL ID mappings
    for (const d of pendingDelegations) {
      this.delegationToRal.set(d.eventId, state.id);
    }

    logger.debug("[RALRegistry] Saved RAL state", {
      ralId: state.id.substring(0, 8),
      messageCount: messages.length,
      pendingCount: pendingDelegations.length,
    });
  }

  /**
   * Record a delegation completion
   */
  recordCompletion(
    agentPubkey: string,
    completion: CompletedDelegation
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.completedDelegations.push(completion);
    state.lastActivityAt = Date.now();

    // Remove from pending
    state.pendingDelegations = state.pendingDelegations.filter(
      (p) => p.eventId !== completion.eventId
    );

    logger.debug("[RALRegistry] Recorded completion", {
      ralId: state.id.substring(0, 8),
      completedEventId: completion.eventId.substring(0, 8),
      remainingPending: state.pendingDelegations.length,
    });
  }

  /**
   * Queue an event for injection
   */
  queueEvent(agentPubkey: string, event: NDKEvent): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.queuedInjections.push({
      type: "user",
      content: event.content,
      eventId: event.id,
      queuedAt: Date.now(),
    });

    logger.debug("[RALRegistry] Queued event for injection", {
      ralId: state.id.substring(0, 8),
      eventId: event.id?.substring(0, 8),
    });
  }

  /**
   * Queue a system message for injection
   */
  queueSystemMessage(agentPubkey: string, content: string): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.queuedInjections.push({
      type: "system",
      content,
      queuedAt: Date.now(),
    });
  }

  /**
   * Check if an event is still queued
   */
  eventStillQueued(agentPubkey: string, eventId: string): boolean {
    const state = this.states.get(agentPubkey);
    if (!state) return false;
    return state.queuedInjections.some((i) => i.eventId === eventId);
  }

  /**
   * Get and clear queued injections
   */
  getAndClearQueued(agentPubkey: string): QueuedInjection[] {
    const state = this.states.get(agentPubkey);
    if (!state) return [];

    const injections = [...state.queuedInjections];
    state.queuedInjections = [];
    return injections;
  }

  /**
   * Swap a queued user event with a system message
   */
  swapQueuedEvent(
    agentPubkey: string,
    eventId: string,
    systemContent: string
  ): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    // Remove the user event
    state.queuedInjections = state.queuedInjections.filter(
      (i) => i.eventId !== eventId
    );

    // Add system message
    state.queuedInjections.push({
      type: "system",
      content: systemContent,
      queuedAt: Date.now(),
    });
  }

  /**
   * Set current tool being executed (for timeout responder context)
   */
  setCurrentTool(agentPubkey: string, toolName: string | undefined): void {
    const state = this.states.get(agentPubkey);
    if (!state) return;

    state.currentTool = toolName;
    state.toolStartedAt = toolName ? Date.now() : undefined;
  }

  /**
   * Register an abort controller for the current tool
   */
  registerAbortController(
    agentPubkey: string,
    controller: AbortController
  ): void {
    this.abortControllers.set(agentPubkey, controller);
  }

  /**
   * Abort current tool execution
   */
  abortCurrentTool(agentPubkey: string): void {
    const controller = this.abortControllers.get(agentPubkey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(agentPubkey);
      logger.info("[RALRegistry] Aborted current tool", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
    }
  }

  /**
   * Clear RAL state (called on finish_reason: done)
   */
  clear(agentPubkey: string): void {
    const state = this.states.get(agentPubkey);
    if (state) {
      // Clean up delegation mappings
      for (const d of state.pendingDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
      for (const d of state.completedDelegations) {
        this.delegationToRal.delete(d.eventId);
      }
    }

    this.states.delete(agentPubkey);
    this.abortControllers.delete(agentPubkey);

    logger.debug("[RALRegistry] Cleared RAL state", {
      agentPubkey: agentPubkey.substring(0, 8),
    });
  }

  /**
   * Get summary of RAL state for timeout responder
   */
  getStateSummary(agentPubkey: string): string {
    const state = this.states.get(agentPubkey);
    if (!state) return "No active execution";

    const toolInfo = state.currentTool
      ? `Running tool: ${state.currentTool} for ${Date.now() - (state.toolStartedAt || 0)}ms`
      : "Between tool calls";

    const recentMessages = state.messages
      .slice(-4)
      .map((m) => `${m.role}: ${String(m.content).substring(0, 80)}...`)
      .join("\n");

    return `${toolInfo}\n\nRecent context:\n${recentMessages}`;
  }
}
```

**Step 2: Create index file**

Create `src/services/ral/index.ts`:

```typescript
export { RALRegistry } from "./RALRegistry";
export * from "./types";
```

**Step 3: Commit**

```bash
git add src/services/ral/
git commit -m "feat(ral): add RALRegistry service"
```

---

## Task 3: Create TimeoutResponder Service

**Files:**
- Create: `src/services/ral/TimeoutResponder.ts`

**Step 1: Write the TimeoutResponder implementation**

```typescript
import { generateObject } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import { RALRegistry } from "./RALRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { logger } from "@/utils/logger";
import { LLMServiceFactory } from "@/llm/LLMServiceFactory";

const TimeoutResponseSchema = z.object({
  message_for_user: z.string().describe(
    "Response to send to the user now, acknowledging their message"
  ),
  system_message_for_active_ral: z.string().describe(
    "Context note for your main execution to see when it resumes"
  ),
  stop_current_step: z.boolean().describe(
    "true to abort the current tool execution immediately, false to let it finish"
  ),
});

export class TimeoutResponder {
  private static instance: TimeoutResponder;
  private pendingTimeouts: Map<string, NodeJS.Timeout> = new Map();

  private constructor() {}

  static getInstance(): TimeoutResponder {
    if (!TimeoutResponder.instance) {
      TimeoutResponder.instance = new TimeoutResponder();
    }
    return TimeoutResponder.instance;
  }

  /**
   * Schedule a timeout response for a queued event
   */
  schedule(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher,
    timeoutMs: number = 5000
  ): void {
    const key = `${agentPubkey}:${event.id}`;

    // Clear any existing timeout for this event
    const existing = this.pendingTimeouts.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(
      () => this.handleTimeout(agentPubkey, event, agent, publisher),
      timeoutMs
    );

    this.pendingTimeouts.set(key, timeout);

    logger.debug("[TimeoutResponder] Scheduled timeout", {
      agentPubkey: agentPubkey.substring(0, 8),
      eventId: event.id?.substring(0, 8),
      timeoutMs,
    });
  }

  /**
   * Cancel a pending timeout (called when RAL picks up the event)
   */
  cancel(agentPubkey: string, eventId: string): void {
    const key = `${agentPubkey}:${eventId}`;
    const timeout = this.pendingTimeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(key);
    }
  }

  private async handleTimeout(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher
  ): Promise<void> {
    const registry = RALRegistry.getInstance();

    // Check if RAL already picked up the message
    if (!registry.eventStillQueued(agentPubkey, event.id!)) {
      logger.debug("[TimeoutResponder] Event already picked up, skipping", {
        eventId: event.id?.substring(0, 8),
      });
      return;
    }

    const state = registry.getStateByAgent(agentPubkey);
    if (!state) return;

    logger.info("[TimeoutResponder] Generating timeout response", {
      agentPubkey: agentPubkey.substring(0, 8),
      eventId: event.id?.substring(0, 8),
    });

    try {
      // Get model from agent's LLM service
      const llmService = agent.createLLMService({});
      const model = LLMServiceFactory.getLanguageModel(
        llmService.provider,
        llmService.model
      );

      const summary = registry.getStateSummary(agentPubkey);

      const response = await generateObject({
        model,
        schema: TimeoutResponseSchema,
        system: agent.systemPrompt || agent.description || "",
        messages: [
          ...state.messages,
          {
            role: "system" as const,
            content: `
EXECUTION CONTEXT:
You are mid-execution and cannot immediately process new messages.
${summary}

A user message just arrived but you're busy. Generate:
1. A brief acknowledgment for the user
2. A context note for when you resume
3. Whether to abort current work (true) or let it finish (false)
            `.trim(),
          },
          {
            role: "user" as const,
            content: event.content,
          },
        ],
      });

      // Check again - RAL might have picked it up while we were generating
      if (!registry.eventStillQueued(agentPubkey, event.id!)) {
        logger.debug("[TimeoutResponder] Event picked up during generation", {
          eventId: event.id?.substring(0, 8),
        });
        return;
      }

      // Publish acknowledgment to user
      await publisher.reply(
        { content: response.object.message_for_user },
        {
          triggeringEvent: event,
          rootEvent: event,
          conversationId: event.id!,
        }
      );

      // Swap queued user message -> system message
      registry.swapQueuedEvent(
        agentPubkey,
        event.id!,
        response.object.system_message_for_active_ral
      );

      // Abort current tool if requested
      if (response.object.stop_current_step) {
        registry.abortCurrentTool(agentPubkey);
      }

      logger.info("[TimeoutResponder] Sent timeout response", {
        agentPubkey: agentPubkey.substring(0, 8),
        stopCurrentStep: response.object.stop_current_step,
      });
    } catch (error) {
      logger.error("[TimeoutResponder] Failed to generate response", {
        error,
        agentPubkey: agentPubkey.substring(0, 8),
      });
    } finally {
      this.pendingTimeouts.delete(`${agentPubkey}:${event.id}`);
    }
  }
}
```

**Step 2: Update index**

Update `src/services/ral/index.ts`:

```typescript
export { RALRegistry } from "./RALRegistry";
export { TimeoutResponder } from "./TimeoutResponder";
export * from "./types";
```

**Step 3: Commit**

```bash
git add src/services/ral/
git commit -m "feat(ral): add TimeoutResponder service"
```

---

## Task 4: Modify delegate tool to return stop signal

**Files:**
- Modify: `src/tools/implementations/delegate.ts`

**Step 1: Update delegate tool**

Replace the entire `executeDelegate` function and remove DelegationService usage:

```typescript
import type { ExecutionContext } from "@/agents/execution/types";
import type { PendingDelegation, StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const baseDelegationItemSchema = z.object({
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey"
    ),
  prompt: z.string().describe("The request or task for this agent"),
  branch: z
    .string()
    .optional()
    .describe("Git branch name for worktree isolation"),
});

const phaseDelegationItemSchema = baseDelegationItemSchema.extend({
  phase: z
    .string()
    .optional()
    .describe(
      "Phase to switch to for this delegation (must be defined in your phases configuration)"
    ),
});

type BaseDelegationItem = z.infer<typeof baseDelegationItemSchema>;
type PhaseDelegationItem = z.infer<typeof phaseDelegationItemSchema>;
type DelegationItem = BaseDelegationItem | PhaseDelegationItem;

interface DelegateInput {
  delegations: DelegationItem[];
}

type DelegateOutput = StopExecutionSignal;

async function executeDelegate(
  input: DelegateInput,
  context: ExecutionContext
): Promise<DelegateOutput> {
  const { delegations } = input;

  if (!Array.isArray(delegations) || delegations.length === 0) {
    throw new Error("At least one delegation is required");
  }

  const pendingDelegations: PendingDelegation[] = [];
  const failedRecipients: string[] = [];

  for (const delegation of delegations) {
    const pubkey = resolveRecipientToPubkey(delegation.recipient);
    if (!pubkey) {
      failedRecipients.push(delegation.recipient);
      continue;
    }

    const phase = "phase" in delegation ? delegation.phase : undefined;
    let phaseInstructions: string | undefined;

    if (phase) {
      if (!context.agent.phases) {
        throw new Error(
          `Agent ${context.agent.name} does not have any phases defined.`
        );
      }

      const normalizedPhase = phase.toLowerCase();
      const phaseEntry = Object.entries(context.agent.phases).find(
        ([phaseName]) => phaseName.toLowerCase() === normalizedPhase
      );

      if (!phaseEntry) {
        const availablePhases = Object.keys(context.agent.phases).join(", ");
        throw new Error(
          `Phase '${phase}' not defined. Available: ${availablePhases}`
        );
      }

      phaseInstructions = phaseEntry[1];
    }

    if (pubkey === context.agent.pubkey && !phase) {
      throw new Error(
        `Self-delegation requires a phase. Use delegate with a phase parameter.`
      );
    }

    // Publish delegation event
    if (!context.agentPublisher) {
      throw new Error("AgentPublisher not available");
    }

    const eventId = await context.agentPublisher.delegate(
      {
        recipient: pubkey,
        content: delegation.prompt,
        phase,
        phaseInstructions,
        branch: delegation.branch,
      },
      {
        triggeringEvent: context.triggeringEvent,
        rootEvent: context.getConversation()?.history?.[0] || context.triggeringEvent,
        conversationId: context.conversationId,
      }
    );

    pendingDelegations.push({
      eventId,
      recipientPubkey: pubkey,
      recipientSlug: delegation.recipient,
      prompt: delegation.prompt,
    });
  }

  if (failedRecipients.length > 0) {
    logger.warn("Some recipients could not be resolved", {
      failed: failedRecipients,
    });
  }

  if (pendingDelegations.length === 0) {
    throw new Error("No valid recipients provided.");
  }

  logger.info("[delegate] Published delegations, returning stop signal", {
    count: pendingDelegations.length,
  });

  return {
    __stopExecution: true,
    pendingDelegations,
  };
}

export function createDelegateTool(context: ExecutionContext): AISdkTool {
  const hasPhases =
    context.agent.phases && Object.keys(context.agent.phases).length > 0;

  const delegationItemSchema = hasPhases
    ? phaseDelegationItemSchema
    : baseDelegationItemSchema;

  const delegateSchema = z.object({
    delegations: z
      .array(delegationItemSchema)
      .min(1)
      .describe("Array of delegations to execute"),
  });

  const description = hasPhases
    ? "Delegate tasks to one or more agents. Each delegation can have its own prompt, branch, and phase. Provide complete context - agents have no visibility into your conversation."
    : "Delegate tasks to one or more agents. Each delegation can have its own prompt and branch. Provide complete context - agents have no visibility into your conversation.";

  const aiTool = tool({
    description,
    inputSchema: delegateSchema,
    execute: async (input: unknown) => {
      return await executeDelegate(input as DelegateInput, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: unknown) => {
      if (!args || typeof args !== "object" || !("delegations" in args)) {
        return "Delegating to agent(s)";
      }

      const { delegations } = args as DelegateInput;

      if (!delegations || !Array.isArray(delegations)) {
        return "Delegating to agent(s)";
      }

      if (delegations.length === 1) {
        const d = delegations[0];
        const phaseStr = "phase" in d && d.phase ? ` (${d.phase} phase)` : "";
        return `Delegating to ${d.recipient}${phaseStr}`;
      }

      const recipients = delegations.map((d) => d.recipient).join(", ");
      return `Delegating ${delegations.length} tasks to: ${recipients}`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
```

**Step 2: Commit**

```bash
git add src/tools/implementations/delegate.ts
git commit -m "feat(delegate): return stop signal instead of blocking"
```

---

## Task 5: Modify ask tool to return stop signal

**Files:**
- Modify: `src/tools/implementations/ask.ts`

**Step 1: Update ask tool**

```typescript
import type { ExecutionContext } from "@/agents/execution/types";
import { getProjectContext } from "@/services/ProjectContext";
import type { PendingDelegation, StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const askSchema = z.object({
  content: z.string().describe("The question to ask the project manager or human user"),
  suggestions: z
    .array(z.string())
    .optional()
    .describe(
      "Optional suggestions for response. Empty/not provided for open-ended questions, ['Yes', 'No'] for yes/no questions, or any custom list for multiple choice"
    ),
});

type AskInput = z.infer<typeof askSchema>;
type AskOutput = StopExecutionSignal;

async function executeAsk(input: AskInput, context: ExecutionContext): Promise<AskOutput> {
  const { content, suggestions } = input;

  const projectCtx = getProjectContext();
  const ownerPubkey = projectCtx?.project?.pubkey;

  if (!ownerPubkey) {
    throw new Error("No project owner configured - cannot determine who to ask");
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[ask] Publishing ask event", {
    fromAgent: context.agent.slug,
    hasSuggestions: !!suggestions,
  });

  const eventId = await context.agentPublisher.ask(
    {
      recipient: ownerPubkey,
      content,
      suggestions,
    },
    {
      triggeringEvent: context.triggeringEvent,
      rootEvent: context.getConversation()?.history?.[0] || context.triggeringEvent,
      conversationId: context.conversationId,
    }
  );

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        eventId,
        recipientPubkey: ownerPubkey,
        prompt: content,
        isAsk: true,
        suggestions,
      },
    ],
  };
}

export function createAskTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Ask a question to the project owner and wait for their response. Supports open-ended questions (no suggestions), yes/no questions (suggestions=['Yes', 'No']), or multiple choice questions (custom suggestions list). Use criteria: ONLY use this tool when you need clarification or help FROM A HUMAN, do not use this to ask questions to other agents.",
    inputSchema: askSchema,
    execute: async (input: AskInput) => {
      return await executeAsk(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ content, suggestions }: AskInput) => {
      if (suggestions && suggestions.length > 0) {
        return `Asking: "${content}" [${suggestions.join(", ")}]`;
      }
      return `Asking: "${content}"`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
```

**Step 2: Commit**

```bash
git add src/tools/implementations/ask.ts
git commit -m "feat(ask): return stop signal instead of blocking"
```

---

## Task 6: Modify delegate_followup tool to return stop signal

**Files:**
- Modify: `src/tools/implementations/delegate_followup.ts`

**Step 1: Update delegate_followup tool**

```typescript
import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
import type { PendingDelegation, StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const delegateFollowupSchema = z.object({
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey of the agent you delegated to"
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;
type DelegateFollowupOutput = StopExecutionSignal;

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ExecutionContext
): Promise<DelegateFollowupOutput> {
  const { recipient, message } = input;

  const recipientPubkey = resolveRecipientToPubkey(recipient);
  if (!recipientPubkey) {
    throw new Error(`Could not resolve recipient: ${recipient}`);
  }

  if (recipientPubkey === context.agent.pubkey) {
    throw new Error(`Self-delegation is not permitted with delegate_followup.`);
  }

  // Find previous delegation in RAL state
  const registry = RALRegistry.getInstance();
  const ralState = registry.getStateByAgent(context.agent.pubkey);

  const previousDelegation = ralState?.completedDelegations.find(
    (d) => d.recipientPubkey === recipientPubkey
  );

  if (!previousDelegation) {
    throw new Error(
      `No previous delegation found to ${recipient}. Use delegate first.`
    );
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    toRecipient: recipient,
  });

  const eventId = await context.agentPublisher.delegateFollowup(
    {
      recipient: recipientPubkey,
      content: message,
      replyToEventId: previousDelegation.responseEventId,
    },
    {
      triggeringEvent: context.triggeringEvent,
      rootEvent: context.getConversation()?.history?.[0] || context.triggeringEvent,
      conversationId: context.conversationId,
    }
  );

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        eventId,
        recipientPubkey,
        recipientSlug: recipient,
        prompt: message,
        isFollowup: true,
      },
    ],
  };
}

export function createDelegateFollowupTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Send a follow-up question to an agent you previously delegated to. Use after delegate to ask clarifying questions about their response.",
    inputSchema: delegateFollowupSchema,
    execute: async (input: DelegateFollowupInput) => {
      return await executeDelegateFollowup(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: () => "Sending follow-up question",
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
```

**Step 2: Commit**

```bash
git add src/tools/implementations/delegate_followup.ts
git commit -m "feat(delegate_followup): return stop signal instead of blocking"
```

---

## Task 7: Modify delegate_external tool to return stop signal

**Files:**
- Modify: `src/tools/implementations/delegate_external.ts`

**Step 1: Update delegate_external tool**

```typescript
import type { ExecutionContext } from "@/agents/execution/types";
import { getNDK } from "@/nostr/ndkClient";
import type { PendingDelegation, StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { normalizeNostrIdentifier, parseNostrUser } from "@/utils/nostr-entity-parser";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const delegateExternalSchema = z.object({
  content: z.string().describe("The content of the chat message to send"),
  recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
  projectId: z
    .string()
    .optional()
    .describe(
      "Optional project event ID (naddr1...) to reference in the message."
    ),
});

type DelegateExternalInput = z.infer<typeof delegateExternalSchema>;
type DelegateExternalOutput = StopExecutionSignal;

async function executeDelegateExternal(
  input: DelegateExternalInput,
  context: ExecutionContext
): Promise<DelegateExternalOutput> {
  const { content, recipient, projectId } = input;

  const pubkey = parseNostrUser(recipient);
  if (!pubkey) {
    throw new Error(`Invalid recipient format: ${recipient}`);
  }

  if (pubkey === context.agent.pubkey && !projectId) {
    throw new Error(
      `Self-delegation requires a projectId for cross-project delegation.`
    );
  }

  const ndk = getNDK();
  const cleanProjectId = normalizeNostrIdentifier(projectId) ?? undefined;

  logger.info("[delegate_external] Publishing external delegation", {
    agent: context.agent.name,
    recipientPubkey: pubkey.substring(0, 8),
  });

  // Create delegation event
  const chatEvent = new NDKEvent(ndk);
  chatEvent.kind = 11;
  chatEvent.content = content;
  chatEvent.tags.push(["p", pubkey]);

  if (cleanProjectId) {
    const projectEvent = await ndk.fetchEvent(cleanProjectId);
    if (projectEvent) {
      chatEvent.tag(projectEvent.tagReference());
    }
  }

  await context.agent.sign(chatEvent);
  await chatEvent.publish();

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        eventId: chatEvent.id,
        recipientPubkey: pubkey,
        prompt: content,
        isExternal: true,
        projectId: cleanProjectId,
      },
    ],
  };
}

export function createDelegateExternalTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description: `Delegate a task to an external agent or user. Use this tool only to engage with agents in OTHER projects.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on.`,
    inputSchema: delegateExternalSchema,
    execute: async (input: DelegateExternalInput) => {
      return await executeDelegateExternal(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: unknown) => {
      if (!args || typeof args !== "object") {
        return "Delegating to external agent";
      }

      const { recipient, projectId } = args as Partial<DelegateExternalInput>;

      if (!recipient) {
        return "Delegating to external agent";
      }

      let message = `Delegating to external agent ${recipient}`;
      if (projectId) {
        message += ` in project ${projectId}`;
      }
      return message;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
```

**Step 2: Commit**

```bash
git add src/tools/implementations/delegate_external.ts
git commit -m "feat(delegate_external): return stop signal instead of blocking"
```

---

## Task 8: Add AgentPublisher methods for delegation events

**Files:**
- Modify: `src/nostr/AgentPublisher.ts`

**Step 1: Add delegate, ask, delegateFollowup methods**

Add these methods to the AgentPublisher class (find the class and add before the closing brace):

```typescript
/**
 * Publish a delegation event
 */
async delegate(
  params: {
    recipient: string;
    content: string;
    phase?: string;
    phaseInstructions?: string;
    branch?: string;
  },
  context: EventContext
): Promise<string> {
  const event = new NDKEvent(this.ndk);
  event.kind = 1111;
  event.content = params.content;

  // Add recipient p-tag
  event.tags.push(["p", params.recipient]);

  // Add conversation threading
  if (context.rootEvent) {
    event.tags.push(["E", context.rootEvent.id]);
    event.tags.push(["K", String(context.rootEvent.kind)]);
    event.tags.push(["P", context.rootEvent.pubkey]);
  }

  // Add phase tags if present
  if (params.phase) {
    event.tags.push(["phase", params.phase]);
  }
  if (params.phaseInstructions) {
    event.tags.push(["phase-instructions", params.phaseInstructions]);
  }
  if (params.branch) {
    event.tags.push(["branch", params.branch]);
  }

  await this.agent.sign(event);
  await event.publish();

  logger.debug("[AgentPublisher] Published delegation event", {
    eventId: event.id?.substring(0, 8),
    recipient: params.recipient.substring(0, 8),
  });

  return event.id;
}

/**
 * Publish an ask event
 */
async ask(
  params: {
    recipient: string;
    content: string;
    suggestions?: string[];
  },
  context: EventContext
): Promise<string> {
  const event = new NDKEvent(this.ndk);
  event.kind = 1111;
  event.content = params.content;

  // Add recipient p-tag
  event.tags.push(["p", params.recipient]);

  // Add conversation threading
  if (context.rootEvent) {
    event.tags.push(["E", context.rootEvent.id]);
    event.tags.push(["K", String(context.rootEvent.kind)]);
    event.tags.push(["P", context.rootEvent.pubkey]);
  }

  // Add ask marker
  event.tags.push(["ask", "true"]);

  // Add suggestions
  if (params.suggestions) {
    for (const suggestion of params.suggestions) {
      event.tags.push(["suggestion", suggestion]);
    }
  }

  await this.agent.sign(event);
  await event.publish();

  logger.debug("[AgentPublisher] Published ask event", {
    eventId: event.id?.substring(0, 8),
    recipient: params.recipient.substring(0, 8),
  });

  return event.id;
}

/**
 * Publish a delegation follow-up event
 */
async delegateFollowup(
  params: {
    recipient: string;
    content: string;
    replyToEventId?: string;
  },
  context: EventContext
): Promise<string> {
  const event = new NDKEvent(this.ndk);
  event.kind = 1111;
  event.content = params.content;

  // Add recipient p-tag
  event.tags.push(["p", params.recipient]);

  // Add conversation threading
  if (context.rootEvent) {
    event.tags.push(["E", context.rootEvent.id]);
    event.tags.push(["K", String(context.rootEvent.kind)]);
    event.tags.push(["P", context.rootEvent.pubkey]);
  }

  // Reply to specific event if provided
  if (params.replyToEventId) {
    event.tags.push(["e", params.replyToEventId]);
  }

  await this.agent.sign(event);
  await event.publish();

  logger.debug("[AgentPublisher] Published delegation follow-up", {
    eventId: event.id?.substring(0, 8),
    recipient: params.recipient.substring(0, 8),
  });

  return event.id;
}
```

**Step 2: Commit**

```bash
git add src/nostr/AgentPublisher.ts
git commit -m "feat(publisher): add delegate, ask, delegateFollowup methods"
```

---

## Task 9: Modify AgentExecutor for RAL lifecycle

**Files:**
- Modify: `src/agents/execution/AgentExecutor.ts`

This is a significant modification. The key changes:
1. Check RALRegistry on each execute call
2. Route to fresh/resume/queue paths
3. Add injection in prepareStep
4. Check for stop signals in stopWhen
5. Handle RAL completion

**Step 1: Add imports at top of file**

```typescript
import { RALRegistry, TimeoutResponder, isStopExecutionSignal } from "@/services/ral";
import type { PendingDelegation } from "@/services/ral/types";
```

**Step 2: Modify the execute method**

Replace the execute method with RAL-aware version. This is a large change - implement incrementally:

1. First, add RAL state check at the start of execute
2. Add routing logic
3. Add injection in the LLM call
4. Add stop signal detection

(Due to the size of this change, implement in smaller increments with testing between each)

**Step 3: Commit incrementally as you make changes**

```bash
git add src/agents/execution/AgentExecutor.ts
git commit -m "feat(executor): integrate RAL lifecycle management"
```

---

## Task 10: Delete deprecated delegation files

**Files:**
- Delete: `src/services/delegation/DelegationService.ts`
- Delete: `src/services/delegation/DelegationRegistryService.ts`
- Delete: `src/services/delegation/PairModeController.ts`
- Delete: `src/services/delegation/PairModeRegistry.ts`
- Modify: `src/services/delegation/index.ts`

**Step 1: Update index.ts to remove exports**

```typescript
export type { DelegationMode, DelegationResponses } from "./types";
```

**Step 2: Delete the files**

```bash
rm src/services/delegation/DelegationService.ts
rm src/services/delegation/DelegationRegistryService.ts
rm src/services/delegation/PairModeController.ts
rm src/services/delegation/PairModeRegistry.ts
```

**Step 3: Fix any import errors in other files**

Search for imports of deleted modules and update/remove them.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove deprecated DelegationService and PairMode"
```

---

## Task 11: Update DelegationCompletionHandler

**Files:**
- Modify: `src/event-handler/DelegationCompletionHandler.ts`

**Step 1: Update to use RALRegistry**

The completion handler should:
1. Find the RAL by delegation event ID
2. Record the completion
3. The routing to resume happens through normal event handler flow

**Step 2: Commit**

```bash
git add src/event-handler/DelegationCompletionHandler.ts
git commit -m "feat(completion): use RALRegistry for delegation completions"
```

---

## Task 12: Integration testing

**Files:**
- Create: `src/services/ral/__tests__/RALRegistry.test.ts`
- Create: `src/services/ral/__tests__/integration.test.ts`

**Step 1: Write RALRegistry unit tests**

Test:
- Creating RAL state
- Saving/restoring state
- Queuing events
- Recording completions
- Clearing state

**Step 2: Write integration tests**

Test:
- Delegation tool returns stop signal
- RAL state persists across invocations
- Completion triggers resume
- Injection at tool boundaries

**Step 3: Run tests**

```bash
npm test -- --testPathPattern="ral"
```

**Step 4: Commit**

```bash
git add src/services/ral/__tests__/
git commit -m "test(ral): add RALRegistry and integration tests"
```

---

## Summary

**Files Created:**
- `src/services/ral/types.ts`
- `src/services/ral/RALRegistry.ts`
- `src/services/ral/TimeoutResponder.ts`
- `src/services/ral/index.ts`
- `src/services/ral/__tests__/RALRegistry.test.ts`

**Files Modified:**
- `src/tools/implementations/delegate.ts`
- `src/tools/implementations/ask.ts`
- `src/tools/implementations/delegate_followup.ts`
- `src/tools/implementations/delegate_external.ts`
- `src/nostr/AgentPublisher.ts`
- `src/agents/execution/AgentExecutor.ts`
- `src/event-handler/DelegationCompletionHandler.ts`
- `src/services/delegation/index.ts`

**Files Deleted:**
- `src/services/delegation/DelegationService.ts`
- `src/services/delegation/DelegationRegistryService.ts`
- `src/services/delegation/PairModeController.ts`
- `src/services/delegation/PairModeRegistry.ts`

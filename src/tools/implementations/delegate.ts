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

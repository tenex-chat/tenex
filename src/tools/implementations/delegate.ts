import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation, StopExecutionSignal, TodoItem } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/services/agents";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import { tool } from "ai";
import { z } from "zod";

const pairConfigSchema = z.object({
  interval: z
    .number()
    .min(10)
    .describe("Number of tool executions between checkpoints (e.g., 10 means checkpoint every 10 tools)"),
});

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
  pair: pairConfigSchema
    .optional()
    .describe("Enable real-time pairing supervision. You will receive periodic checkpoint updates about the delegated agent's progress."),
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
  context: ToolExecutionContext
): Promise<DelegateOutput> {
  const { delegations } = input;

  if (!Array.isArray(delegations) || delegations.length === 0) {
    throw new Error("At least one delegation is required");
  }

  // Check if there are already pending delegations in the CURRENT RAL execution
  // This prevents creating new delegations during checkpoint responses
  const ralRegistry = RALRegistry.getInstance();
  const pendingDelegationsForRal = ralRegistry.getConversationPendingDelegations(
    context.agent.pubkey, context.conversationId, context.ralNumber
  );
  if (pendingDelegationsForRal.length > 0) {
    const pendingRecipients = pendingDelegationsForRal
      .map(d => d.recipientPubkey.substring(0, 8))
      .join(", ");
    throw new Error(
      `Cannot create new delegation while waiting for existing delegation(s) to: ${pendingRecipients}. ` +
      "Use delegate_followup to send guidance, or wait for the delegation to complete."
    );
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

    // If no explicit phase, check for in_progress todo with delegationInstructions
    if (!phaseInstructions) {
      const conversation = context.getConversation();
      const todos = conversation.getTodos(context.agent.pubkey);
      const inProgressTodos = todos.filter(
        (t: TodoItem) => t.status === "in_progress" && t.delegationInstructions
      );

      if (inProgressTodos.length > 0) {
        // Use the first in_progress todo's delegation instructions
        phaseInstructions = inProgressTodos[0].delegationInstructions;
      }
    }


    // Publish delegation event
    const eventContext = createEventContext(context);
    const eventId = await context.agentPublisher.delegate({
      recipient: pubkey,
      content: delegation.prompt,
      phase,
      phaseInstructions,
      branch: delegation.branch,
    }, eventContext);

    pendingDelegations.push({
      delegationConversationId: eventId,
      recipientPubkey: pubkey,
      senderPubkey: context.agent.pubkey,
      prompt: delegation.prompt,
      ralNumber: context.ralNumber,
    });

    // Start pairing supervision if requested
    if (delegation.pair) {
      const projectContext = getProjectContext();
      const pairingManager = projectContext.pairingManager;

      if (!pairingManager) {
        logger.warn("[delegate] Pairing requested but PairingManager not available", {
          recipient: delegation.recipient,
        });
      } else {
        // Get current RAL number for this agent/conversation
        const currentRal = ralRegistry.getState(context.agent.pubkey, context.conversationId);

        if (!currentRal) {
          logger.warn("[delegate] Pairing requested but no active RAL found", {
            recipient: delegation.recipient,
          });
        } else {
          pairingManager.startPairing(
            eventId,
            {
              delegationId: eventId,
              recipientPubkey: pubkey,
              interval: delegation.pair.interval,
            },
            context.agent.pubkey,
            context.conversationId,
            currentRal.ralNumber
          );

          logger.info("[delegate] Started pairing supervision", {
            delegationId: eventId.substring(0, 8),
            recipient: delegation.recipient,
            interval: delegation.pair.interval,
          });
        }
      }
    }
  }

  if (failedRecipients.length > 0) {
    logger.warn("Some recipients could not be resolved", {
      failed: failedRecipients,
    });
  }

  if (pendingDelegations.length === 0) {
    throw new Error("No valid recipients provided.");
  }

  const stopSignal: DelegateOutput = {
    __stopExecution: true as const,
    pendingDelegations,
  };

  logger.info("[delegate] Published delegations, returning stop signal", {
    count: pendingDelegations.length,
    delegationConversationIds: pendingDelegations.map(d => d.delegationConversationId),
  });

  return stopSignal;
}

export function createDelegateTool(context: ToolExecutionContext): AISdkTool {
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
    ? "Delegate tasks to one or more agents. Each delegation can have its own prompt, branch, and phase. IMPORTANT: Delegated agents ONLY see your prompt - they cannot see any prior conversation. Include ALL necessary context, requirements, and constraints in your prompt."
    : "Delegate tasks to one or more agents. Each delegation can have its own prompt and branch. IMPORTANT: Delegated agents ONLY see your prompt - they cannot see any prior conversation. Include ALL necessary context, requirements, and constraints in your prompt.";

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
        const pairStr = d.pair ? " with pairing" : "";
        return `Delegating to ${d.recipient}${phaseStr}${pairStr}`;
      }

      const hasPairing = delegations.some((d) => d.pair);
      const recipients = delegations.map((d) => d.recipient).join(", ");
      const pairStr = hasPairing ? " with pairing" : "";
      return `Delegating ${delegations.length} tasks to: ${recipients}${pairStr}`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}

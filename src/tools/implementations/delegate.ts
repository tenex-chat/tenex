import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/services/agents";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/event-context";
import { wouldCreateCircularDelegation, truncateConversationId } from "@/utils/delegation-chain";
import { ConversationStore } from "@/conversations/ConversationStore";
import { tool } from "ai";
import { z } from "zod";

const pairConfigSchema = z.object({
  interval: z
    .number()
    .min(10)
    .describe("Number of tool executions between checkpoints (e.g., 10 means checkpoint every 10 tools)"),
});

const delegationItemSchema = z.object({
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
    .describe("Enable real-time pairing supervision. IMPORTANT: Only use pairing when (1) your role explicitly involves monitoring other agents, or (2) the user explicitly requested progress monitoring/reporting. Do NOT use pairing for routine delegations - it adds unnecessary overhead and interrupts the delegated agent's workflow."),
});

type DelegationItem = z.infer<typeof delegationItemSchema>;

interface DelegateInput {
  delegations: DelegationItem[];
}

interface DelegateOutput {
  success: boolean;
  message: string;
  delegationConversationIds: string[];
}

async function executeDelegate(
  input: DelegateInput,
  context: ToolExecutionContext
): Promise<DelegateOutput> {
  const { delegations } = input;

  if (!Array.isArray(delegations) || delegations.length === 0) {
    throw new Error("At least one delegation is required");
  }

  const ralRegistry = RALRegistry.getInstance();
  const pendingDelegations: PendingDelegation[] = [];
  const failedRecipients: string[] = [];

  // Get the delegation chain from the current conversation for cycle detection
  const conversationStore = ConversationStore.get(context.conversationId);
  const delegationChain = conversationStore?.metadata?.delegationChain;

  for (const delegation of delegations) {
    const pubkey = resolveRecipientToPubkey(delegation.recipient);
    if (!pubkey) {
      failedRecipients.push(delegation.recipient);
      continue;
    }

    // Check for circular delegation using stored chain
    if (delegationChain && wouldCreateCircularDelegation(delegationChain, pubkey)) {
      const projectContext = getProjectContext();
      const targetAgent = projectContext.getAgentByPubkey(pubkey);
      const targetName = targetAgent?.slug || pubkey.substring(0, 8);
      const chainDisplay = delegationChain.map(e => e.displayName).join(" → ");

      logger.warn("[delegate] Circular delegation detected", {
        recipient: delegation.recipient,
        targetPubkey: pubkey.substring(0, 8),
        chain: chainDisplay,
      });

      throw new Error(
        `Circular delegation detected: "${targetName}" is already in the delegation chain (${chainDisplay}). ` +
        `Delegating to them would create a cycle. Consider completing your own task or delegating to a different agent.`
      );
    }

    // Publish delegation event
    const eventContext = createEventContext(context);
    const eventId = await context.agentPublisher.delegate({
      recipient: pubkey,
      content: delegation.prompt,
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

  // Register pending delegations in RALRegistry for response routing
  // Uses atomic merge to safely handle concurrent delegation calls
  ralRegistry.mergePendingDelegations(
    context.agent.pubkey,
    context.conversationId,
    context.ralNumber,
    pendingDelegations
  );

  const delegationConversationIds = pendingDelegations.map(d => truncateConversationId(d.delegationConversationId));

  logger.info("[delegate] Published delegations, agent continues without blocking", {
    count: pendingDelegations.length,
    delegationConversationIds,
  });

  // Return normal result - agent continues without blocking
  return {
    success: true,
    message: `Delegated ${pendingDelegations.length} task(s). The agent(s) will respond when ready.`,
    delegationConversationIds,
  };
}

export function createDelegateTool(context: ToolExecutionContext): AISdkTool {
  const delegateSchema = z.object({
    delegations: z
      .array(delegationItemSchema)
      .min(1)
      .describe("Array of delegations to execute"),
  });

  const description = "Delegate tasks to one or more agents. Each delegation can have its own prompt and branch. IMPORTANT: Delegated agents ONLY see your prompt - they cannot see any prior conversation. Include ALL necessary context, requirements, and constraints in your prompt.";

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
        const pairStr = d.pair ? " with pairing" : "";
        return `Delegating to ${d.recipient}${pairStr}`;
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

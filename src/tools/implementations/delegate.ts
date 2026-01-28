import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveAgentSlug } from "@/services/agents";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/event-context";
import { wouldCreateCircularDelegation, truncateConversationId } from "@/utils/delegation-chain";
import { ConversationStore } from "@/conversations/ConversationStore";
import { tool } from "ai";
import { z } from "zod";

const delegationItemSchema = z.object({
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect', 'claude-code', 'explore-agent'). Only agent slugs are accepted."
    ),
  prompt: z.string().describe("The request or task for this agent"),
  branch: z
    .string()
    .optional()
    .describe("Git branch name for worktree isolation"),
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

  // Get the delegation chain from the current conversation for cycle detection
  const conversationStore = ConversationStore.get(context.conversationId);
  const delegationChain = conversationStore?.metadata?.delegationChain;

  for (const delegation of delegations) {
    const resolution = resolveAgentSlug(delegation.recipient);
    if (!resolution.pubkey) {
      const availableSlugsStr = resolution.availableSlugs.length > 0
        ? `Available agent slugs: ${resolution.availableSlugs.join(", ")}`
        : "No agents available in the current project context.";
      throw new Error(
        `Invalid agent slug: "${delegation.recipient}". Only agent slugs are accepted. ${availableSlugsStr}`
      );
    }
    const pubkey = resolution.pubkey;

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
        "Delegating to them would create a cycle. Consider completing your own task or delegating to a different agent."
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
    message: `Delegated ${pendingDelegations.length} task(s). The agent(s) will wake you up when ready with the response(s).`,
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
        return `Delegating to ${d.recipient}`;
      }

      const recipients = delegations.map((d) => d.recipient).join(", ");
      return `Delegating ${delegations.length} tasks to: ${recipients}`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}

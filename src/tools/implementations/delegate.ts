/**
 * Delegation Tool Implementation
 *
 * Enables agents to delegate tasks to other agents in the system.
 *
 * ## Circular Delegation Handling
 *
 * The tool detects when a delegation would create a circular chain (A→B→C→A).
 * By default, circular delegations return a soft warning with `success: false`.
 * Set `force: true` on an individual delegation to bypass this check.
 *
 * @module delegate
 */
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
  force: z
    .boolean()
    .optional()
    .describe("Set to true to proceed even if circular delegation is detected"),
});

type DelegationItem = z.infer<typeof delegationItemSchema>;

interface DelegateInput {
  delegations: DelegationItem[];
}

interface CircularDelegationWarning {
  recipient: string;
  chain: string;
  message: string;
  forced?: boolean;
}

interface DelegateOutput {
  success: boolean;
  message: string;
  delegationConversationIds: string[];
  circularDelegationWarning?: CircularDelegationWarning;
  circularDelegationWarnings?: CircularDelegationWarning[];
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
  const circularWarnings: CircularDelegationWarning[] = [];

  // Get the delegation chain from the current conversation for cycle detection
  const conversationStore = ConversationStore.get(context.conversationId);
  const delegationChain = conversationStore?.metadata?.delegationChain;

  for (const delegation of delegations) {
    // Resolve slug to pubkey - throws if invalid
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

    // Check for circular delegation
    if (delegationChain && wouldCreateCircularDelegation(delegationChain, pubkey)) {
      const projectContext = getProjectContext();
      const targetAgent = projectContext.getAgentByPubkey(pubkey);
      const targetName = targetAgent?.slug || pubkey.substring(0, 8);
      const chainDisplay = delegationChain.map(e => e.displayName).join(" → ");

      const warning: CircularDelegationWarning = {
        recipient: targetName,
        chain: chainDisplay,
        message: `"${targetName}" is already in the delegation chain (${chainDisplay}). Delegating would create a cycle.`,
      };

      if (!delegation.force) {
        logger.info("[delegate] Circular delegation detected, skipping (no force flag)", {
          recipient: delegation.recipient,
          targetPubkey: pubkey.substring(0, 8),
          chain: chainDisplay,
        });
        circularWarnings.push(warning);
        continue;
      }

      // Force flag set - proceed with warning
      logger.warn("[delegate] Circular delegation proceeding with force flag", {
        recipient: delegation.recipient,
        targetPubkey: pubkey.substring(0, 8),
        chain: chainDisplay,
      });
      circularWarnings.push({ ...warning, forced: true });
    }

    // Publish delegation event
    const eventContext = createEventContext(context);
    const eventId = await context.agentPublisher.delegate({
      recipient: pubkey,
      content: delegation.prompt,
      branch: delegation.branch,
    }, eventContext);

    const pendingDelegation: PendingDelegation = {
      delegationConversationId: eventId,
      recipientPubkey: pubkey,
      senderPubkey: context.agent.pubkey,
      prompt: delegation.prompt,
      ralNumber: context.ralNumber,
    };
    pendingDelegations.push(pendingDelegation);

    // Register immediately after publishing to prevent orphans
    ralRegistry.mergePendingDelegations(
      context.agent.pubkey,
      context.conversationId,
      context.ralNumber,
      [pendingDelegation]
    );
  }

  const delegationConversationIds = pendingDelegations.map(d => truncateConversationId(d.delegationConversationId));
  const unforcedWarnings = circularWarnings.filter(w => !w.forced);

  // All delegations were circular (not forced) - return soft warning
  if (pendingDelegations.length === 0 && unforcedWarnings.length > 0) {
    const warningMessages = unforcedWarnings.map(w =>
      `"${w.recipient}" is already in chain (${w.chain})`
    ).join("; ");

    return {
      success: false,
      message: `Circular delegation detected: ${warningMessages}. Add \`force: true\` to proceed anyway.`,
      delegationConversationIds: [],
      circularDelegationWarning: unforcedWarnings[0],
      circularDelegationWarnings: unforcedWarnings,
    };
  }

  if (pendingDelegations.length === 0) {
    throw new Error("No delegations were published.");
  }

  logger.info("[delegate] Published delegations, agent continues without blocking", {
    count: pendingDelegations.length,
    delegationConversationIds,
    circularWarningsCount: circularWarnings.length,
  });

  let message = `Delegated ${pendingDelegations.length} task(s). The agent(s) will wake you up when ready with the response(s).`;
  if (unforcedWarnings.length > 0) {
    const skipped = unforcedWarnings.map(w => w.recipient).join(", ");
    message += ` Note: Skipped circular delegation(s) to: ${skipped}.`;
  }

  return {
    success: true,
    message,
    delegationConversationIds,
    ...(circularWarnings.length > 0 && {
      circularDelegationWarning: circularWarnings[0],
      circularDelegationWarnings: circularWarnings,
    }),
  };
}

export function createDelegateTool(context: ToolExecutionContext): AISdkTool {
  const delegateSchema = z.object({
    delegations: z
      .array(delegationItemSchema)
      .min(1)
      .describe("Array of delegations to execute"),
  });

  const description = `Delegate tasks to one or more agents. Each delegation can have its own prompt and branch. IMPORTANT: Delegated agents ONLY see your prompt - they cannot see any prior conversation. Include ALL necessary context, requirements, and constraints in your prompt.

Circular delegation detection: The tool detects when a delegation would create a circular chain (A→B→C→A). By default, circular delegations are skipped with a soft warning. Set \`force: true\` on an individual delegation to bypass this check.`;

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

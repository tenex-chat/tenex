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
import { ConversationStore } from "@/conversations/ConversationStore";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation } from "@/services/ral/types";
import { SkillIdentifierResolver } from "@/services/skill";
import type { AISdkTool } from "@/tools/types";
import { resolveAgentSlug } from "@/services/agents";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/services/event-context";
import { shortenConversationId } from "@/utils/conversation-id";
import { wouldCreateCircularDelegation } from "@/utils/delegation-chain";
import { teamService } from "@/services/teams";
import { tool } from "ai";
import { z } from "zod";

const delegationItemSchema = z.object({
  recipient: z
    .string()
    .describe(
      "Agent slug or team name (e.g., 'architect', 'claude-code', 'explore-agent', 'design-team'). Agent slugs take priority when a value matches both."
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
  skills: z
    .array(z.string())
    .optional()
    .describe("Skill IDs to apply to this delegated agent. Use the IDs shown in the prompt; slugged IDs and short event IDs are resolved automatically."),
});

type DelegationItem = z.infer<typeof delegationItemSchema>;

interface CircularDelegationWarning {
  recipient: string;
  chain: string;
  message: string;
  forced?: boolean;
}

interface DelegateOutput {
  success: boolean;
  message: string;
  /** Truncated delegation conversation ID (prefix for compact display) */
  delegationConversationId: string;
  circularDelegationWarning?: CircularDelegationWarning;
}

/**
 * Check if the agent has any todos in the current conversation.
 */
function hasTodos(context: ToolExecutionContext): boolean {
  const conversation = context.getConversation();
  if (!conversation) return true; // No conversation context - assume OK
  return conversation.getTodos(context.agent.pubkey).length > 0;
}

async function executeDelegate(
  input: DelegationItem,
  context: ToolExecutionContext
): Promise<DelegateOutput> {
  const delegation = input;

  if (!delegation.prompt) {
    throw new Error("Delegation prompt is required");
  }

  const ralRegistry = RALRegistry.getInstance();
  const pendingDelegations: PendingDelegation[] = [];
  const circularWarnings: CircularDelegationWarning[] = [];

  // Get the delegation chain from the current conversation for cycle detection
  const conversationStore = ConversationStore.get(context.conversationId);
  const delegationChain = conversationStore?.metadata?.delegationChain;

  // Extract inherited skills from the triggering event
  // Skill inheritance: any skills on the current triggering event are automatically
  // passed forward to delegated agents unless explicitly overridden
  const inheritedSkills = context.triggeringEnvelope.metadata.skillEventIds ?? [];

  const trimmedRecipient = delegation.recipient.trim();

  // Resolve slug first, then fall back to a team name if no agent slug matches.
  const resolution = resolveAgentSlug(trimmedRecipient);
  let pubkey = resolution.pubkey;
  let resolvedTeamName: string | undefined;
  let availableTeamNames: string[] = [];

  if (!pubkey) {
    let projectId: string | undefined;
    try {
      const projectContext = getProjectContext();
      projectId = projectContext.project?.dTag ?? projectContext.project?.tagValue?.("d");
    } catch {
      projectId = undefined;
    }

    availableTeamNames = await teamService.getTeamNames(projectId);
    const matchedTeamName = availableTeamNames.find(
      (teamName) => teamName.toLowerCase() === trimmedRecipient.toLowerCase()
    );
    if (matchedTeamName) {
      const teamLeadIdentifier = await teamService.resolveTeamToLead(matchedTeamName, projectId);
      if (teamLeadIdentifier) {
        const teamLeadResolution = resolveAgentSlug(teamLeadIdentifier);
        if (!teamLeadResolution.pubkey) {
          throw new Error(
            `Team lead "${teamLeadIdentifier}" for team "${matchedTeamName}" is not a known agent. ` +
            `Available agent slugs: ${teamLeadResolution.availableSlugs.join(", ")}`
          );
        }
        pubkey = teamLeadResolution.pubkey;
        resolvedTeamName = matchedTeamName;
      }
    }
  }

  if (!pubkey) {
    const availableSlugsStr = resolution.availableSlugs.length > 0
      ? `Available agent slugs: ${resolution.availableSlugs.join(", ")}`
      : "No agents available in the current project context.";
    const availableTeamsStr = availableTeamNames.length > 0
      ? `Available team names: ${availableTeamNames.join(", ")}`
      : "No teams available in the current project context.";
    throw new Error(
      `Invalid agent slug or team name: "${delegation.recipient}". ${availableSlugsStr} ${availableTeamsStr}`
    );
  }

  // Check for circular delegation — self-delegation (A→A) is exempt: it's a valid
  // use case and cannot create an infinite loop the way A→B→C→A would.
  const isSelfDelegation = pubkey === context.agent.pubkey;
  if (!isSelfDelegation && delegationChain && wouldCreateCircularDelegation(delegationChain, pubkey)) {
    let targetName = pubkey.substring(0, 8);
    try {
      const projectContext = getProjectContext();
      const targetAgent = projectContext.getAgentByPubkey?.(pubkey);
      targetName = targetAgent?.slug || targetName;
    } catch {
      // Project context is optional for this tool path.
    }

    const chainDisplay = delegationChain.map((e) => e.displayName).join(" → ");

    const warning: CircularDelegationWarning = {
      recipient: targetName,
      chain: chainDisplay,
      message: `"${targetName}" is already in the delegation chain (${chainDisplay}). Delegating would create a cycle.`,
    };

    // No force flag - throw error to prevent single delegation from proceeding
    if (!delegation.force) {
      const error = new Error(
        `"${targetName}" is already in the delegation chain (${chainDisplay}). Delegating would create a cycle. ` +
        "Add `force: true` to proceed anyway."
      ) as Error & { circularDelegationWarning?: CircularDelegationWarning };
      error.circularDelegationWarning = warning;
      throw error;
    }

    // Force flag set - log and proceed
    logger.warn("[delegate] Circular delegation proceeding with force flag", {
      recipient: delegation.recipient,
      targetPubkey: pubkey.substring(0, 8),
      chain: chainDisplay,
    });
  }

    // Publish delegation event
    const eventContext = createEventContext(context);

    // Combine inherited skills with explicitly specified skills
    // Skill inheritance: inherited skills are always passed forward
    // Explicit skills are added to the inherited set (not replaced)
    const combinedSkills = [
      ...inheritedSkills,
      ...(delegation.skills || []),
    ];
    const uniqueSkills = Array.from(
      new Set(
        combinedSkills
          .map((skillIdentifier) => {
            const trimmedIdentifier = skillIdentifier.trim();
            if (!trimmedIdentifier) {
              return null;
            }

            return (
              SkillIdentifierResolver.getInstance().resolveSkillIdentifier(trimmedIdentifier) ??
              trimmedIdentifier
            );
          })
          .filter((skillIdentifier): skillIdentifier is string => Boolean(skillIdentifier))
      )
    );

    const eventId = await context.agentPublisher.delegate({
      recipient: pubkey,
      content: delegation.prompt,
      branch: delegation.branch,
      skills: uniqueSkills.length > 0 ? uniqueSkills : undefined,
      team: resolvedTeamName,
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

  // Should never happen with single delegation (error thrown earlier), but keep as safety
  if (pendingDelegations.length === 0) {
    throw new Error("No delegations were published.");
  }

  const delegationConversationId = shortenConversationId(pendingDelegations[0].delegationConversationId);

  logger.info("[delegate] Published delegation, agent continues without blocking", {
    delegationConversationId,
    circularWarningsCount: circularWarnings.length,
    inheritedSkillsCount: inheritedSkills.length,
  });

  let message = "Delegated task. The agent will wake you up when ready with the response.";

  if (!hasTodos(context)) {
    message +=
      "\n\n<system-reminder type=\"delegation-todo-nudge\">\n" +
      "You just delegated a task but don't have a todo list yet. Use `todo_write()` to set up a todo list tracking your delegated work and overall workflow.\n" +
      "</system-reminder>";
  }

  return {
    success: true,
    message,
    delegationConversationId,
    ...(circularWarnings.length > 0 && {
      circularDelegationWarning: circularWarnings[0],
    }),
  };
}

export function createDelegateTool(context: ToolExecutionContext): AISdkTool {
  const delegateSchema = delegationItemSchema;

  const description = `Delegate a task to an agent in the project. Provide the recipient agent slug, prompt, and optional configuration. IMPORTANT: Delegated agents ONLY see your prompt - they cannot see any prior conversation. Include ALL necessary context, requirements, and constraints in your prompt.

Circular delegation detection: The tool detects when a delegation would create a circular chain (A→B→C→A). By default, circular delegations are skipped with a soft warning. Set \`force: true\` to bypass this check.

Skill support: Pass skill IDs returned by \`skill_list\` in the \`skills\` array to activate skills on delegated agents. Skill inheritance: any skills active on the current agent are automatically forwarded to all delegated agents.`;

  const aiTool = tool({
    description,
    inputSchema: delegateSchema,
    execute: async (input: unknown) => {
      return await executeDelegate(input as DelegationItem, context);
    },
  });

  return aiTool as AISdkTool;
}

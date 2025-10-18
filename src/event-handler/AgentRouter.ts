import type { AgentInstance } from "@/agents/types";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import type { ProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";


/**
 * AgentRouter is a static utility class that determines which agent
 * should handle an incoming event. This centralizes the routing logic
 * that was previously embedded in reply.ts.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export  class AgentRouter {
  /**
   * Determine which agents should handle the event based on p-tags,
   * event author, and other context.
   *
   * @returns Array of target agents that should process this event
   */
  static resolveTargetAgents(
    event: NDKEvent,
    projectContext: ProjectContext,
  ): AgentInstance[] {
    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

    // Check if the event author is an agent in the system
    const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
      // Find ALL p-tagged system agents
      const targetAgents: AgentInstance[] = [];
      for (const pubkey of mentionedPubkeys) {
        const agent = projectContext.getAgentByPubkey(pubkey);
        if (agent) {
          // Check if this is a global agent that needs project validation
          if (agent.isGlobal && !this.validateProjectContext(event, projectContext)) {
            logger.info(chalk.gray(`Skipping global agent ${agent.slug} - event not for this project context`));
            continue;
          }
          targetAgents.push(agent);
        }
      }

      if (targetAgents.length > 0) {
        const agentNames = targetAgents.map(a => a.name).join(", ");
        logger.info(chalk.gray(`Routing to ${targetAgents.length} p-tagged agent(s): ${agentNames}`));
        return targetAgents;
      }
    }

    // If no p-tags, don't route to anyone - just log it
    if (mentionedPubkeys.length === 0) {
      const senderType = isAuthorAnAgent ? "agent" : "user";
      logger.info(
        chalk.gray(`Event from ${senderType} ${event.pubkey.substring(0, 8)} without p-tags - not routing to any agent`)
      );
      return [];
    }

    return [];
  }

  /**
   * Legacy method for backward compatibility - returns first agent
   * @deprecated Use resolveTargetAgents instead
   */
  static resolveTargetAgent(
    event: NDKEvent,
    projectContext: ProjectContext
  ): AgentInstance | null {
    const agents = this.resolveTargetAgents(event, projectContext);
    return agents.length > 0 ? agents[0] : null;
  }

  /**
   * Check if any of the resolved agents would be processing their own message (self-reply)
   * Returns the agents that would NOT be self-replying
   */
  static filterOutSelfReplies(event: NDKEvent, targetAgents: AgentInstance[]): AgentInstance[] {
    return targetAgents.filter(agent => agent.pubkey !== event.pubkey);
  }

  /**
   * Check if the resolved agent would be processing its own message (self-reply)
   */
  static wouldBeSelfReply(event: NDKEvent, targetAgent: AgentInstance | null): boolean {
    if (!targetAgent) return false;
    return targetAgent.pubkey === event.pubkey;
  }

  /**
   * Get a human-readable description of why an event was routed to particular agents
   */
  static getRoutingReasons(
    event: NDKEvent,
    targetAgents: AgentInstance[],
  ): string {
    if (targetAgents.length === 0) {
      return "No agents assigned (event will not be processed)";
    }

    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

    const reasons: string[] = [];
    for (const agent of targetAgents) {
      // Check if target was p-tagged
      if (mentionedPubkeys.includes(agent.pubkey)) {
        reasons.push(`Agent "${agent.name}" was directly mentioned (p-tagged)`);
      }
    }

    return reasons.length > 0 ? reasons.join("; ") : "Unknown routing reason";
  }

  /**
   * Get a human-readable description of why an event was routed to a particular agent
   */
  static getRoutingReason(
    event: NDKEvent,
    targetAgent: AgentInstance | null,
  ): string {
    if (!targetAgent) {
      return "No agent assigned (event will not be processed)";
    }

    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

    // Check if target was p-tagged
    if (mentionedPubkeys.includes(targetAgent.pubkey)) {
      return `Agent "${targetAgent.name}" was directly mentioned (p-tagged)`;
    }

    return "Unknown routing reason";
  }

  /**
   * Validate that an event's project context matches the current project
   * This is used to filter events for global agents to ensure they only
   * process events from their assigned project.
   *
   * @param event - The event to validate
   * @param projectContext - The current project context
   * @returns true if the event is for this project, false otherwise
   */
  private static validateProjectContext(
    event: NDKEvent,
    projectContext: ProjectContext,
  ): boolean {
    const aTag = event.tags.find((tag) => tag[0] === "a");
    if (!aTag || !aTag[1]) {
      return true; // No project reference - allow routing (backward compatibility)
    }

    const parts = aTag[1].split(":");
    if (parts.length !== 3 || parts[0] !== "31933") {
      return true; // Not a valid project reference - allow routing
    }

    const eventProjectIdentifier = parts[2];
    const currentProjectIdentifier = projectContext.project.tagValue("d");

    // Handle case where current project has no identifier
    if (!currentProjectIdentifier) {
      return true;
    }

    if (eventProjectIdentifier !== currentProjectIdentifier) {
      logger.debug(`Event project mismatch: event="${eventProjectIdentifier}", current="${currentProjectIdentifier}"`);
      return false;
    }

    return true;
  }
}

import type { AgentInstance } from "@/agents/types";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import type { ProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

const logInfo = logger.info.bind(logger);

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
    projectManager: AgentInstance
  ): AgentInstance[] {
    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

    // Check if the event author is an agent in the system
    const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
      // Find ALL p-tagged system agents
      const targetAgents: AgentInstance[] = [];
      for (const pubkey of mentionedPubkeys) {
        const agent = Array.from(projectContext.agents.values()).find((a) => a.pubkey === pubkey);
        if (agent) {
          targetAgents.push(agent);
        }
      }
      
      if (targetAgents.length > 0) {
        const agentNames = targetAgents.map(a => a.name).join(", ");
        logInfo(chalk.gray(`Routing to ${targetAgents.length} p-tagged agent(s): ${agentNames}`));
        return targetAgents;
      }
    }

    // If no p-tags and the author is an agent, don't route it anywhere
    if (mentionedPubkeys.length === 0 && isAuthorAnAgent) {
      logInfo(
        chalk.gray(`Agent event from ${event.pubkey.substring(0, 8)} without p-tags - not routing`)
      );
      return [];
    }

    // Default to PM for coordination only if it's from a user (not an agent)
    if (!isAuthorAnAgent) {
      logInfo(chalk.gray("Routing user event to Project Manager for coordination"));
      return [projectManager];
    }

    return [];
  }

  /**
   * Legacy method for backward compatibility - returns first agent
   * @deprecated Use resolveTargetAgents instead
   */
  static resolveTargetAgent(
    event: NDKEvent,
    projectContext: ProjectContext,
    projectManager: AgentInstance
  ): AgentInstance | null {
    const agents = this.resolveTargetAgents(event, projectContext, projectManager);
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
    projectContext: ProjectContext
  ): string {
    if (targetAgents.length === 0) {
      return "No agents assigned (event will not be processed)";
    }

    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
    const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

    const reasons: string[] = [];
    for (const agent of targetAgents) {
      // Check if target was p-tagged
      if (mentionedPubkeys.includes(agent.pubkey)) {
        reasons.push(`Agent "${agent.name}" was directly mentioned (p-tagged)`);
      }
      // Check if it's the PM handling a user event
      else if (!isAuthorAnAgent && agent.slug === "project-manager") {
        reasons.push("Project Manager handles coordination for user events");
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
    projectContext: ProjectContext
  ): string {
    if (!targetAgent) {
      return "No agent assigned (event will not be processed)";
    }

    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
    const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

    // Check if target was p-tagged
    if (mentionedPubkeys.includes(targetAgent.pubkey)) {
      return `Agent "${targetAgent.name}" was directly mentioned (p-tagged)`;
    }

    // Check if it's the PM handling a user event
    if (!isAuthorAnAgent && targetAgent.slug === "project-manager") {
      return "Project Manager handles coordination for user events";
    }

    return "Unknown routing reason";
  }
}

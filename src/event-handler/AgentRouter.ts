import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentInstance } from "@/agents/types";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import type { ProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";

const logInfo = logger.info.bind(logger);

/**
 * AgentRouter is a static utility class that determines which agent
 * should handle an incoming event. This centralizes the routing logic
 * that was previously embedded in reply.ts.
 */
export class AgentRouter {
  /**
   * Determine which agent should handle the event based on p-tags,
   * event author, and other context.
   *
   * @returns The target agent or null if no agent should process this event
   */
  static resolveTargetAgent(
    event: NDKEvent,
    projectContext: ProjectContext,
    projectManager: AgentInstance
  ): AgentInstance | null {
    const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

    // Check if the event author is an agent in the system
    const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
      // Find the first p-tagged system agent
      for (const pubkey of mentionedPubkeys) {
        const agent = Array.from(projectContext.agents.values()).find((a) => a.pubkey === pubkey);
        if (agent) {
          logInfo(chalk.gray(`Routing to p-tagged agent: ${agent.name}`));
          return agent;
        }
      }
    }

    // If no p-tags and the author is an agent, don't route it anywhere
    if (mentionedPubkeys.length === 0 && isAuthorAnAgent) {
      logInfo(
        chalk.gray(`Agent event from ${event.pubkey.substring(0, 8)} without p-tags - not routing`)
      );
      return null;
    }

    // Default to PM for coordination only if it's from a user (not an agent)
    if (!isAuthorAnAgent) {
      logInfo(chalk.gray("Routing user event to Project Manager for coordination"));
      return projectManager;
    }

    return null;
  }

  /**
   * Check if the resolved agent would be processing its own message (self-reply)
   */
  static wouldBeSelfReply(event: NDKEvent, targetAgent: AgentInstance | null): boolean {
    if (!targetAgent) return false;
    return targetAgent.pubkey === event.pubkey;
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

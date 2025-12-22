import type { AgentInstance } from "@/agents/types";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import type { ProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

/**
 * AgentRouter is a static utility class that determines which agent
 * should handle an incoming event. This centralizes the routing logic
 * that was previously embedded in reply.ts.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class AgentRouter {
    /**
     * Determine which agents should handle the event based on p-tags,
     * event author, and other context.
     *
     * @returns Array of target agents that should process this event
     */
    static resolveTargetAgents(event: NDKEvent, projectContext: ProjectContext): AgentInstance[] {
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
                    targetAgents.push(agent);
                }
            }

            if (targetAgents.length > 0) {
                const agentNames = targetAgents.map((a) => a.name).join(", ");
                logger.info(
                    chalk.gray(`Routing to ${targetAgents.length} p-tagged agent(s): ${agentNames}`)
                );
                return targetAgents;
            }
        }

        // If no p-tags, don't route to anyone - just log it
        if (mentionedPubkeys.length === 0) {
            const senderType = isAuthorAnAgent ? "agent" : "user";
            logger.info(
                chalk.gray(
                    `Event from ${senderType} ${event.pubkey.substring(0, 8)} without p-tags - not routing to any agent`
                )
            );
            return [];
        }

        return [];
    }

    /**
     * Filter out agents that would process their own message (self-reply).
     * Exception: Agents with phases defined can self-reply for phase transitions.
     */
    static filterOutSelfReplies(event: NDKEvent, targetAgents: AgentInstance[]): AgentInstance[] {
        return targetAgents.filter((agent) => {
            if (agent.pubkey !== event.pubkey) {
                return true;
            }
            // Allow self-reply only if agent has phases (for phase transitions)
            return agent.phases && Object.keys(agent.phases).length > 0;
        });
    }

}

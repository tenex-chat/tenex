import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
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
     * Process a stop signal (kind 24134) to block an agent in a conversation.
     * Returns { blocked: true } if the agent was blocked.
     */
    static processStopSignal(
        event: NDKEvent,
        conversation: Conversation,
        projectContext: ProjectContext
    ): { blocked: boolean } {
        const pTags = event.getMatchingTags("p");

        for (const [, agentPubkey] of pTags) {
            const agent = projectContext.getAgentByPubkey(agentPubkey);
            if (agent) {
                conversation.blockedAgents.add(agentPubkey);
                logger.info(
                    chalk.yellow(
                        `Blocked agent ${agent.slug} in conversation ${conversation.id.substring(0, 8)}`
                    )
                );
            }
        }

        return { blocked: pTags.length > 0 };
    }

    /**
     * Determine which agents should handle the event based on p-tags,
     * event author, and other context.
     *
     * @param event - The incoming event
     * @param projectContext - Project context with agent information
     * @param conversation - Optional conversation to check for blocked agents
     * @returns Array of target agents that should process this event
     */
    static resolveTargetAgents(
        event: NDKEvent,
        projectContext: ProjectContext,
        conversation?: Conversation
    ): AgentInstance[] {
        const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);

        // Check if the event author is an agent in the system
        const isAuthorAnAgent = AgentEventDecoder.isEventFromAgent(event, projectContext.agents);

        // Check for p-tagged agents regardless of sender
        if (mentionedPubkeys.length > 0) {
            // Find ALL p-tagged system agents
            const targetAgents: AgentInstance[] = [];
            for (const pubkey of mentionedPubkeys) {
                // Skip blocked agents
                if (conversation?.blockedAgents?.has(pubkey)) {
                    const agent = projectContext.getAgentByPubkey(pubkey);
                    logger.info(
                        chalk.yellow(
                            `Skipping blocked agent ${agent?.slug ?? pubkey.substring(0, 8)} in conversation ${conversation.id.substring(0, 8)}`
                        )
                    );
                    continue;
                }

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
     * Unblock an agent in a conversation if the sender is whitelisted.
     * Returns { unblocked: true } if successful.
     */
    static unblockAgent(
        event: NDKEvent,
        conversation: Conversation,
        projectContext: ProjectContext,
        whitelist: Set<string>
    ): { unblocked: boolean } {
        // Only whitelisted pubkeys can unblock
        if (!whitelist.has(event.pubkey)) {
            return { unblocked: false };
        }

        const pTags = event.getMatchingTags("p");
        let unblocked = false;

        for (const [, agentPubkey] of pTags) {
            if (conversation.blockedAgents.has(agentPubkey)) {
                conversation.blockedAgents.delete(agentPubkey);
                const agent = projectContext.getAgentByPubkey(agentPubkey);
                logger.info(
                    chalk.green(
                        `Unblocked agent ${agent?.slug ?? agentPubkey.substring(0, 8)} in conversation ${conversation.id.substring(0, 8)} by ${event.pubkey.substring(0, 8)}`
                    )
                );
                unblocked = true;
            }
        }

        return { unblocked };
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

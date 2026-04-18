import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    getMentionedPubkeys,
    isFromAgent,
} from "@/events/runtime/envelope-classifier";
import type { ProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import chalk from "chalk";
import type { DelegationCompletionResult } from "./DelegationCompletionHandler";

// biome-ignore lint/complexity/noStaticOnlyClass: Static routing utility.
export class AgentRouter {
    static processStopSignal(
        envelope: InboundEnvelope,
        conversation: ConversationStore,
        projectContext: ProjectContext
    ): { blocked: boolean } {
        const recipientPubkeys = getMentionedPubkeys(envelope);

        for (const agentPubkey of recipientPubkeys) {
            const agent = projectContext.getAgentByPubkey(agentPubkey);
            if (!agent) {
                continue;
            }

            conversation.blockAgent(agentPubkey);
            logger.info(
                chalk.yellow(
                    `Blocked agent ${agent.slug} in conversation ${conversation.id.substring(0, 8)}`
                )
            );
        }

        return { blocked: recipientPubkeys.length > 0 };
    }

    static resolveTargetAgents(
        envelope: InboundEnvelope,
        projectContext: ProjectContext,
        conversation?: ConversationStore
    ): AgentInstance[] {
        const mentionedPubkeys = getMentionedPubkeys(envelope);
        const isAuthorAnAgent = isFromAgent(envelope, projectContext.agents);

        if (mentionedPubkeys.length > 0) {
            const targetAgents: AgentInstance[] = [];
            for (const pubkey of mentionedPubkeys) {
                if (conversation?.isAgentBlocked(pubkey)) {
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
                logger.info(
                    chalk.gray(
                        `Routing to ${targetAgents.length} p-tagged agent(s): ${targetAgents.map((agent) => agent.name).join(", ")}`
                    )
                );
                return targetAgents;
            }
        }

        if (mentionedPubkeys.length === 0) {
            const senderType = isAuthorAnAgent ? "agent" : "user";
            const senderId = envelope.principal.linkedPubkey ?? envelope.principal.id;
            logger.info(
                chalk.gray(
                    `Event from ${senderType} ${senderId.substring(0, 8)} without p-tags - not routing to any agent`
                )
            );
            return [];
        }

        return [];
    }

    static unblockAgent(
        envelope: InboundEnvelope,
        conversation: ConversationStore,
        projectContext: ProjectContext,
        whitelist: Set<string>
    ): { unblocked: boolean } {
        const senderPubkey = envelope.principal.linkedPubkey;
        if (!senderPubkey || !whitelist.has(senderPubkey)) {
            return { unblocked: false };
        }

        const targetedPubkeys = getMentionedPubkeys(envelope);
        let unblocked = false;

        for (const agentPubkey of targetedPubkeys) {
            if (!conversation.isAgentBlocked(agentPubkey)) {
                continue;
            }

            conversation.unblockAgent(agentPubkey);
            const agent = projectContext.getAgentByPubkey(agentPubkey);
            logger.info(
                chalk.green(
                    `Unblocked agent ${agent?.slug ?? agentPubkey.substring(0, 8)} in conversation ${conversation.id.substring(0, 8)} by ${senderPubkey.substring(0, 8)}`
                )
            );
            unblocked = true;
        }

        return { unblocked };
    }

    static resolveDelegationTarget(
        delegationResult: DelegationCompletionResult,
        projectContext: ProjectContext
    ): { agent: AgentInstance; conversationId: string } | null {
        if (!delegationResult.recorded || delegationResult.deferred) {
            return null;
        }

        const { agentSlug, agentPubkey, conversationId } = delegationResult;
        if ((!agentSlug && !agentPubkey) || !conversationId) {
            logger.warn(
                chalk.yellow(
                    "[AgentRouter] Delegation recorded but missing agent identity or conversationId"
                )
            );
            return null;
        }

        const waitingAgent = agentPubkey
            ? projectContext.getAgentByPubkey(agentPubkey)
            : projectContext.getAgent(agentSlug as string);
        if (!waitingAgent) {
            logger.warn(chalk.yellow(`[AgentRouter] Waiting agent not found: ${agentSlug ?? agentPubkey}`));
            return null;
        }

        logger.info(
            chalk.gray(
                `Routing delegation completion to ${waitingAgent.slug} in conversation ${conversationId.substring(0, 8)}`
            )
        );

        return { agent: waitingAgent, conversationId };
    }
}

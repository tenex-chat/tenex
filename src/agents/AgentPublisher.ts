import type { AgentConfig } from "@/agents/types";
import { EVENT_KINDS } from "@/llm";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKPrivateKeySigner, type NDKProject } from "@nostr-dev-kit/ndk";

/**
 * Service for publishing agent-related Nostr events
 */
export class AgentPublisher {
    constructor(private ndk: NDK) {}

    /**
     * Publishes a kind:0 profile event for an agent
     */
    async publishAgentProfile(
        signer: NDKPrivateKeySigner,
        agentName: string,
        agentRole: string,
        projectTitle: string,
        projectEvent: NDKProject,
        agentDefinitionEventId?: string
    ): Promise<void> {
        try {
            // Generate random dicebear avatar
            const avatarStyle = "bottts"; // Using bottts style for agents
            const seed = signer.pubkey; // Use pubkey as seed for consistent avatar
            const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/svg?seed=${seed}`;

            const profile = {
                name: agentName,
                role: agentRole,
                description: `${agentRole} agent for ${projectTitle}`,
                capabilities: [agentRole.toLowerCase()],
                picture: avatarUrl,
                project: projectTitle,
            };

            const profileEvent = new NDKEvent(this.ndk, {
                kind: 0,
                pubkey: signer.pubkey,
                content: JSON.stringify(profile),
                tags: [],
            });

            // Properly tag the project event (creates an "a" tag for kind:31933)
            profileEvent.tag(projectEvent);
            
            // Add e-tag for the agent definition event if it exists and is valid
            if (agentDefinitionEventId && agentDefinitionEventId.trim() !== "") {
                // Validate that it's a proper hex event ID (64 characters)
                const trimmedId = agentDefinitionEventId.trim();
                if (/^[a-f0-9]{64}$/i.test(trimmedId)) {
                    profileEvent.tags.push(["e", trimmedId, "", "agent-definition"]);
                } else {
                    logger.warn("Invalid event ID format for agent definition, skipping e-tag", {
                        eventId: agentDefinitionEventId,
                    });
                }
            }

            await profileEvent.sign(signer);
            profileEvent.publish();
        } catch (error) {
            logger.error("Failed to publish agent profile", {
                error,
                agentName,
            });
            throw error;
        }
    }

    /**
     * Publishes an agent request event
     */
    async publishAgentRequest(
        signer: NDKPrivateKeySigner,
        agentConfig: Omit<AgentConfig, "nsec">,
        projectEvent: NDKProject,
        ndkAgentEventId?: string
    ): Promise<NDKEvent> {
        try {
            const requestEvent = new NDKEvent(this.ndk, {
                kind: EVENT_KINDS.AGENT_REQUEST,
                content: "",
                tags: [],
            });

            // Properly tag the project event
            requestEvent.tag(projectEvent);

            const tags: string[][] = [];

            // Only add e-tag if this agent was created from an NDKAgentDefinition event and is valid
            if (ndkAgentEventId && ndkAgentEventId.trim() !== "") {
                // Validate that it's a proper hex event ID (64 characters)
                const trimmedId = ndkAgentEventId.trim();
                if (/^[a-f0-9]{64}$/i.test(trimmedId)) {
                    tags.push(["e", trimmedId, "", "agent-definition"]);
                } else {
                    logger.warn("Invalid event ID format for agent definition in request, skipping e-tag", {
                        eventId: ndkAgentEventId,
                    });
                }
            }

            // Add agent metadata tags
            tags.push(["name", agentConfig.name]);

            // Add the other tags
            requestEvent.tags.push(...tags);

            await requestEvent.sign(signer);
            await requestEvent.publish();

            logger.info("Published agent request", {
                agentName: agentConfig.name,
                pubkey: signer.pubkey,
                hasNDKAgentDefinitionEvent: !!ndkAgentEventId,
            });

            return requestEvent;
        } catch (error) {
            logger.error("Failed to publish agent request", {
                error,
                agentName: agentConfig.name,
            });
            throw error;
        }
    }

    /**
     * Publishes all agent-related events when creating a new agent
     */
    async publishAgentCreation(
        signer: NDKPrivateKeySigner,
        agentConfig: Omit<AgentConfig, "nsec">,
        projectTitle: string,
        projectEvent: NDKProject,
        ndkAgentEventId?: string
    ): Promise<void> {
        // Publish profile event
        await this.publishAgentProfile(
            signer,
            agentConfig.name,
            agentConfig.role,
            projectTitle,
            projectEvent,
            ndkAgentEventId
        );

        // Publish request event
        await this.publishAgentRequest(signer, agentConfig, projectEvent, ndkAgentEventId);
    }
}

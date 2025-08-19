import { NDKEvent, NDKTask, NDK, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { 
    AgentEventEncoder, 
    AgentEventDecoder,
    type CompletionIntent, 
    type DelegationIntent, 
    type ConversationIntent,
    type EventContext 
} from "./AgentEventEncoder";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { AgentInstance, AgentConfig } from "@/agents/types";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 */
export class AgentPublisher {
    private ndk: NDK;

    constructor(ndk?: NDK) {
        this.ndk = ndk || getNDK();
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event.
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
        logger.info("Dispatching completion", {
            agent: context.agent.name,
            contentLength: intent.content.length,
            summary: intent.summary,
            nextAgent: intent.nextAgent
        });

        const event = AgentEventEncoder.encodeCompletion(intent, context);
        
        // Sign and publish
        await event.sign(context.agent.signer);
        await event.publish();

        logger.info("Completion event published", {
            eventId: event.id,
            agent: context.agent.name
        });

        return event;
    }

    /**
     * Publish delegation task events.
     * Creates and publishes task events for each recipient.
     */
    async delegate(intent: DelegationIntent, context: EventContext): Promise<{
        tasks: NDKTask[];
        batchId: string;
    }> {
        logger.info("Dispatching delegation", {
            agent: context.agent.name,
            recipients: intent.recipients.length,
            phase: intent.phase
        });

        const tasks = AgentEventEncoder.encodeDelegation(intent, context);
        
        // Sign all tasks first
        for (const task of tasks) {
            await task.sign(context.agent.signer);
        }

        // Register with DelegationRegistry
        const registry = DelegationRegistry.getInstance();
        const batchId = await registry.registerDelegationBatch({
            tasks: tasks.map((task, index) => ({
                taskId: task.id,
                assignedToPubkey: intent.recipients[index],
                title: intent.title,
                fullRequest: intent.request,
                phase: intent.phase
            })),
            delegatingAgent: context.agent,
            conversationId: context.conversationId,
            originalRequest: intent.request
        });

        // Publish all tasks
        for (const task of tasks) {
            await task.publish();
            logger.debug("Published delegation task", {
                taskId: task.id,
                assignedTo: task.tagValue('p')
            });
        }

        logger.info("Delegation batch published", {
            batchId,
            taskCount: tasks.length
        });

        return { tasks, batchId };
    }

    /**
     * Publish a conversation response.
     * Creates and publishes a standard response event.
     */
    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        logger.debug("Dispatching conversation response", {
            agent: context.agent.name,
            contentLength: intent.content.length
        });

        const event = AgentEventEncoder.encodeConversation(intent, context);
        
        // Sign and publish
        await event.sign(context.agent.signer);
        await event.publish();

        return event;
    }

    /**
     * Static helper methods for event interpretation.
     * Delegates to AgentEventDecoder for consistency.
     */
    static isCompletionEvent(event: NDKEvent): boolean {
        return AgentEventDecoder.isCompletionEvent(event);
    }

    static isDelegationEvent(event: NDKEvent): boolean {
        return AgentEventDecoder.isDelegationEvent(event);
    }

    static decodeIntent(event: NDKEvent): CompletionIntent | DelegationIntent | ConversationIntent | null {
        // Try to decode as completion
        const completion = AgentEventDecoder.decodeCompletion(event);
        if (completion) return completion;

        // Try to decode as delegation
        const delegation = AgentEventDecoder.decodeDelegation(event);
        if (delegation) return delegation;

        // Default to conversation if it's an agent response
        if (event.kind === EVENT_KINDS.AGENT_RESPONSE) {
            return {
                type: 'conversation',
                content: event.content
            };
        }

        return null;
    }

    // ===== Agent Creation Events (from src/agents/AgentPublisher.ts) =====

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
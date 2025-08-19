import { NDKEvent, NDKTask, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import {
    AgentEventEncoder, 
    type CompletionIntent,
    type DelegationIntent,
    type ConversationIntent,
    type ErrorIntent,
    type TypingIntent,
    type StreamingIntent,
    type StatusIntent,
    type LessonIntent,
    type EventContext
} from "./AgentEventEncoder";
import { EVENT_KINDS } from "@/llm/types";
import { logger } from "@/utils/logger";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { AgentConfig, AgentInstance } from "@/agents/types";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 */
export class AgentPublisher {
    private agent: AgentInstance;

    constructor(agent: AgentInstance) {
        this.agent = agent;
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event.
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
        logger.info("Dispatching completion", {
            agent: this.agent.name,
            contentLength: intent.content.length,
            summary: intent.summary
        });

        const event = AgentEventEncoder.encodeCompletion(intent, context);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        logger.info("Completion event published", {
            eventId: event.id,
            agent: this.agent.name
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
            agent: this.agent.name,
            recipients: intent.recipients.length,
            phase: intent.phase
        });

        const tasks = AgentEventEncoder.encodeDelegation(intent, context);
        
        // Debug: Log task IDs before signing
        for (const [index, task] of tasks.entries()) {
            logger.debug("Task ID before signing", {
                index,
                taskId: task.id,
                hasId: !!task.id,
                assignedTo: intent.recipients[index]?.substring(0, 16)
            });
        }
        
        // Sign all tasks first
        for (const task of tasks) {
            await task.sign(this.agent.signer);
        }

        // Debug: Log task IDs after signing
        for (const [index, task] of tasks.entries()) {
            logger.debug("Task ID after signing", {
                index,
                taskId: task.id,
                hasId: !!task.id,
                assignedTo: intent.recipients[index]?.substring(0, 16)
            });
        }

        // Register with DelegationRegistry
        const registry = await DelegationRegistry.getInstance();
        const batchId = await registry.registerDelegationBatch({
            tasks: tasks.map((task, index) => ({
                taskId: task.id,
                assignedToPubkey: intent.recipients[index],
                title: intent.title,
                fullRequest: intent.request,
                phase: intent.phase
            })),
            delegatingAgent: this.agent,
            conversationId: context.conversationEvent?.id || '',
            originalRequest: intent.request
        });

        // Publish all tasks
        for (const [index, task] of tasks.entries()) {
            await task.publish();
            logger.debug("Published delegation task", {
                index,
                taskId: task.id,
                taskIdTruncated: task.id?.substring(0, 8),
                assignedTo: task.tagValue('p')?.substring(0, 16)
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
            agent: this.agent.name,
            contentLength: intent.content.length
        });

        const event = AgentEventEncoder.encodeConversation(intent, context);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        return event;
    }

    /**
     * Publish an error event.
     * Creates and publishes an error notification event.
     */
    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        logger.debug("Dispatching error", {
            agent: this.agent.name,
            error: intent.message
        });

        const event = AgentEventEncoder.encodeError(intent, context);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        logger.debug("Error event published", {
            eventId: event.id,
            agent: this.agent.name,
            error: intent.message
        });

        return event;
    }

    /**
     * Publish a typing indicator event.
     */
    async typing(intent: TypingIntent, context: EventContext): Promise<NDKEvent> {
        logger.debug("Dispatching typing indicator", {
            agent: this.agent.name,
            state: intent.state
        });

        const event = AgentEventEncoder.encodeTypingIndicator(intent, context, this.agent);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        return event;
    }

    /**
     * Publish a streaming progress event.
     */
    async streaming(intent: StreamingIntent, context: EventContext): Promise<NDKEvent> {
        const event = AgentEventEncoder.encodeStreamingProgress(intent, context);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        return event;
    }

    /**
     * Publish a project status event.
     */
    async status(intent: StatusIntent): Promise<NDKEvent> {
        logger.debug("Dispatching status", {
            agent: this.agent.name,
            agentCount: intent.agents.length
        });

        const event = AgentEventEncoder.encodeProjectStatus(intent);
        
        // Sign and publish
        await event.sign(this.agent.signer);
        await event.publish();

        return event;
    }

    /**
     * Publish a lesson learned event.
     */
    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        logger.debug("Dispatching lesson", {
            agent: this.agent.name,
            title: intent.title
        });

        const lessonEvent = AgentEventEncoder.encodeLesson(intent, context, this.agent);
        
        // Sign and publish
        await lessonEvent.sign(this.agent.signer);
        await lessonEvent.publish();

        logger.debug("Lesson event published", {
            eventId: lessonEvent.id,
            agent: this.agent.name,
            title: intent.title
        });

        return lessonEvent;
    }

    // ===== Agent Creation Events (from src/agents/AgentPublisher.ts) =====

    /**
     * Publishes a kind:0 profile event for an agent
     */
    static async publishAgentProfile(
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
                picture: avatarUrl,
                project: projectTitle,
            };

            const profileEvent = new NDKEvent(getNDK(), {
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
    static async publishAgentRequest(
        signer: NDKPrivateKeySigner,
        agentConfig: Omit<AgentConfig, "nsec">,
        projectEvent: NDKProject,
        ndkAgentEventId?: string
    ): Promise<NDKEvent> {
        try {
            const requestEvent = new NDKEvent(getNDK(), {
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
    static async publishAgentCreation(
        signer: NDKPrivateKeySigner,
        agentConfig: Omit<AgentConfig, "nsec">,
        projectTitle: string,
        projectEvent: NDKProject,
        ndkAgentEventId?: string
    ): Promise<void> {
        // Publish profile event
        await AgentPublisher.publishAgentProfile(
            signer,
            agentConfig.name,
            agentConfig.role,
            projectTitle,
            projectEvent,
            ndkAgentEventId
        );

        // Publish request event
        await AgentPublisher.publishAgentRequest(signer, agentConfig, projectEvent, ndkAgentEventId);
    }
}
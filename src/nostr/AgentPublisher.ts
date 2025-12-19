import type { AgentConfig, AgentInstance } from "@/agents/types";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import {
    NDKEvent,
    NDKPrivateKeySigner,
    type NDKProject,
    type NDKTask,
} from "@nostr-dev-kit/ndk";
import {
    AgentEventEncoder,
    type CompletionIntent,
    type ConversationIntent,
    type ErrorIntent,
    type EventContext,
    type LessonIntent,
    type StreamingIntent,
    type ToolUseIntent,
} from "./AgentEventEncoder";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 * Also manages streaming buffer to ensure correct event ordering.
 */
export class AgentPublisher {
    private agent: AgentInstance;
    private encoder: AgentEventEncoder;
    private streamSequence = 0;

    constructor(agent: AgentInstance) {
        this.agent = agent;
        this.encoder = new AgentEventEncoder();
    }

    /**
     * Safely publish an event with error handling
     */
    private async safePublish(event: NDKEvent, context: string): Promise<void> {
        try {
            await event.publish();
        } catch (error) {
            logger.warn(`Failed to publish ${context}`, {
                error,
                eventId: event.id?.substring(0, 8),
                agent: this.agent.slug,
            });
        }
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event.
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
        const event = this.encoder.encodeCompletion(intent, context);

        // Sign and publish
        await this.agent.sign(event);
        await this.safePublish(event, "completion event");

        trace.getActiveSpan()?.addEvent("publisher.completion_published", {
            "event.id": event.id || "",
            "content.length": intent.content.length,
        });

        return event;
    }

    /**
     * Publish a delegation event
     */
    async delegate(
        params: {
            recipient: string;
            content: string;
            phase?: string;
            phaseInstructions?: string;
            branch?: string;
        },
        context: EventContext
    ): Promise<string> {
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = 1111;
        event.content = params.content;

        // Add recipient p-tag
        event.tags.push(["p", params.recipient]);

        // Add conversation threading
        if (context.rootEvent) {
            event.tags.push(["E", context.rootEvent.id]);
            event.tags.push(["K", String(context.rootEvent.kind)]);
            event.tags.push(["P", context.rootEvent.pubkey]);
        }

        // Add e-tag for triggering event (reply threading)
        if (context.triggeringEvent?.id) {
            event.tags.push(["e", context.triggeringEvent.id]);
        }

        // Add project a-tag (required for event routing)
        this.encoder.aTagProject(event);

        // Add phase tags if present
        if (params.phase) {
            event.tags.push(["phase", params.phase]);
        }
        if (params.phaseInstructions) {
            event.tags.push(["phase-instructions", params.phaseInstructions]);
        }
        if (params.branch) {
            event.tags.push(["branch", params.branch]);
        }

        await this.agent.sign(event);
        await event.publish();

        trace.getActiveSpan()?.addEvent("publisher.delegation_published", {
            "event.id": event.id || "",
        });

        return event.id;
    }

    /**
     * Publish an ask event
     */
    async ask(
        params: {
            recipient: string;
            content: string;
            suggestions?: string[];
        },
        context: EventContext
    ): Promise<string> {
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = 1111;
        event.content = params.content;

        // Add recipient p-tag
        event.tags.push(["p", params.recipient]);

        // Add conversation threading
        if (context.rootEvent) {
            event.tags.push(["E", context.rootEvent.id]);
            event.tags.push(["K", String(context.rootEvent.kind)]);
            event.tags.push(["P", context.rootEvent.pubkey]);
        }

        // Add e-tag for triggering event (reply threading)
        if (context.triggeringEvent?.id) {
            event.tags.push(["e", context.triggeringEvent.id]);
        }

        // Add project a-tag (required for event routing)
        this.encoder.aTagProject(event);

        // Add ask marker
        event.tags.push(["ask", "true"]);

        // Add suggestions
        if (params.suggestions) {
            for (const suggestion of params.suggestions) {
                event.tags.push(["suggestion", suggestion]);
            }
        }

        await this.agent.sign(event);
        await event.publish();

        trace.getActiveSpan()?.addEvent("publisher.ask_published", {
            "event.id": event.id || "",
        });

        return event.id;
    }

    /**
     * Publish a delegation follow-up event
     */
    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string> {
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = 1111;
        event.content = params.content;

        // Add recipient p-tag
        event.tags.push(["p", params.recipient]);

        // Add conversation threading
        if (context.rootEvent) {
            event.tags.push(["E", context.rootEvent.id]);
            event.tags.push(["K", String(context.rootEvent.kind)]);
            event.tags.push(["P", context.rootEvent.pubkey]);
        }

        // Add project a-tag (required for event routing)
        this.encoder.aTagProject(event);

        // Reply to specific event if provided
        if (params.replyToEventId) {
            event.tags.push(["e", params.replyToEventId]);
        }

        await this.agent.sign(event);
        await event.publish();

        trace.getActiveSpan()?.addEvent("publisher.followup_published", {
            "event.id": event.id || "",
        });

        return event.id;
    }

    /**
     * Publish a conversation response.
     * Creates and publishes a standard response event.
     */
    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        const event = this.encoder.encodeConversation(intent, context);

        // Sign and publish
        await this.agent.sign(event);
        await this.safePublish(event, "conversation event");

        return event;
    }

    /**
     * Publish an error event.
     * Creates and publishes an error notification event.
     */
    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        const event = this.encoder.encodeError(intent, context);

        // Sign and publish
        await this.agent.sign(event);
        await this.safePublish(event, "error event");

        trace.getActiveSpan()?.addEvent("publisher.error_published", {
            "event.id": event.id || "",
            "error.message": intent.message.substring(0, 100),
        });

        return event;
    }

    /**
     * Publish a streaming progress event.
     */
    async streaming(intent: StreamingIntent, context: EventContext): Promise<NDKEvent> {
        // Note: Don't flush stream for streaming events as they ARE the stream
        const event = this.encoder.encodeStreamingContent(intent, context);

        // Sign and publish
        await this.agent.sign(event);
        await this.safePublish(event, "streaming event");

        return event;
    }

    /**
     * Publish a lesson learned event.
     */
    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        const lessonEvent = this.encoder.encodeLesson(intent, context, this.agent);

        // Sign and publish
        await this.agent.sign(lessonEvent);
        await this.safePublish(lessonEvent, "lesson event");

        trace.getActiveSpan()?.addEvent("publisher.lesson_published", {
            "event.id": lessonEvent.id || "",
        });

        return lessonEvent;
    }

    /**
     * Publish a tool usage event.
     * Creates and publishes an event with tool name and output tags.
     */
    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
        const event = this.encoder.encodeToolUse(intent, context);

        // Sign and publish
        await this.agent.sign(event);
        await this.safePublish(event, "tool use event");

        trace.getActiveSpan()?.addEvent("publisher.tool_published", {
            "event.id": event.id || "",
            "tool.name": intent.toolName,
        });

        return event;
    }

    /**
     * Publish streaming delta from LLMService.
     * Content is already throttled by the middleware, so we publish immediately as TenexStreamingResponse.
     */
    async publishStreamingDelta(
        delta: string,
        context: EventContext,
        isReasoning = false
    ): Promise<void> {
        // Content is already buffered/throttled by the middleware
        // Just publish it immediately as a streaming event
        const streamingIntent: StreamingIntent = {
            content: delta,
            sequence: ++this.streamSequence,
            isReasoning,
        };

        await this.streaming(streamingIntent, context);
    }

    /**
     * Reset streaming sequence counter.
     * Should be called when streaming is complete.
     */
    resetStreamingSequence(): void {
        this.streamSequence = 0;
    }

    /**
     * Create a task event that references the triggering event.
     * Used for Claude Code and other task-based executions.
     */
    async createTask(
        title: string,
        content: string,
        context: EventContext,
        claudeSessionId?: string
    ): Promise<NDKTask> {
        // Use encoder to create task with proper tagging
        const task = this.encoder.encodeTask(title, content, context, claudeSessionId);

        // Sign with agent's signer
        await this.agent.sign(task);
        await this.safePublish(task, "task event");

        return task;
    }

    /**
     * Publish a task update (progress or completion).
     * Strips "p" tags to avoid notifications.
     */
    async publishTaskUpdate(
        task: NDKTask,
        content: string,
        context: EventContext,
        status = "in-progress"
    ): Promise<NDKEvent> {
        const update = task.reply();
        update.content = content;

        // Strip all "p" tags (no notifications)
        update.tags = update.tags.filter((t) => t[0] !== "p");

        // Add standard tags using existing encoder methods
        this.encoder.addStandardTags(update, context);

        update.tag(["status", status]);
        await this.agent.sign(update);
        await this.safePublish(update, "task update");

        return update;
    }

    // ===== Agent Creation Events (from src/agents/AgentPublisher.ts) =====

    /**
     * Publishes a kind:14199 snapshot event for a project, listing all associated agents.
     * Reads agent associations from AgentStorage instead of maintaining a separate registry.
     */
    private static async publishProjectAgentSnapshot(projectTag: string): Promise<void> {
        const { config } = await import("@/services/ConfigService");

        // Get all agents for this project from AgentStorage
        const agents = await agentStorage.getProjectAgents(projectTag);
        const tenexNsec = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(tenexNsec);
        const ndk = getNDK();

        const ev = new NDKEvent(ndk, {
            kind: 14199,
        });

        // Add whitelisted pubkeys
        const whitelisted = config.getWhitelistedPubkeys(undefined, config.getConfig());
        for (const pk of whitelisted) {
            ev.tag(["p", pk]);
        }

        // Add agent pubkeys
        for (const agent of agents) {
            const agentSigner = new NDKPrivateKeySigner(agent.nsec);
            ev.tag(["p", agentSigner.pubkey]);
        }

        await ev.sign(signer);
        ev.publish();
    }

    /**
     * Publishes a kind:0 profile event for an agent
     */
    static async publishAgentProfile(
        signer: NDKPrivateKeySigner,
        agentName: string,
        agentRole: string,
        projectTitle: string,
        projectEvent: NDKProject,
        agentDefinitionEventId?: string,
        agentMetadata?: {
            description?: string;
            instructions?: string;
            useCriteria?: string;
            phases?: Record<string, string>;
        },
        whitelistedPubkeys?: string[]
    ): Promise<void> {
        let profileEvent: NDKEvent;

        try {
            // Deterministically select avatar family based on pubkey
            const avatarFamilies = [
                "lorelei",
                "miniavs",
                "dylan",
                "pixel-art",
                "rings",
                "avataaars",
            ];
            // Use first few chars of pubkey to select family deterministically
            const familyIndex =
                Number.parseInt(signer.pubkey.substring(0, 8), 16) % avatarFamilies.length;
            const avatarStyle = avatarFamilies[familyIndex];
            const seed = signer.pubkey; // Use pubkey as seed for consistent avatar
            const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/svg?seed=${seed}`;

            const profile = {
                name: agentName,
                description: `${agentRole} agent for ${projectTitle}`,
                picture: avatarUrl,
            };

            profileEvent = new NDKEvent(getNDK(), {
                kind: 0,
                pubkey: signer.pubkey,
                content: JSON.stringify(profile),
                tags: [],
            });

            // Properly tag the project event (creates an "a" tag for kind:31933)
            profileEvent.tag(projectEvent.tagReference());

            // Add "a" tags for all projects this agent belongs to
            const projectTags = await agentStorage.getAgentProjects(signer.pubkey);
            for (const tag of projectTags) {
                profileEvent.tag(["a", tag]);
            }

            // Add e-tag for the agent definition event if it exists and is valid
            if (agentDefinitionEventId) {
                // Validate that it's a proper hex event ID (64 characters)
                profileEvent.tags.push(["e", agentDefinitionEventId]);
            }

            // Add metadata tags for agents without NDKAgentDefinition event ID
            if (!agentDefinitionEventId && agentMetadata) {
                if (agentMetadata.description) {
                    profileEvent.tags.push(["description", agentMetadata.description]);
                }
                if (agentMetadata.instructions) {
                    profileEvent.tags.push(["instructions", agentMetadata.instructions]);
                }
                if (agentMetadata.useCriteria) {
                    profileEvent.tags.push(["use-criteria", agentMetadata.useCriteria]);
                }
                if (agentMetadata.phases) {
                    // Add phase tags with instructions
                    for (const [phaseName, instructions] of Object.entries(agentMetadata.phases)) {
                        profileEvent.tags.push(["phase", phaseName, instructions]);
                    }
                }
            }

            // Add p-tags for all whitelisted pubkeys
            if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
                for (const pubkey of whitelistedPubkeys) {
                    if (pubkey && pubkey !== signer.pubkey) {
                        // Don't p-tag self
                        profileEvent.tags.push(["p", pubkey]);
                    }
                }
            }

            // Add bot tag
            profileEvent.tags.push(["bot"]);

            // Add tenex tag
            profileEvent.tags.push(["t", "tenex"]);

            await profileEvent.sign(signer, { pTags: false });

            try {
                await profileEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish agent profile (may already exist)", {
                    error: publishError,
                    agentName,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }

            // Publish kind:14199 snapshot for this project after successful profile publish
            const projectTag = projectEvent.tagId();
            if (projectTag) {
                await AgentPublisher.publishProjectAgentSnapshot(projectTag);
            }
        } catch (error) {
            logger.error("Failed to create agent profile", {
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
                kind: NDKKind.AgentRequest,
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
                    logger.warn(
                        "Invalid event ID format for agent definition in request, skipping e-tag",
                        {
                            eventId: ndkAgentEventId,
                        }
                    );
                }
            }

            // Add agent metadata tags
            tags.push(["name", agentConfig.name]);

            // Add the other tags
            requestEvent.tags.push(...tags);

            await requestEvent.sign(signer, { pTags: false });

            try {
                await requestEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish agent request (may already exist)", {
                    error: publishError,
                    agentName: agentConfig.name,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }

            return requestEvent;
        } catch (error) {
            logger.error("Failed to create agent request", {
                error,
                agentName: agentConfig.name,
            });
            throw error;
        }
    }

    /**
     * Publishes a kind:3 contact list for an agent
     * This allows agents to follow other agents in the project and whitelisted pubkeys
     */
    static async publishContactList(
        signer: NDKPrivateKeySigner,
        contactPubkeys: string[]
    ): Promise<void> {
        try {
            // Create a kind:3 event (contact list)
            const contactListEvent = new NDKEvent(getNDK(), {
                kind: 3,
                pubkey: signer.pubkey,
                content: "", // Contact list content is usually empty
                tags: [],
            });

            // Add p-tags for each contact
            for (const pubkey of contactPubkeys) {
                if (pubkey && pubkey !== signer.pubkey) {
                    // Don't follow self
                    contactListEvent.tags.push(["p", pubkey]);
                }
            }

            // Sign and publish the contact list
            await contactListEvent.sign(signer, { pTags: false });

            try {
                await contactListEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish contact list (may already exist)", {
                    error: publishError,
                    agentPubkey: signer.pubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to create contact list", {
                error,
                agentPubkey: signer.pubkey.substring(0, 8),
            });
            // Don't throw - contact list is not critical
        }
    }

}

import type { AgentConfig, AgentInstance } from "@/agents/types";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { getLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import { logger } from "@/utils/logger";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import {
    NDKEvent,
    NDKPrivateKeySigner,
    type NDKProject,
} from "@nostr-dev-kit/ndk";
import {
    AgentEventEncoder,
    type AskQuestion,
    type CompletionIntent,
    type ConversationIntent,
    type ErrorIntent,
    type EventContext,
    type LessonIntent,
    type ToolUseIntent,
} from "./AgentEventEncoder";
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";

/**
 * Configuration for delegation events.
 */
export interface DelegateConfig {
    /** The pubkey of the agent to delegate to */
    recipient: string;
    /** The content/instructions for the delegation */
    content: string;
    /** Optional branch for worktree support */
    branch?: string;
}

/**
 * Configuration for ask events.
 * Uses the multi-question format (title + questions).
 */
export interface AskConfig {
    /** The pubkey of the recipient (usually project owner/human) */
    recipient: string;
    /** Full context explaining why these questions are being asked */
    context: string;
    /** Overall title encompassing all questions */
    title: string;
    /** Array of questions (single-select or multi-select) */
    questions: AskQuestion[];
}

/**
 * Inject W3C trace context into an event's tags.
 * This allows the daemon to link incoming events back to their parent span.
 * Also adds trace_context_llm which links to the LLM execution span for better debugging.
 */
function injectTraceContext(event: NDKEvent): void {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    if (carrier.traceparent) {
        event.tags.push(["trace_context", carrier.traceparent]);
    }

    // Add trace context that links to LLM execution span (more useful for debugging)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        const traceId = spanContext.traceId;

        // Use LLM span ID if available (links to actual LLM execution)
        // Otherwise fall back to current span ID
        const llmSpanId = getLLMSpanId(traceId);
        const spanIdToUse = llmSpanId || spanContext.spanId;

        event.tags.push(["trace_context_llm", `00-${traceId}-${spanIdToUse}-01`]);
    }
}

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 */
export class AgentPublisher {
    private agent: AgentInstance;
    private encoder: AgentEventEncoder;

    constructor(agent: AgentInstance) {
        this.agent = agent;
        this.encoder = new AgentEventEncoder();
    }

    /**
     * Consume unreported runtime from RAL and enhance context with it.
     * This ensures each published event gets the incremental runtime since last publish.
     *
     * IMPORTANT: Always consumes from RAL to advance lastReportedRuntime, even when
     * explicit llmRuntime is provided. This prevents double-counting on subsequent events.
     */
    private consumeAndEnhanceContext(context: EventContext): EventContext {
        const ralRegistry = RALRegistry.getInstance();

        // Always consume to advance lastReportedRuntime (prevents double-counting)
        const unreportedRuntime = ralRegistry.consumeUnreportedRuntime(
            this.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        // If context already has llmRuntime set explicitly, use that value
        // (but we still consumed above to advance the counter)
        if (context.llmRuntime !== undefined) {
            return context;
        }

        return {
            ...context,
            llmRuntime: unreportedRuntime > 0 ? unreportedRuntime : undefined,
        };
    }

    /**
     * Safely publish an event with error handling.
     * Logs warnings on publish failure or 0-relay success.
     */
    private async safePublish(event: NDKEvent, eventType: string): Promise<void> {
        try {
            const relaySet = await event.publish();

            // Log relay responses
            const successRelays: string[] = [];
            for (const relay of relaySet) {
                successRelays.push(relay.url);
            }

            if (successRelays.length === 0) {
                logger.warn("Event published to 0 relays", {
                    eventId: event.id?.substring(0, 8),
                    eventType,
                    agent: this.agent.slug,
                    rawEvent: JSON.stringify(event.rawEvent()),
                });
            }
        } catch (error) {
            logger.warn(`Failed to publish ${eventType}`, {
                error,
                eventId: event.id?.substring(0, 8),
                agent: this.agent.slug,
                rawEvent: JSON.stringify(event.rawEvent()),
            });
        }
    }

    /**
     * Add delegation tag to an event, linking it to the parent conversation.
     * This method is used by delegate() and ask() to establish the parent-child
     * relationship between conversations.
     *
     * @param event - The event to add the delegation tag to
     * @param context - The event context containing the conversationId
     * @throws Error if context.conversationId is missing
     */
    private addDelegationTag(event: NDKEvent, context: EventContext): void {
        if (!context.conversationId) {
            throw new Error("Cannot add delegation tag: conversationId is required in context for delegation events");
        }
        event.tags.push(["delegation", context.conversationId]);
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event with p-tag.
     * Includes both incremental runtime (llm-runtime) and total runtime (llm-runtime-total).
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);

        // For completion events, include the total accumulated runtime for the entire RAL
        // This allows delegation aggregation to get the correct total runtime
        const ralRegistry = RALRegistry.getInstance();
        const totalRuntime = ralRegistry.getAccumulatedRuntime(
            this.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        const contextWithTotal: EventContext = {
            ...enhancedContext,
            llmRuntimeTotal: totalRuntime > 0 ? totalRuntime : undefined,
        };

        const event = this.encoder.encodeCompletion(intent, contextWithTotal);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "completion");

        return event;
    }

    /**
     * Publish a conversation event (mid-loop response without p-tag).
     * Used when agent has text output but delegations are still pending.
     */
    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeConversation(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "conversation");

        return event;
    }

    /**
     * Publish a delegation event
     */
    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = config.content;

        // Add recipient p-tag
        event.tags.push(["p", config.recipient]);

        // No e-tag: delegation events start separate conversations

        if (config.branch) {
            event.tags.push(["branch", config.branch]);
        }

        // Add standard metadata (project tag, model, cost, execution time, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch tag from triggering event if not explicitly set
        if (!config.branch) {
            this.encoder.forwardBranchTag(event, enhancedContext);
        }

        // Add delegation tag linking to parent conversation
        this.addDelegationTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "delegation");

        // Register with PendingDelegationsRegistry for q-tag correlation
        PendingDelegationsRegistry.register(this.agent.pubkey, context.conversationId, event.id);

        return event.id;
    }

    /**
     * Publish an ask event using the multi-question format.
     */
    async ask(config: AskConfig, context: EventContext): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        // Content is just the context (user has no access to conversation history)
        event.content = config.context;

        // Add title tag
        event.tags.push(["title", config.title]);

        // Add question/multiselect tags
        for (const question of config.questions) {
            if (question.type === "question") {
                const tag = ["question", question.title, question.question];
                if (question.suggestions) {
                    tag.push(...question.suggestions);
                }
                event.tags.push(tag);
            } else if (question.type === "multiselect") {
                const tag = ["multiselect", question.title, question.question];
                if (question.options) {
                    tag.push(...question.options);
                }
                event.tags.push(tag);
            }
        }

        // Add recipient p-tag
        event.tags.push(["p", config.recipient]);

        // No e-tag: ask events start separate conversations (like delegate)

        // Add standard metadata (project tag, model, cost, execution time, runtime, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Add ask marker
        event.tags.push(["ask", "true"]);

        // Add t-tag for ask events
        event.tags.push(["t", "ask"]);

        // Add delegation tag linking to parent conversation
        this.addDelegationTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "ask");

        // Register with PendingDelegationsRegistry for q-tag correlation
        PendingDelegationsRegistry.register(this.agent.pubkey, enhancedContext.conversationId, event.id);

        return event.id;
    }

    /**
     * Publish a delegation follow-up event
     */
    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = params.content;

        // Add recipient p-tag
        event.tags.push(["p", params.recipient]);

        // Add reference to the original delegation event
        event.tags.push(["e", params.delegationEventId]);

        // Reply to specific response event if provided (for threading)
        if (params.replyToEventId) {
            event.tags.push(["e", params.replyToEventId]);
        }

        // Add standard metadata (project tag, model, cost, execution time, runtime, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch tag from triggering event
        this.encoder.forwardBranchTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "followup");

        return event.id;
    }

    /**
     * Publish an error event.
     * Creates and publishes an error notification event.
     */
    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeError(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "error");

        return event;
    }

    /**
     * Publish a lesson learned event.
     */
    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const lessonEvent = this.encoder.encodeLesson(intent, enhancedContext, this.agent);

        injectTraceContext(lessonEvent);
        await this.agent.sign(lessonEvent);
        await this.safePublish(lessonEvent, "lesson");

        return lessonEvent;
    }

    /**
     * Publish a tool usage event.
     * Creates and publishes an event with tool name and output tags.
     */
    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeToolUse(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, `tool:${intent.toolName}`);

        return event;
    }

    // ===== Agent Creation Events (from src/agents/AgentPublisher.ts) =====

    /**
     * Publishes a kind:14199 snapshot event for a project, listing all associated agents.
     * Reads agent associations from AgentStorage instead of maintaining a separate registry.
     */
    private static async publishProjectAgentSnapshot(projectTag: string): Promise<void> {
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
            const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/png?seed=${seed}`;

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

    /**
     * Publishes a kind:0 profile event for the TENEX backend daemon.
     * This identifies the backend as an entity on nostr.
     *
     * @param signer The backend's NDKPrivateKeySigner
     * @param backendName The name for the backend profile (default: "tenex backend")
     * @param whitelistedPubkeys Array of pubkeys to include as contacts
     */
    static async publishBackendProfile(
        signer: NDKPrivateKeySigner,
        backendName: string = "tenex backend",
        whitelistedPubkeys?: string[]
    ): Promise<void> {
        try {
            // Deterministically select avatar based on pubkey (same logic as agents)
            const avatarFamilies = [
                "lorelei",
                "miniavs",
                "dylan",
                "pixel-art",
                "rings",
                "avataaars",
            ];
            const familyIndex =
                Number.parseInt(signer.pubkey.substring(0, 8), 16) % avatarFamilies.length;
            const avatarStyle = avatarFamilies[familyIndex];
            const seed = signer.pubkey;
            const avatarUrl = `https://api.dicebear.com/7.x/${avatarStyle}/png?seed=${seed}`;

            const profile = {
                name: backendName,
                description: "TENEX Backend Daemon - Multi-agent orchestration system",
                picture: avatarUrl,
            };

            const profileEvent = new NDKEvent(getNDK(), {
                kind: 0,
                pubkey: signer.pubkey,
                content: JSON.stringify(profile),
                tags: [],
            });

            // Add p-tags for all whitelisted pubkeys
            if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
                for (const pubkey of whitelistedPubkeys) {
                    if (pubkey && pubkey !== signer.pubkey) {
                        profileEvent.tags.push(["p", pubkey]);
                    }
                }
            }

            // Add bot tag to indicate this is an automated system
            profileEvent.tags.push(["bot"]);

            // Add tenex tag for discoverability
            profileEvent.tags.push(["t", "tenex"]);

            // Add tenex-backend tag to distinguish from agents
            profileEvent.tags.push(["t", "tenex-backend"]);

            await profileEvent.sign(signer, { pTags: false });

            try {
                await profileEvent.publish();
                logger.info("Published TENEX backend profile", {
                    pubkey: signer.pubkey.substring(0, 8),
                    name: backendName,
                });
            } catch (publishError) {
                logger.warn("Failed to publish backend profile (may already exist)", {
                    error: publishError,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to create backend profile", {
                error,
            });
            // Don't throw - backend profile is not critical for operation
        }
    }

}

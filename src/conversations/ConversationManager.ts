import path from "node:path";
import type { Phase } from "@/conversations/phases";
import type { AgentState, PhaseTransition } from "@/conversations/types";
import { ensureDirectory } from "@/lib/fs";
import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import {
    type TracingContext,
    createPhaseExecutionContext,
    createTracingContext,
} from "@/tracing";
import { logger } from "@/utils/logger";
import { NDKArticle, type NDKEvent } from "@nostr-dev-kit/ndk";
import { ensureExecutionTimeInitialized } from "./executionTime";
import { FileSystemAdapter } from "./persistence";
import type { ConversationPersistenceAdapter } from "./persistence/types";
import type { Conversation, ConversationMetadata } from "./types";
import { getNDK } from "@/nostr";
import { createExecutionLogger } from "@/logging/ExecutionLogger";
import type { Agent } from "@/agents/types";
import { Message } from "multi-llm-ts";

export class ConversationManager {
    private conversations: Map<string, Conversation> = new Map();
    private conversationContexts: Map<string, TracingContext> = new Map();
    private conversationsDir: string;
    private persistence: ConversationPersistenceAdapter;

    constructor(
        private projectPath: string, 
        persistence?: ConversationPersistenceAdapter
    ) {
        this.conversationsDir = path.join(projectPath, ".tenex", "conversations");
        this.persistence = persistence || new FileSystemAdapter(projectPath);
    }

    getProjectPath(): string {
        return this.projectPath;
    }

    async initialize(): Promise<void> {
        await ensureDirectory(this.conversationsDir);
        await this.persistence.initialize();

        // Load existing conversations
        await this.loadConversations();
    }

    async createConversation(event: NDKEvent): Promise<Conversation> {
        const id = event.id;
        if (!id) {
            throw new Error("Event must have an ID to create a conversation");
        }
        const title = event.tags.find((tag) => tag[0] === "title")?.[1] || "Untitled Conversation";

        // Create tracing context for this conversation
        const tracingContext = createTracingContext(id);
        this.conversationContexts.set(id, tracingContext);

        const executionLogger = createExecutionLogger(tracingContext, "conversation");
        
        // Log conversation start
        executionLogger.logEvent({
            type: "conversation_start",
            conversationId: id,
            title,
            userMessage: event.content || "",
            eventId: event.id
        });

        // Check for 30023 tags (NDKArticle references)
        let referencedArticle: ConversationMetadata["referencedArticle"] | undefined;
        const articleTag = event.tags.find((tag) => tag[0] === "a" && tag[1]?.startsWith("30023:"));

        if (articleTag && articleTag[1]) {
            try {
                // Parse the article reference (format: 30023:pubkey:dtag)
                const [_kind, pubkey, dTag] = articleTag[1].split(":");

                if (pubkey && dTag) {
                    const ndk = getNDK();
                    const filter = {
                        kinds: [30023],
                        authors: [pubkey],
                        "#d": [dTag],
                    };

                    const articles = await ndk.fetchEvents(filter);

                    if (articles.size > 0) {
                        const articleEvent = Array.from(articles)[0];
                        if (!articleEvent) {
                            throw new Error("Article event not found");
                        }
                        const article = NDKArticle.from(articleEvent);

                        referencedArticle = {
                            title: article.title || `Context: ${dTag}`,
                            content: article.content || "",
                            dTag: dTag,
                        };
                    }
                }
            } catch (error) {
                logger.error("Failed to fetch referenced NDKArticle", { error });
            }
        }

        const conversation: Conversation = {
            id,
            title,
            phase: "chat", // All conversations start in chat phase
            history: [event],
            agentStates: new Map<string, AgentState>(), // Initialize empty agent states
            phaseStartedAt: Date.now(),
            metadata: {
                summary: event.content,
                referencedArticle,
            },
            phaseTransitions: [], // Initialize empty phase transitions array
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            },
        };

        this.conversations.set(id, conversation);

        // Save immediately after creation
        await this.persistence.save(conversation);

        return conversation;
    }

    getConversation(id: string): Conversation | undefined {
        return this.conversations.get(id);
    }

    async updatePhase(
        id: string,
        phase: Phase,
        message: string,
        agentPubkey: string,
        agentName: string,
        reason?: string,
        summary?: string
    ): Promise<void> {
        const conversation = this.conversations.get(id);
        if (!conversation) {
            throw new Error(`Conversation ${id} not found`);
        }

        // Get or create tracing context
        let tracingContext = this.conversationContexts.get(id);
        if (!tracingContext) {
            tracingContext = createTracingContext(id);
            this.conversationContexts.set(id, tracingContext);
        }

        // Create phase execution context
        const phaseContext = createPhaseExecutionContext(tracingContext, phase);
        const executionLogger = createExecutionLogger(phaseContext, "conversation");

        const previousPhase = conversation.phase;
        
        // Log phase transition
        executionLogger.logEvent({
            type: "phase_transition_trigger",
            conversationId: id,
            currentPhase: previousPhase,
            trigger: "agent_request",
            triggerAgent: agentName,
            signal: `${previousPhase} → ${phase}`
        });

        // Create transition record even for same-phase handoffs
        const transition: PhaseTransition = {
            from: previousPhase,
            to: phase,
            message,
            timestamp: Date.now(),
            agentPubkey,
            agentName,
            reason,
            summary,
        };

        // Update conversation phase if it changed
        if (previousPhase !== phase) {
            conversation.phase = phase;
            conversation.phaseStartedAt = Date.now();

            // Clear readFiles when transitioning from REFLECTION back to CHAT
            if (previousPhase === "reflection" && phase === "chat") {
                conversation.metadata.readFiles = undefined;
            }
        }

        // Always push the transition (handoff) record
        conversation.phaseTransitions.push(transition);

        // Save after phase update
        await this.persistence.save(conversation);
    }

    async incrementContinueCallCount(conversationId: string, phase: Phase): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Initialize continueCallCounts if not exists
        if (!conversation.metadata.continueCallCounts) {
            conversation.metadata.continueCallCounts = {
                chat: 0,
                brainstorm: 0,
                plan: 0,
                execute: 0,
                verification: 0,
                chores: 0,
                reflection: 0,
            };
        }

        // Increment the count for the current phase
        const currentCount = conversation.metadata.continueCallCounts[phase] || 0;
        conversation.metadata.continueCallCounts[phase] = currentCount + 1;

        // Save after updating count
        await this.persistence.save(conversation);
    }

    getContinueCallCount(conversationId: string, phase: Phase): number {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return 0;
        }

        return conversation.metadata.continueCallCounts?.[phase] || 0;
    }

    async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        conversation.history.push(event);

        // Update the conversation summary to include the latest message
        if (event.content) {
            const isUser = isEventFromUser(event);
            if (isUser) {
                conversation.metadata.summary = event.content;
                conversation.metadata.last_user_message = event.content;
            }
        }

        // Save after adding event
        await this.persistence.save(conversation);
    }

    async updateMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        conversation.metadata = {
            ...conversation.metadata,
            ...metadata,
        };
    }

    getPhaseHistory(conversationId: string): NDKEvent[] {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return [];
        }

        // Return events from current phase only
        // For now, return all events - phase filtering can be added later
        return conversation.history;
    }

    getAllConversations(): Conversation[] {
        return Array.from(this.conversations.values());
    }

    getConversationByEvent(eventId: string): Conversation | undefined {
        // Find conversation that contains this event
        for (const conversation of this.conversations.values()) {
            if (conversation.history.some((e) => e.id === eventId)) {
                return conversation;
            }
        }
        return undefined;
    }

    /**
     * Build messages for an agent using simplified conversation context.
     * This is the SINGLE method for building agent context.
     */
    async buildAgentMessages(
        conversationId: string,
        targetAgent: Agent,
        triggeringEvent?: NDKEvent,
        handoff?: PhaseTransition
    ): Promise<{ messages: Message[]; claudeSessionId?: string }> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Get or initialize the agent's state
        let agentState = conversation.agentStates.get(targetAgent.slug);
        if (!agentState) {
            agentState = { lastProcessedMessageIndex: 0 };
            conversation.agentStates.set(targetAgent.slug, agentState);
            logger.info(`[CONV_MGR] Initialized new agent state for ${targetAgent.slug}`);
        }

        const messagesForLLM: Message[] = [];
        const currentHistoryLength = conversation.history.length;

        // === 1. Add historical context (messages the agent has not yet seen) ===
        const missedEvents = conversation.history.slice(agentState.lastProcessedMessageIndex);
        
        if (missedEvents.length > 0) {
            let contextBlock = "=== MESSAGES WHILE YOU WERE AWAY ===\n\n";
            
            // Add handoff summary if provided
            if (handoff?.summary) {
                contextBlock += `**Previous context**: ${handoff.summary}\n\n`;
            }

            for (const event of missedEvents) {
                if (!event.content) continue;
                const sender = this.getEventSender(event, targetAgent.slug);
                if (sender) { // Don't include the agent's own previous messages
                    if (sender === "User") {
                        contextBlock += `🟢 USER:\n${event.content}\n\n`;
                    } else {
                        contextBlock += `💬 ${sender}:\n${event.content}\n\n`;
                    }
                }
            }
            
            contextBlock += "=== END OF HISTORY ===\n";
            contextBlock += "Respond to the most recent user message above, considering the context.\n\n";
            
            messagesForLLM.push(new Message("system", contextBlock));
            logger.debug(`[CONV_MGR] Added historical context for ${targetAgent.slug}`, { 
                missedEventsCount: missedEvents.length 
            });
        }

        // === 2. Add "NEW INTERACTION" marker (if applicable) ===
        // Always for orchestrator, or for any agent if there was historical context
        const shouldAddMarker = targetAgent.isOrchestrator || missedEvents.length > 0;
        if (shouldAddMarker) {
            messagesForLLM.push(new Message("system", "=== NEW INTERACTION ==="));
        }

        // === 3. Add the current triggering event as the primary message ===
        if (triggeringEvent?.content) {
            if (isEventFromUser(triggeringEvent)) {
                messagesForLLM.push(new Message("user", triggeringEvent.content));
            } else {
                // If from another agent, attribute it as a system message
                const eventAgentSlug = getAgentSlugFromEvent(triggeringEvent);
                const projectCtx = getProjectContext();
                const sendingAgentName = eventAgentSlug ? 
                    (projectCtx.agents.get(eventAgentSlug)?.name || "Another agent") : 
                    "Another agent";
                messagesForLLM.push(new Message("system", `[${sendingAgentName}]: ${triggeringEvent.content}`));
            }
        } else if (handoff?.message) {
            // If no explicit triggering event content, but a handoff message exists
            messagesForLLM.push(new Message("user", handoff.message));
        }

        // === 4. Update agent's state for next turn ===
        agentState.lastProcessedMessageIndex = currentHistoryLength;
        
        // Update Claude session ID from the triggering event if available
        const claudeSessionFromTrigger = triggeringEvent?.tagValue?.('claude-session');
        if (claudeSessionFromTrigger) {
            agentState.claudeSessionId = claudeSessionFromTrigger;
        }

        // Save the updated conversation state
        await this.persistence.save(conversation);
        
        return { 
            messages: messagesForLLM, 
            claudeSessionId: agentState.claudeSessionId 
        };
    }

    /**
     * Update an agent's state (e.g., to store Claude session ID)
     */
    async updateAgentState(
        conversationId: string, 
        agentSlug: string, 
        updates: Partial<AgentState>
    ): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }
        
        let agentState = conversation.agentStates.get(agentSlug);
        if (!agentState) {
            logger.warn(`[CONV_MGR] Agent state not found for ${agentSlug}, creating new one for update.`);
            agentState = { lastProcessedMessageIndex: 0 };
            conversation.agentStates.set(agentSlug, agentState);
        }
        
        Object.assign(agentState, updates);
        await this.persistence.save(conversation);
        logger.debug(`[CONV_MGR] Updated agent state for ${agentSlug}`, { updates });
    }

    /**
     * Helper to determine who sent an event
     */
    private getEventSender(event: NDKEvent, agentSlug: string): string | null {
        const eventAgentSlug = getAgentSlugFromEvent(event);
        
        // Skip the agent's own previous messages
        if (eventAgentSlug === agentSlug) {
            return null;
        }
        
        if (isEventFromUser(event)) {
            return "User";
        } else if (eventAgentSlug) {
            const projectCtx = getProjectContext();
            const sendingAgent = projectCtx.agents.get(eventAgentSlug);
            return sendingAgent ? sendingAgent.name : "Another agent";
        } else {
            return "Unknown";
        }
    }

    // Persistence methods
    private async loadConversations(): Promise<void> {
        try {
            const metadata = await this.persistence.list();

            for (const meta of metadata) {
                if (!meta.archived) {
                    const conversation = await this.persistence.load(meta.id);
                    if (conversation) {
                        // Ensure execution time is initialized for loaded conversations
                        ensureExecutionTimeInitialized(conversation);

                        // Initialize agentStates as a Map if not present
                        if (!conversation.agentStates) {
                            conversation.agentStates = new Map<string, AgentState>();
                        } else if (!(conversation.agentStates instanceof Map)) {
                            // Convert from plain object to Map after deserialization
                            const statesObj = conversation.agentStates as Record<string, AgentState>;
                            conversation.agentStates = new Map<string, AgentState>(
                                Object.entries(statesObj)
                            );
                        }

                        this.conversations.set(meta.id, conversation);
                    }
                }
            }
        } catch (error) {
            logger.error("Failed to load conversations", { error });
        }
    }

    async saveConversation(conversationId: string): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (conversation) {
            await this.persistence.save(conversation);
        }
    }

    async archiveConversation(conversationId: string): Promise<void> {
        await this.persistence.archive(conversationId);
        this.conversations.delete(conversationId);
    }

    async searchConversations(query: string): Promise<Conversation[]> {
        const metadata = await this.persistence.search({ title: query });
        const conversations: Conversation[] = [];

        for (const meta of metadata) {
            const conversation = await this.persistence.load(meta.id);
            if (conversation) {
                conversations.push(conversation);
            }
        }

        return conversations;
    }

    async cleanup(): Promise<void> {
        // Save all conversations before cleanup
        const promises: Promise<void>[] = [];
        for (const conversation of this.conversations.values()) {
            promises.push(this.persistence.save(conversation));
        }
        await Promise.all(promises);
    }

    /**
     * Get the tracing context for a conversation
     */
    getTracingContext(conversationId: string): TracingContext | undefined {
        return this.conversationContexts.get(conversationId);
    }

    /**
     * Clean up conversation metadata that's no longer needed
     */
    cleanupConversationMetadata(conversationId: string): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return;
        }

        // Clear readFiles tracking
        if (conversation.metadata.readFiles) {
            logger.info("[CONVERSATION] Cleaning up readFiles metadata", {
                conversationId,
                fileCount: conversation.metadata.readFiles.length,
            });
            conversation.metadata.readFiles = undefined;
        }
    }

    /**
     * Complete a conversation and clean up its resources
     */
    async completeConversation(conversationId: string): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return;
        }

        logger.info("[CONVERSATION] Completing conversation", {
            conversationId,
            title: conversation.title,
            phase: conversation.phase,
        });

        // Clean up metadata
        this.cleanupConversationMetadata(conversationId);

        // Remove from active conversations
        this.conversations.delete(conversationId);
        this.conversationContexts.delete(conversationId);

        // Save final state
        await this.persistence.save(conversation);
    }

    // DEPRECATED: Temporary method for backward compatibility during migration
    getAgentContext(conversationId: string, agentSlug: string): { claudeSessionId?: string } | undefined {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return undefined;
        }
        
        const agentState = conversation.agentStates.get(agentSlug);
        if (!agentState) {
            return undefined;
        }
        
        // Return a minimal object that satisfies the claudeSessionId check
        return {
            claudeSessionId: agentState.claudeSessionId
        };
    }
}
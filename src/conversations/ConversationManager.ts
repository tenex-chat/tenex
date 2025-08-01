import path from "node:path";
import type { Phase } from "@/conversations/phases";
import type { AgentContext, PhaseTransition } from "@/conversations/types";
import { ensureDirectory } from "@/lib/fs";
import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import {
    type TracingContext,
    createPhaseExecutionContext,
    createTracingContext,
    createTracingLogger,
} from "@/tracing";
import { logger } from "@/utils/logger";
import { NDKArticle, type NDKEvent } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import { ensureExecutionTimeInitialized } from "./executionTime";
import { FileSystemAdapter } from "./persistence";
import type { ConversationPersistenceAdapter } from "./persistence/types";
import type { Conversation, ConversationMetadata } from "./types";
import { getNDK } from "@/nostr";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";

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

        const tracingLogger = createTracingLogger(tracingContext, "conversation");
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
                const [kind, pubkey, dTag] = articleTag[1].split(":");

                if (pubkey && dTag) {
                    const ndk = getNDK();
                    const filter = {
                        kinds: [30023],
                        authors: [pubkey],
                        "#d": [dTag],
                    };

                    const startTime = Date.now();
                    const articles = await ndk.fetchEvents(filter);
                    const duration = Date.now() - startTime;

                    tracingLogger.info(`Fetched NDKArticle in ${duration}ms`, {
                        duration,
                        articleCount: articles.size,
                        dTag,
                    });

                    if (articles.size > 0) {
                        const articleEvent = Array.from(articles)[0];
                        const article = NDKArticle.from(articleEvent);

                        referencedArticle = {
                            title: article.title || `Context: ${dTag}`,
                            content: article.content || "",
                            dTag: dTag,
                        };

                        tracingLogger.info("Referenced NDKArticle content loaded", {
                            dTag,
                            title: referencedArticle.title,
                            contentLength: referencedArticle.content.length,
                        });
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
            agentContexts: new Map<string, AgentContext>(), // Initialize empty agent contexts
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
        const tracingLogger = createTracingLogger(phaseContext, "conversation");
        const executionLogger = createExecutionLogger(phaseContext, "conversation");

        const previousPhase = conversation.phase;
        
        // Log phase transition trigger
        executionLogger.logEvent({
            type: "phase_transition_trigger",
            conversationId: id,
            currentPhase: previousPhase,
            trigger: "agent_request",
            triggerAgent: agentName,
            signal: `${previousPhase} → ${phase}`
        });
        
        // Log phase transition decision
        executionLogger.logEvent({
            type: "phase_transition_decision",
            conversationId: id,
            from: previousPhase,
            to: phase,
            decisionBy: agentName,
            reason: reason || "Phase transition requested",
            confidence: 0.9
        });

        // Create transition record even for same-phase handoffs
        // This ensures handoff information is always persisted
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
            // This starts a new conversation cycle with fresh file tracking
            if (previousPhase === "reflection" && phase === "chat") {
                const previousCount = conversation.metadata.readFiles?.length || 0;
                conversation.metadata.readFiles = undefined;
                logger.info(
                    "[CONVERSATION] Cleared readFiles metadata on REFLECTION->CHAT transition",
                    {
                        conversationId: id,
                        previousReadFiles: previousCount,
                    }
                );
            }
        } else {
            // Log handoff within same phase
            tracingLogger.info(`[CONVERSATION] Handoff within phase "${phase}"`, {
                phase,
                conversationTitle: conversation.title,
                fromAgent: agentName,
                message: `${message.substring(0, 100)}...`,
            });
        }

        // Always push the transition (handoff) record
        conversation.phaseTransitions.push(transition);

        // Save after phase update
        await this.persistence.save(conversation);
        
        // Log phase transition executed
        const duration = Date.now() - transition.timestamp;
        executionLogger.logEvent({
            type: "phase_transition_executed",
            conversationId: id,
            from: previousPhase,
            to: phase,
            handoffTo: agentName,
            handoffMessage: message,
            duration
        });
        
        // Log agent handoff if within same phase
        if (previousPhase === phase) {
            executionLogger.logEvent({
                type: "agent_handoff",
                from: agentName,
                to: agentName, // This could be improved to track actual handoff target
                task: message,
                phase: phase
            });
        }
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

        logger.info("[CONTINUE_TRACKING] Incremented continue call count", {
            conversationId,
            phase,
            newCount: currentCount + 1,
            allCounts: conversation.metadata.continueCallCounts,
        });

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

        // Get or create tracing context
        let tracingContext = this.conversationContexts.get(conversationId);
        if (!tracingContext) {
            tracingContext = createTracingContext(conversationId);
            this.conversationContexts.set(conversationId, tracingContext);
        }

        const tracingLogger = createTracingLogger(tracingContext, "conversation");

        conversation.history.push(event);

        // Update the conversation summary to include the latest message
        // This ensures other parts of the system have access to updated context
        if (event.content) {
            const isUser = isEventFromUser(event);
            if (isUser) {
                // For user messages, update the summary to be more descriptive
                conversation.metadata.summary = event.content;
                conversation.metadata.last_user_message = event.content;
            }

            tracingLogger.logEventReceived(
                event.id || "unknown",
                isUser ? "user_message" : "agent_response",
                {
                    phase: conversation.phase,
                    historyLength: conversation.history.length,
                }
            );
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
        // when we implement phase transition events
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

    // Persistence methods
    private async loadConversations(): Promise<void> {
        try {
            const metadata = await this.persistence.list();
            let _loadedCount = 0;

            for (const meta of metadata) {
                if (!meta.archived) {
                    const conversation = await this.persistence.load(meta.id);
                    if (conversation) {
                        // Ensure execution time is initialized for loaded conversations
                        ensureExecutionTimeInitialized(conversation);

                        // Initialize agentContexts as a Map if not present
                        if (!conversation.agentContexts) {
                            conversation.agentContexts = new Map<string, AgentContext>();
                        } else if (!(conversation.agentContexts instanceof Map)) {
                            // Convert from plain object to Map after deserialization
                            const contextsObj = conversation.agentContexts as Record<
                                string,
                                AgentContext
                            >;
                            conversation.agentContexts = new Map<string, AgentContext>(
                                Object.entries(contextsObj)
                            );
                        }

                        this.conversations.set(meta.id, conversation);
                        _loadedCount++;
                    }
                }
            }
        } catch (error) {
            logger.error("Failed to load conversations", { error });
        }
    }

    private async saveAllConversations(): Promise<void> {
        const promises: Promise<void>[] = [];

        for (const conversation of this.conversations.values()) {
            promises.push(this.persistence.save(conversation));
        }

        await Promise.all(promises);
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
        await this.saveAllConversations();
    }

    /**
     * Get the tracing context for a conversation
     */
    getTracingContext(conversationId: string): TracingContext | undefined {
        return this.conversationContexts.get(conversationId);
    }

    // Agent Context Management Methods

    /**
     * Create a new context for an agent in a conversation
     */
    createAgentContext(
        conversationId: string,
        agentSlug: string,
        handoff?: PhaseTransition
    ): AgentContext {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        const messages: Message[] = [];

        // If there's a handoff, create system message for context and user message for the request
        if (handoff) {
            // First, add a system message with the context
            if (handoff.summary) {
                let contextContent = "";

                if (handoff.summary) {
                    contextContent += `**Current State:**\n${handoff.summary}\n\n`;
                }

                messages.push(new Message("system", contextContent.trim()));
            }

            // Then add the user message with the actual request
            messages.push(new Message("user", handoff.message));
        }

        const context: AgentContext = {
            agentSlug,
            messages,
            tokenCount: 0, // Will be updated when messages are added
            lastUpdate: new Date(),
        };

        conversation.agentContexts.set(agentSlug, context);

        logger.info(`[AGENT_CONTEXT] Context created for agent: ${agentSlug}`, {
            conversationId,
            agentSlug,
            messageCount: context.messages.length,
            messages: context.messages.map((m) => ({
                role: m.role,
                content: `${m.content.substring(0, 100)}...`,
            })),
        });

        return context;
    }

    /**
     * Add a message to an agent's context
     */
    async addMessageToContext(
        conversationId: string,
        agentSlug: string,
        message: Message
    ): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // logger.info(`[AGENT_CONTEXT] Adding message to agent context`, {
        //   conversationId,
        //   agentSlug,
        //   messageRole: message.role,
        //   messageContent: message.content.substring(0, 100) + "...",
        //   currentPhase: conversation.phase
        // });

        let context = conversation.agentContexts.get(agentSlug);
        if (!context) {
            logger.warn(
                `[AGENT_CONTEXT] Context not found for agent ${agentSlug}, creating new context`
            );
            // Create context if it doesn't exist
            context = this.createAgentContext(conversationId, agentSlug);
        }

        context.messages.push(message);
        context.lastUpdate = new Date();

        // logger.info(`[AGENT_CONTEXT] Message added to agent context`, {
        //   conversationId,
        //   agentSlug,
        //   totalMessages: context.messages.length,
        //   contextState: context.messages.map(m => ({
        //     role: m.role,
        //     preview: m.content.substring(0, 50) + "..."
        //   }))
        // });

        // TODO: Update token count based on message content
        // This would require tokenization logic specific to the model being used

        // Save after updating context
        await this.persistence.save(conversation);
    }

    /**
     * Get an agent's context from a conversation
     */
    getAgentContext(conversationId: string, agentSlug: string): AgentContext | undefined {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            logger.warn(
                `[AGENT_CONTEXT] Conversation ${conversationId} not found when getting agent context`
            );
            return undefined;
        }

        const context = conversation.agentContexts.get(agentSlug);

        return context;
    }

    /**
     * Synchronize an agent's context with messages they missed since last active
     */
    async synchronizeAgentContext(
        conversationId: string,
        agentSlug: string,
        triggeringEvent?: NDKEvent
    ): Promise<void> {
        const syncContext = this.validateAndGetSyncContext(conversationId, agentSlug);
        
        // Get all events that need processing
        const { historicalEvents, shouldProcessTrigger } = this.categorizeEvents(
            syncContext,
            triggeringEvent
        );
        
        // Add historical context if needed
        if (historicalEvents.length > 0) {
            await this.addHistoricalContext(syncContext, historicalEvents);
        }
        
        // Add current triggering event if needed
        if (triggeringEvent?.content && shouldProcessTrigger) {
            await this.addTriggeringEvent(
                syncContext,
                triggeringEvent,
                historicalEvents.length > 0
            );
        }
        
        // Update tracking and save
        await this.finalizeSynchronization(syncContext);
    }
    
    /**
     * Validate inputs and get synchronization context
     */
    private validateAndGetSyncContext(
        conversationId: string,
        agentSlug: string
    ): { conversation: Conversation; context: AgentContext; agentSlug: string; lastUpdateTime: number } {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }
        
        const context = conversation.agentContexts.get(agentSlug);
        if (!context) {
            throw new Error(`Agent context for ${agentSlug} not found`);
        }
        
        return {
            conversation,
            context,
            agentSlug,
            lastUpdateTime: context.lastUpdate.getTime()
        };
    }
    
    /**
     * Categorize events into historical and triggering
     */
    private categorizeEvents(
        syncContext: { conversation: Conversation; lastUpdateTime: number },
        triggeringEvent?: NDKEvent
    ): { historicalEvents: NDKEvent[], shouldProcessTrigger: boolean } {
        const { conversation, lastUpdateTime } = syncContext;
        const missedEvents: NDKEvent[] = [];
        
        // Find all events after last update
        for (const event of conversation.history) {
            const eventTime = (event.created_at || 0) * 1000;
            if (eventTime > lastUpdateTime) {
                missedEvents.push(event);
            }
        }
        
        // Include triggering event if not in history
        if (triggeringEvent && !missedEvents.find(e => e.id === triggeringEvent.id)) {
            const triggeringTime = (triggeringEvent.created_at || 0) * 1000;
            if (triggeringTime > lastUpdateTime) {
                missedEvents.push(triggeringEvent);
            }
        }
        
        // Separate historical from triggering
        const historicalEvents = missedEvents.filter(e => e.id !== triggeringEvent?.id);
        const shouldProcessTrigger = triggeringEvent ? 
            this.shouldProcessTriggeringEvent(syncContext, triggeringEvent) : false;
        
        return { historicalEvents, shouldProcessTrigger };
    }
    
    /**
     * Check if triggering event should be processed as new action
     */
    private shouldProcessTriggeringEvent(
        syncContext: { conversation: Conversation; lastUpdateTime: number },
        triggeringEvent: NDKEvent
    ): boolean {
        const { conversation, lastUpdateTime } = syncContext;
        
        // Is it new (not in history)?
        const isNew = !conversation.history.find(e => e.id === triggeringEvent.id);
        
        // Or is it newer than last update?
        const isNewer = (triggeringEvent.created_at || 0) * 1000 > lastUpdateTime;
        
        return isNew || isNewer;
    }
    
    /**
     * Add historical context block
     */
    private async addHistoricalContext(
        syncContext: { context: AgentContext; agentSlug: string },
        historicalEvents: NDKEvent[]
    ): Promise<void> {
        const { context, agentSlug } = syncContext;
        
        let contextBlock = "<conversation-history>\n";
        contextBlock += "This is what happened while you were not active. ";
        contextBlock += "This is provided for context only - do not act on these messages:\n\n";
        
        for (const event of historicalEvents) {
            if (!event.content) continue;
            
            const sender = this.getEventSender(event, agentSlug);
            if (!sender) continue; // Skip agent's own messages
            
            contextBlock += `[${sender}]: ${event.content}\n\n`;
        }
        
        contextBlock += "\nREMINDER: The above messages are historical context only. ";
        contextBlock += "Do NOT act on them.\n";
        contextBlock += "</conversation-history>\n\n";
        
        context.messages.push(new Message("system", contextBlock));
        
        logger.info("[AGENT_CONTEXT] Added historical context block", {
            agentSlug,
            historicalEventCount: historicalEvents.length,
            contextLength: contextBlock.length,
        });
    }
    
    /**
     * Get sender name for an event, returns null if it's the agent's own message
     */
    private getEventSender(event: NDKEvent, agentSlug: string): string | null {
        const eventAgentSlug = getAgentSlugFromEvent(event);
        
        // Skip if this is the agent's own message
        if (eventAgentSlug === agentSlug) {
            logger.debug(`[AGENT_CONTEXT] Skipping agent's own message`, {
                agentSlug,
                eventId: event.id,
            });
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
    
    /**
     * Add triggering event as an action message
     */
    private async addTriggeringEvent(
        syncContext: { context: AgentContext; agentSlug: string },
        triggeringEvent: NDKEvent,
        hasHistoricalContext: boolean
    ): Promise<void> {
        const { context, agentSlug } = syncContext;
        
        // Add separator if we had historical context
        if (hasHistoricalContext) {
            context.messages.push(new Message("system", "=== NEW INTERACTION ==="));
        }
        
        // Add the actual message that needs action
        if (isEventFromUser(triggeringEvent)) {
            context.messages.push(new Message("user", triggeringEvent.content));
        } else {
            const eventAgentSlug = getAgentSlugFromEvent(triggeringEvent);
            if (eventAgentSlug && eventAgentSlug !== agentSlug) {
                const projectCtx = getProjectContext();
                const sendingAgent = projectCtx.agents.get(eventAgentSlug);
                const senderName = sendingAgent ? sendingAgent.name : "Another agent";
                // Use consistent format
                context.messages.push(
                    new Message("system", `[${senderName}]: ${triggeringEvent.content}`)
                );
            }
        }
        
        logger.info("[AGENT_CONTEXT] Added current message for action", {
            agentSlug,
            messagePreview: `${triggeringEvent.content.substring(0, 100)}...`,
        });
    }
    
    /**
     * Finalize synchronization: update timestamp and save
     */
    private async finalizeSynchronization(
        syncContext: { context: AgentContext; conversation: Conversation }
    ): Promise<void> {
        const { context, conversation } = syncContext;
        
        // Update the last update time
        context.lastUpdate = new Date();
        
        // Save the updated conversation
        await this.persistence.save(conversation);
    }

    /**
     * Bootstrap context for an agent that joins without a handoff
     * (e.g., directly mentioned via p-tag)
     */
    async bootstrapAgentContext(
        conversationId: string,
        agentSlug: string,
        triggeringEvent?: NDKEvent
    ): Promise<AgentContext> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Check if this is a new conversation (only has the initial event)
        const isNewConversation = conversation.history.length === 1;

        // For new conversations, just pass the user message directly
        if (isNewConversation && triggeringEvent?.content) {
            const messages: Message[] = [new Message("user", triggeringEvent.content)];

            const context: AgentContext = {
                agentSlug,
                messages,
                tokenCount: 0,
                lastUpdate: new Date(),
            };

            conversation.agentContexts.set(agentSlug, context);

            return context;
        }

        // For ongoing conversations, create a comprehensive context
        let summary = "You've been brought into an ongoing conversation.\n\n";
        
        // First, include all phase transitions to show conversation flow
        if (conversation.phaseTransitions.length > 0) {
            summary += "=== CONVERSATION FLOW ===\n";
            summary += "The conversation has evolved through the following phases:\n\n";
            
            for (const transition of conversation.phaseTransitions) {
                const transitionTime = new Date(transition.timestamp).toLocaleTimeString();
                
                // Format phase transition
                if (transition.from !== transition.to) {
                    summary += `📍 Phase: ${transition.from} → ${transition.to} (${transitionTime})\n`;
                } else {
                    summary += `🔄 Handoff within ${transition.from} phase (${transitionTime})\n`;
                }
                
                summary += `   By: ${transition.agentName}\n`;
                
                if (transition.reason) {
                    summary += `   Reason: ${transition.reason}\n`;
                }
                
                // Include the full transition message as it contains important context
                summary += `   Context: ${transition.message}\n\n`;
            }
            
            summary += "\n";
        }
        
        // Then include recent messages for immediate context
        const recentHistory = conversation.history.slice(-10); // Last 10 messages
        summary += "=== RECENT CONTEXT ===\n";
        summary += "Last 10 messages for immediate context:\n\n";

        for (const event of recentHistory) {
            if (event.content) {
                let sender: string;
                if (isEventFromUser(event)) {
                    sender = "User";
                } else {
                    // Try to get the actual agent slug from the event
                    const eventAgentSlug = getAgentSlugFromEvent(event);
                    sender = eventAgentSlug || "Agent";
                }
                summary += `${sender}: ${event.content.substring(0, 200)}...\n\n`;
            }
        }

        // If we have a triggering event and it's not already in the summary, add it
        if (triggeringEvent?.content) {
            const isInRecent = recentHistory.some((e) => e.id === triggeringEvent.id);
            if (!isInRecent) {
                const sender = isEventFromUser(triggeringEvent) ? "User" : "Agent";
                summary += `\n=== CURRENT REQUEST ===\n`;
                summary += `${sender}: ${triggeringEvent.content}\n\n`;
            }
        }

        const handoff: PhaseTransition = {
            from: conversation.phase,
            to: conversation.phase,
            message: triggeringEvent?.content || "Direct mention - bootstrapping context",
            timestamp: Date.now(),
            agentPubkey: "", // Will be filled by orchestrator
            agentName: "system",
            summary: summary,
        };

        const context = this.createAgentContext(conversationId, agentSlug, handoff);

        logger.info("[AGENT_CONTEXT] Bootstrap completed for ongoing conversation", {
            conversationId,
            agentSlug,
            summaryLength: summary.length,
            handoffMessage: handoff.message,
        });

        return context;
    }

    /**
     * Remove old contexts to manage memory
     */
    pruneOldContexts(conversationId: string): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return;
        }

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        // Remove contexts that haven't been updated in over an hour
        for (const [agentSlug, context] of conversation.agentContexts.entries()) {
            if (context.lastUpdate < oneHourAgo) {
                conversation.agentContexts.delete(agentSlug);
            }
        }
    }

    /**
     * Clean up conversation metadata that's no longer needed
     * This includes readFiles and other temporary metadata
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

        // Could add cleanup for other temporary metadata here in the future
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
}

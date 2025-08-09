import path from "node:path";
import type { Phase } from "@/conversations/phases";
import { PHASES } from "@/conversations/phases";
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
import type { AgentInstance } from "@/agents/types";
import { Message } from "multi-llm-ts";

export class ConversationManager {
    private static readonly NOSTR_ENTITY_REGEX = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)\w+/g;
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
            timestamp: new Date(),
            conversationId: id,
            agent: "system",
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
            phase: PHASES.CHAT, // All conversations start in chat phase
            history: [event],
            agentStates: new Map<string, AgentState>(), // Initialize empty agent states
            phaseStartedAt: Date.now(),
            metadata: {
                summary: event.content,
                referencedArticle,
            },
            phaseTransitions: [], // Initialize empty phase transitions array
            orchestratorTurns: [], // Initialize empty orchestrator turns array
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
            type: "phase_transition",
            timestamp: new Date(),
            conversationId: id,
            agent: agentName,
            from: previousPhase,
            to: phase,
            reason: reason || ""
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
            if (previousPhase === PHASES.REFLECTION && phase === PHASES.CHAT) {
                conversation.metadata.readFiles = undefined;
            }
        }

        // Always push the transition (handoff) record
        conversation.phaseTransitions.push(transition);

        // Save after phase update
        await this.persistence.save(conversation);
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
            // When initializing a new agent state, we need to determine the correct starting index
            // The key is: should this agent see the conversation history or not?
            let initialIndex = 0;
            
            if (triggeringEvent?.id) {
                // Check if this agent is p-tagged in the triggering event
                const isDirectlyAddressed = triggeringEvent.tags?.some(
                    tag => tag[0] === "p" && tag[1] === targetAgent.pubkey
                );
                
                if (isDirectlyAddressed) {
                    // Find the triggering event's position in history
                    const triggeringEventIndex = conversation.history.findIndex(
                        e => e.id === triggeringEvent.id
                    );
                    
                    // Only skip history if this is the FIRST message (index 0)
                    // Otherwise, the agent should see prior conversation history
                    if (triggeringEventIndex === 0) {
                        // This is the conversation starter - no history to show
                        initialIndex = 0;
                        logger.info(`[CONV_MGR] Agent ${targetAgent.slug} p-tagged at conversation start`);
                    } else if (triggeringEventIndex > 0) {
                        // Agent is being brought into existing conversation
                        // They should see history but not the current message
                        initialIndex = 0; // Start from beginning to see all history
                        logger.info(`[CONV_MGR] Agent ${targetAgent.slug} p-tagged mid-conversation, will see history`);
                    }
                }
            }
            
            agentState = { lastProcessedMessageIndex: initialIndex };
            conversation.agentStates.set(targetAgent.slug, agentState);
            logger.info(`[CONV_MGR] Initialized new agent state for ${targetAgent.slug} at index ${initialIndex}`);
        }

        const messagesForLLM: Message[] = [];
        const currentHistoryLength = conversation.history.length;

        // === 1. Build complete conversation history ===
        // We need to provide the FULL conversation history to maintain context
        // This includes ALL messages, not just "missed" ones
        
        // First, collect ALL previous messages up to (but not including) the triggering event
        const allPreviousMessages: NDKEvent[] = [];
        for (const event of conversation.history) {
            // Stop when we reach the triggering event (it will be added as the primary message)
            if (triggeringEvent?.id && event.id === triggeringEvent.id) {
                break;
            }
            if (event.content) {
                allPreviousMessages.push(event);
            }
        }
        
        // Now separate into the agent's own messages and others' messages
        const ownPreviousMessages: NDKEvent[] = [];
        const othersPreviousMessages: NDKEvent[] = [];
        
        for (const event of allPreviousMessages) {
            const eventAgentSlug = getAgentSlugFromEvent(event);
            if (eventAgentSlug === targetAgent.slug) {
                ownPreviousMessages.push(event);
            } else {
                othersPreviousMessages.push(event);
            }
        }
        
        // Build the conversation in proper order
        // We need to interleave messages to maintain the conversation flow
        const conversationHistory: { event: NDKEvent; isOwn: boolean }[] = [];
        
        for (const event of allPreviousMessages) {
            const eventAgentSlug = getAgentSlugFromEvent(event);
            conversationHistory.push({
                event,
                isOwn: eventAgentSlug === targetAgent.slug
            });
        }
        
        // Add messages in conversation order
        for (const { event, isOwn } of conversationHistory) {
            // Process nostr entities in historical messages
            const processedContent = await this.processNostrEntities(event.content);
            
            if (isOwn) {
                // Agent's own message - add as assistant
                messagesForLLM.push(new Message("assistant", processedContent));
                logger.debug(`[CONV_MGR] Added agent's own message as assistant message`);
            } else if (isEventFromUser(event)) {
                // User message - add as user
                messagesForLLM.push(new Message("user", processedContent));
                logger.debug(`[CONV_MGR] Added user message to history`);
            } else {
                // Another agent's message - add as system with attribution
                const eventAgentSlug = getAgentSlugFromEvent(event);
                const projectCtx = getProjectContext();
                const sendingAgentName = eventAgentSlug ? 
                    (projectCtx.agents.get(eventAgentSlug)?.name || "Another agent") : 
                    "Unknown";
                messagesForLLM.push(new Message("system", `[${sendingAgentName}]: ${processedContent}`));
                logger.debug(`[CONV_MGR] Added other agent's message as system message`);
            }
        }
        
        // Now handle NEW messages that the agent hasn't processed yet (for awareness)
        const missedEvents = conversation.history.slice(agentState.lastProcessedMessageIndex);
        const newOthersMessages: NDKEvent[] = [];
        
        for (const event of missedEvents) {
            if (!event.content) continue;
            if (triggeringEvent?.id && event.id === triggeringEvent.id) continue; // Skip triggering event
            
            const eventAgentSlug = getAgentSlugFromEvent(event);
            // Include messages from others that the agent hasn't seen yet
            if (eventAgentSlug !== targetAgent.slug) {
                newOthersMessages.push(event);
            }
        }
        
        // Track if we added a "MESSAGES WHILE YOU WERE AWAY" block
        let addedMessagesWhileAway = false;
        
        // If there are NEW messages from others while the agent was away, add them in a block
        if (newOthersMessages.length > 0) {
            let contextBlock = "=== MESSAGES WHILE YOU WERE AWAY ===\n\n";
            
            if (handoff?.summary) {
                contextBlock += `**Previous context**: ${handoff.summary}\n\n`;
            }

            for (const event of newOthersMessages) {
                const sender = this.getEventSenderForHistory(event, targetAgent.slug);
                if (sender) {
                    // Process nostr entities in new messages
                    const processedContent = await this.processNostrEntities(event.content);
                    contextBlock += `${sender}:\n${processedContent}\n\n`;
                }
            }
            
            contextBlock += "=== END OF HISTORY ===\n";
            contextBlock += "Respond to the most recent user message above, considering the context.\n\n";
            
            messagesForLLM.push(new Message("system", contextBlock));
            addedMessagesWhileAway = true;
            logger.debug(`[CONV_MGR] Added new messages while away for ${targetAgent.slug}`, { 
                newMessagesCount: newOthersMessages.length 
            });
        }

        // === 2. Add "NEW INTERACTION" marker (if applicable) ===
        // Only add when we've shown messages while away, to differentiate the new message
        if (addedMessagesWhileAway) {
            messagesForLLM.push(new Message("system", "=== NEW INTERACTION ==="));
        }

        // === 3. Add the current triggering event as the primary message ===
        if (triggeringEvent?.content) {
            // Process nostr entities in the content
            const processedContent = await this.processNostrEntities(triggeringEvent.content);
            
            if (isEventFromUser(triggeringEvent)) {
                messagesForLLM.push(new Message("user", processedContent));
            } else {
                // If from another agent, attribute it as a system message
                const eventAgentSlug = getAgentSlugFromEvent(triggeringEvent);
                const projectCtx = getProjectContext();
                const sendingAgentName = eventAgentSlug ? 
                    (projectCtx.agents.get(eventAgentSlug)?.name || "Another agent") : 
                    "Another agent";
                messagesForLLM.push(new Message("system", `[${sendingAgentName}]: ${processedContent}`));
            }
        } else if (handoff?.message) {
            // If no explicit triggering event content, but a handoff message exists
            const processedHandoffMessage = await this.processNostrEntities(handoff.message);
            messagesForLLM.push(new Message("user", processedHandoffMessage));
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
     * Build structured routing context for the orchestrator
     */
    async buildOrchestratorRoutingContext(
        conversationId: string,
        triggeringEvent?: NDKEvent
    ): Promise<import("./types").OrchestratorRoutingContext> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Get original user request from first event
        const original_request = conversation.history[0]?.content || "";
        
        // Get the most recent user message (might be different if conversation restarted)
        let user_request = original_request;
        for (let i = conversation.history.length - 1; i >= 0; i--) {
            const event = conversation.history[i];
            // Check for user messages (kind 14)
            if (event.kind === 14 && event.tags?.some(tag => tag[0] === "t" && tag[1] === "user")) {
                user_request = event.content || "";
                break;
            }
        }
        
        // Build routing history from orchestrator turns
        const routing_history: import("./types").RoutingEntry[] = [];
        let current_routing: import("./types").RoutingEntry | null = null;
        
        // Process completed turns
        for (const turn of conversation.orchestratorTurns) {
            if (turn.isCompleted) {
                routing_history.push({
                    phase: turn.phase,
                    agents: turn.agents,
                    completions: turn.completions,
                    reason: turn.reason,
                    timestamp: turn.timestamp
                });
            } else {
                // This is the current active turn
                // Check if triggering event is a completion for this turn
                if (triggeringEvent) {
                    const newCompletion = this.extractCompletionFromEvent(triggeringEvent);
                    if (newCompletion && turn.agents.includes(newCompletion.agent)) {
                        // Add this completion to the turn
                        turn.completions.push(newCompletion);
                        
                        // Check if all agents have now completed
                        const completedAgents = new Set(turn.completions.map(c => c.agent));
                        if (turn.agents.every(agent => completedAgents.has(agent))) {
                            // Turn is now complete, add to history
                            routing_history.push({
                                phase: turn.phase,
                                agents: turn.agents,
                                completions: turn.completions,
                                reason: turn.reason,
                                timestamp: turn.timestamp
                            });
                            // Mark turn as completed
                            turn.isCompleted = true;
                            current_routing = null; // Need new routing
                        } else {
                            // Still waiting for other agents
                            current_routing = {
                                phase: turn.phase,
                                agents: turn.agents,
                                completions: turn.completions,
                                reason: turn.reason,
                                timestamp: turn.timestamp
                            };
                        }
                    } else {
                        // No new completion, turn still active
                        current_routing = {
                            phase: turn.phase,
                            agents: turn.agents,
                            completions: turn.completions,
                            reason: turn.reason,
                            timestamp: turn.timestamp
                        };
                    }
                } else {
                    // No triggering event, turn still active
                    current_routing = {
                        phase: turn.phase,
                        agents: turn.agents,
                        completions: turn.completions,
                        reason: turn.reason,
                        timestamp: turn.timestamp
                    };
                }
            }
        }
        
        // If no orchestrator turns yet (fresh conversation), current_routing is null
        // Orchestrator will need to make first routing decision
        
        return {
            user_request,
            routing_history,
            current_routing
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
     * Helper to determine who sent an event (for current context)
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

    /**
     * Helper to format event sender for conversation history
     * This version includes the agent's own messages for context continuity
     */
    private getEventSenderForHistory(event: NDKEvent, agentSlug: string): string | null {
        const eventAgentSlug = getAgentSlugFromEvent(event);
        
        if (isEventFromUser(event)) {
            return "🟢 USER";
        } else if (eventAgentSlug) {
            const projectCtx = getProjectContext();
            const sendingAgent = projectCtx.agents.get(eventAgentSlug);
            const agentName = sendingAgent ? sendingAgent.name : "Another agent";
            
            // Mark the agent's own previous messages clearly
            if (eventAgentSlug === agentSlug) {
                return `💬 You (${agentName})`;
            } else {
                return `💬 ${agentName}`;
            }
        } else {
            return "💬 Unknown";
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
     * Process a message to inline nostr entities
     */
    private async processNostrEntities(content: string): Promise<string> {
        const ndk = getNDK();
        let processedContent = content;
        
        // Find all nostr entities in the content
        const entities = content.match(ConversationManager.NOSTR_ENTITY_REGEX);
        if (!entities || entities.length === 0) {
            return content;
        }
        
        // Process each entity
        for (const entity of entities) {
            try {
                // fetchEvent accepts bech32 directly
                const event = await ndk.fetchEvent(entity);
                
                if (event) {
                    // Inline the event content
                    const inlinedContent = `<nostr-event entity="${entity}">${event.content}</nostr-event>`;
                    processedContent = processedContent.replace(entity, inlinedContent);
                    
                    logger.debug(`[CONV_MGR] Inlined nostr entity`, {
                        entity,
                        kind: event.kind,
                        contentLength: event.content?.length || 0
                    });
                } else {
                    logger.warn(`[CONV_MGR] Failed to fetch nostr entity`, { entity });
                }
            } catch (error) {
                logger.error(`[CONV_MGR] Error processing nostr entity`, { entity, error });
            }
        }
        
        return processedContent;
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


    /**
     * Start a new orchestrator turn (called when orchestrator uses continue())
     */
    async startOrchestratorTurn(
        conversationId: string,
        phase: Phase,
        agents: string[],
        reason?: string
    ): Promise<string> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Generate unique turn ID
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const turn: import("./types").OrchestratorTurn = {
            turnId,
            timestamp: Date.now(),
            phase,
            agents,
            completions: [],
            reason,
            isCompleted: false
        };

        conversation.orchestratorTurns.push(turn);
        await this.persistence.save(conversation);
        
        logger.info(`[CONV_MGR] Started orchestrator turn ${turnId}`, { 
            conversationId, 
            phase, 
            agents 
        });
        
        return turnId;
    }

    /**
     * Add a completion to the current orchestrator turn
     */
    async addCompletionToTurn(
        conversationId: string,
        agentSlug: string,
        message: string
    ): Promise<void> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Find the most recent incomplete turn that includes this agent
        const currentTurn = [...conversation.orchestratorTurns]
            .reverse()
            .find(turn => !turn.isCompleted && turn.agents.includes(agentSlug));

        if (!currentTurn) {
            logger.warn(`[CONV_MGR] No active turn found for agent ${agentSlug}`, { 
                conversationId 
            });
            return;
        }

        // Add completion
        currentTurn.completions.push({
            agent: agentSlug,
            message,
            timestamp: Date.now()
        });

        // Check if all expected agents have completed
        const completedAgents = new Set(currentTurn.completions.map(c => c.agent));
        if (currentTurn.agents.every(agent => completedAgents.has(agent))) {
            currentTurn.isCompleted = true;
            logger.info(`[CONV_MGR] Orchestrator turn ${currentTurn.turnId} completed`, {
                conversationId,
                completions: currentTurn.completions.length
            });
        }

        await this.persistence.save(conversation);
    }

    /**
     * Extract completion from an event (if it's a complete() tool call)
     */
    private extractCompletionFromEvent(event: NDKEvent): import("./types").Completion | null {
        // Check if event has ["tool", "complete"] tag
        const isCompletion = event.tags?.some(
            tag => tag[0] === "tool" && tag[1] === "complete"
        );
        
        if (!isCompletion || !event.content) return null;
        
        const agentSlug = getAgentSlugFromEvent(event);
        if (!agentSlug) return null;
        
        return {
            agent: agentSlug,
            message: event.content,
            timestamp: event.created_at
        };
    }
}
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
import { buildPhaseInstructions, formatPhaseTransitionMessage } from "@/prompts/utils/phaseInstructionsBuilder";
import { ExecutionQueueManager } from "./executionQueue";
import { NostrEventService } from "@/nostr/NostrEventService";
import { AgentConversationContext } from "./AgentConversationContext";
import { MessageBuilder } from "./MessageBuilder";

export class ConversationManager {
    private conversations: Map<string, Conversation> = new Map();
    private conversationContexts: Map<string, TracingContext> = new Map();
    private agentContexts: Map<string, AgentConversationContext> = new Map();
    private messageBuilder: MessageBuilder = new MessageBuilder();
    private conversationsDir: string;
    private persistence: ConversationPersistenceAdapter;
    private executionQueueManager?: ExecutionQueueManager;

    constructor(
        private projectPath: string, 
        persistence?: ConversationPersistenceAdapter,
        executionQueueManager?: ExecutionQueueManager
    ) {
        this.conversationsDir = path.join(projectPath, ".tenex", "conversations");
        this.persistence = persistence || new FileSystemAdapter(projectPath);
        this.executionQueueManager = executionQueueManager;
    }

    getProjectPath(): string {
        return this.projectPath;
    }

    getExecutionQueueManager(): ExecutionQueueManager | undefined {
        return this.executionQueueManager;
    }

    setExecutionQueueManager(manager: ExecutionQueueManager): void {
        this.executionQueueManager = manager;
        // Set up event listeners if not already done
        if (this.executionQueueManager) {
            this.setupQueueEventListeners();
        }
    }

    async initialize(): Promise<void> {
        await ensureDirectory(this.conversationsDir);
        await this.persistence.initialize();

        // Load existing conversations
        await this.loadConversations();

        // Set up execution queue event listeners if available
        if (this.executionQueueManager) {
            this.setupQueueEventListeners();
        }
    }

    private setupQueueEventListeners(): void {
        if (!this.executionQueueManager) return;

        // Listen for lock acquisition events
        this.executionQueueManager.on('lock-acquired', async (conversationId, agentPubkey) => {
            const conversation = this.conversations.get(conversationId);
            if (conversation && conversation.metadata.queueStatus) {
                // Clear queue status and notify
                delete conversation.metadata.queueStatus;
                await this.persistence.save(conversation);
                
                // Log execution start
                const tracingContext = this.conversationContexts.get(conversationId);
                if (tracingContext) {
                    const executionLogger = createExecutionLogger(tracingContext, "conversation");
                    executionLogger.logEvent({
                        type: "execution_started",
                        timestamp: new Date(),
                        conversationId,
                        agent: agentPubkey,
                        message: "Execution lock acquired - starting EXECUTE phase"
                    });
                }
            }
        });

        // Listen for timeout warnings
        this.executionQueueManager.on('timeout-warning', async (conversationId, remainingMs) => {
            const conversation = this.conversations.get(conversationId);
            if (conversation) {
                const minutes = Math.floor(remainingMs / 60000);
                const warningMessage = `⚠️ Execution Timeout Warning\n\n` +
                    `Your conversation has been executing for an extended period.\n` +
                    `Time remaining: ${minutes} minutes\n\n` +
                    `The execution will be automatically terminated if not completed soon.`;
                
                // Log warning
                const tracingContext = this.conversationContexts.get(conversationId);
                if (tracingContext) {
                    const executionLogger = createExecutionLogger(tracingContext, "conversation");
                    executionLogger.logEvent({
                        type: "timeout_warning",
                        timestamp: new Date(),
                        conversationId,
                        remainingMs,
                        message: warningMessage
                    });
                }
            }
        });

        // Listen for timeout events
        this.executionQueueManager.on('timeout', async (conversationId) => {
            const conversation = this.conversations.get(conversationId);
            if (conversation && conversation.phase === PHASES.EXECUTE) {
                // Force transition back to CHAT phase
                await this.updatePhase(
                    conversationId,
                    PHASES.CHAT,
                    "Execution timeout reached. The execution lock has been automatically released.",
                    "system",
                    "system",
                    "timeout"
                );
            }
        });
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
    ): Promise<boolean> {
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

        // Handle EXECUTE phase entry with queue management
        if (phase === PHASES.EXECUTE && previousPhase !== PHASES.EXECUTE && this.executionQueueManager) {
            const permission = await this.executionQueueManager.requestExecution(id, agentPubkey);
            
            if (!permission.granted) {
                // Add system message about queue status
                const queueMessage = `🚦 Execution Queue Status\n\n` +
                    `Your conversation has been added to the execution queue.\n\n` +
                    `Queue Position: ${permission.queuePosition}\n` +
                    `Estimated Wait Time: ${this.formatWaitTime(permission.waitTime || 0)}\n\n` +
                    `You will be automatically notified when execution begins.`;
                
                // Log queue event instead of phase transition
                executionLogger.logEvent({
                    type: "queue_joined",
                    timestamp: new Date(),
                    conversationId: id,
                    agent: agentName,
                    queuePosition: permission.queuePosition,
                    estimatedWait: permission.waitTime
                });

                // Add queue status message to conversation metadata
                if (!conversation.metadata.queueStatus) {
                    conversation.metadata.queueStatus = {
                        isQueued: true,
                        position: permission.queuePosition!,
                        estimatedWait: permission.waitTime!,
                        message: queueMessage
                    };
                }

                // Save the queue status but don't transition
                await this.persistence.save(conversation);
                
                // Return false to indicate phase transition was not completed
                return false;
            }
        }

        // Handle EXECUTE phase exit with queue management
        if (previousPhase === PHASES.EXECUTE && phase !== PHASES.EXECUTE && this.executionQueueManager) {
            await this.executionQueueManager.releaseExecution(id, reason || 'phase_transition');
            
            // Clear queue status from metadata
            if (conversation.metadata.queueStatus) {
                delete conversation.metadata.queueStatus;
            }
        }
        
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
        
        // Return true to indicate phase transition was completed
        return true;
    }

    private formatWaitTime(seconds: number): string {
        if (seconds < 60) {
            return `~${Math.floor(seconds)} seconds`;
        } else if (seconds < 3600) {
            return `~${Math.floor(seconds / 60)} minutes`;
        } else {
            return `~${Math.floor(seconds / 3600)} hours`;
        }
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
     * Get or create context for agent<>conversation pair
     */
    private getAgentContext(conversationId: string, agentSlug: string): AgentConversationContext {
        const key = `${conversationId}:${agentSlug}`;
        let context = this.agentContexts.get(key);
        
        if (!context) {
            logger.debug(`[CONV_MGR] Creating new context for key: ${key}`);
            context = new AgentConversationContext(conversationId, agentSlug, this.messageBuilder);
            this.agentContexts.set(key, context);
        } else {
            logger.debug(`[CONV_MGR] Reusing existing context for key: ${key}`, {
                existingMessages: context.getMessages().length
            });
        }
        
        return context;
    }

    /**
     * Build messages for an agent using simplified conversation context.
     * This is the SINGLE method for building agent context.
     */
    async buildAgentMessages(
        conversationId: string,
        targetAgent: AgentInstance,
        triggeringEvent?: NDKEvent,
        handoff?: PhaseTransition
    ): Promise<{ messages: Message[]; claudeSessionId?: string }> {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        // Get or create the agent context
        const context = this.getAgentContext(conversationId, targetAgent.slug);
        
        // Get or initialize the agent's state (for backwards compatibility and delegation tracking)
        let agentState = conversation.agentStates.get(targetAgent.slug);
        if (!agentState) {
            agentState = { 
                lastProcessedMessageIndex: 0,
                lastSeenPhase: undefined
            };
            conversation.agentStates.set(targetAgent.slug, agentState);
            logger.info(`[CONV_MGR] Initialized new agent state for ${targetAgent.slug}`);
        }

        // Check if we need to show phase instructions
        const projectCtx = getProjectContext();
        const agentInstance = projectCtx.agents.get(targetAgent.slug);
        const isOrchestrator = agentInstance?.isOrchestrator || false;
        
        // Sync the context's current phase with what we know the agent has seen
        // If the agent already has a lastSeenPhase, they've already been shown phase instructions
        const agentHasSeenPhase = agentState.lastSeenPhase !== undefined;
        if (agentHasSeenPhase) {
            context.setCurrentPhase(agentState.lastSeenPhase);
        }
        
        // Only show phase instructions if:
        // 1. Not an orchestrator AND
        // 2. Agent hasn't seen this phase before OR phase has changed
        const needsPhaseInstructions = !isOrchestrator && 
            (!agentHasSeenPhase || context.getCurrentPhase() !== conversation.phase);
        
        // Clear messages and rebuild fresh each time
        // The context tracks state but we rebuild messages for each call
        context.clearMessages();
        
        // Build complete history fresh
        const historyToProcess: NDKEvent[] = [];
        for (const event of conversation.history) {
            if (triggeringEvent?.id && event.id === triggeringEvent.id) {
                break; // Stop before the triggering event
            }
            historyToProcess.push(event);
        }
        
        // Add all historical events
        if (historyToProcess.length > 0) {
            await context.addEvents(historyToProcess);
        }

        // Handle phase transitions AFTER building history but BEFORE triggering event
        if (needsPhaseInstructions) {
            const phaseInstructions = buildPhaseInstructions(
                conversation.phase,
                conversation,
                false // not orchestrator
            );
            
            let phaseMessage: string;
            if (agentState.lastSeenPhase) {
                phaseMessage = formatPhaseTransitionMessage(
                    agentState.lastSeenPhase,
                    conversation.phase,
                    phaseInstructions
                );
            } else {
                phaseMessage = `=== CURRENT PHASE: ${conversation.phase.toUpperCase()} ===\n\n${phaseInstructions}`;
            }
            
            context.handlePhaseTransition(conversation.phase, phaseMessage);
            agentState.lastSeenPhase = conversation.phase;
        }

        // Handle delegation responses if pending
        if (agentState.pendingDelegation && triggeringEvent) {
            const senderPubkey = triggeringEvent.pubkey;
            
            if (agentState.pendingDelegation.expectedFrom.includes(senderPubkey)) {
                // Initialize Map if needed (in case loaded from persistence)
                if (!agentState.pendingDelegation.receivedResponses) {
                    agentState.pendingDelegation.receivedResponses = new Map();
                    if (agentState.pendingDelegation.receivedFrom) {
                        for (const pubkey of agentState.pendingDelegation.receivedFrom) {
                            agentState.pendingDelegation.receivedResponses.set(pubkey, {} as NDKEvent);
                        }
                    }
                }
                
                // Store this response
                agentState.pendingDelegation.receivedResponses.set(senderPubkey, triggeringEvent);
                agentState.pendingDelegation.receivedFrom = Array.from(agentState.pendingDelegation.receivedResponses.keys());
                
                logger.info(`[CONV_MGR] Agent ${targetAgent.slug} received delegation response`, {
                    from: senderPubkey,
                    received: agentState.pendingDelegation.receivedResponses.size,
                    expected: agentState.pendingDelegation.expectedFrom.length,
                });
                
                // Have we received all responses?
                if (agentState.pendingDelegation.receivedResponses.size < 
                    agentState.pendingDelegation.expectedFrom.length) {
                    // Still waiting for more responses
                    context.addMessage(new Message("system", 
                        `Waiting for delegate responses: ${agentState.pendingDelegation.receivedResponses.size}/${agentState.pendingDelegation.expectedFrom.length} received.`
                    ));
                    
                    await this.persistence.save(conversation);
                    
                    return {
                        messages: context.getMessages(),
                        claudeSessionId: context.getClaudeSessionId() || agentState.claudeSessionId
                    };
                }
                
                // We have all responses! Add them to context
                context.addDelegationResponses(
                    agentState.pendingDelegation.receivedResponses,
                    agentState.pendingDelegation.originalRequest
                );
                
                // Clear the pending delegation state
                agentState.pendingDelegation = undefined;
                
                // Update state and save
                context.setLastProcessedIndex(conversation.history.length);
                agentState.lastProcessedMessageIndex = conversation.history.length;
                await this.persistence.save(conversation);
                
                return {
                    messages: context.getMessages(),
                    claudeSessionId: context.getClaudeSessionId() || agentState.claudeSessionId
                };
            }
        }
        
        // Add handoff if present
        if (handoff) {
            context.addHandoff(handoff);
        }
        
        // Add the triggering event
        if (triggeringEvent) {
            await context.addTriggeringEvent(triggeringEvent);
        }
        
        // Update state
        context.setLastProcessedIndex(conversation.history.length);
        agentState.lastProcessedMessageIndex = conversation.history.length;
        
        // Sync Claude session ID
        if (context.getClaudeSessionId()) {
            agentState.claudeSessionId = context.getClaudeSessionId();
        }
        
        // Save the updated conversation state
        await this.persistence.save(conversation);
        
        return { 
            messages: context.getMessages(), 
            claudeSessionId: context.getClaudeSessionId() || agentState.claudeSessionId
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
            agentState = { 
                lastProcessedMessageIndex: 0,
                lastSeenPhase: undefined
            };
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
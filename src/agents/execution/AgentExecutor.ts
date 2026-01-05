import type { AgentInstance } from "@/agents/types";
import {
    supervisorOrchestrator,
    registerDefaultHeuristics,
    updateKnownAgentSlugs,
    type PostCompletionContext,
} from "@/agents/supervision";
import { ConversationStore } from "@/conversations/ConversationStore";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { formatAnyError, formatStreamError } from "@/lib/error-formatter";
import type {
    ChunkTypeChangeEvent,
    CompleteEvent,
    ContentEvent,
    ReasoningEvent,
    SessionCapturedEvent,
    StreamErrorEvent,
    ToolDidExecuteEvent,
    ToolWillExecuteEvent,
} from "@/llm/service";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { agentTodosFragment } from "@/prompts/fragments/06-agent-todos";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { getProjectContext } from "@/services/projects";
import { RALRegistry, isStopExecutionSignal } from "@/services/ral";
import { clearLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import { getToolsObject } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type {
    Tool as CoreTool,
    ModelMessage,
    ToolCallPart,
    ToolResultPart,
    ToolSet,
    TypedToolCall,
    TypedToolResult,
} from "ai";
import chalk from "chalk";
import { MessageSyncer } from "./MessageSyncer";
import { SessionManager } from "./SessionManager";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { ExecutionContext, StandaloneAgentContext, StreamExecutionResult } from "./types";

const tracer = trace.getTracer("tenex.agent-executor");

export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, CoreTool>;
}

export class AgentExecutor {
    constructor(private standaloneContext?: StandaloneAgentContext) {
        // Initialize supervision heuristics
        registerDefaultHeuristics();
    }

    /**
     * Prepare an LLM request without executing it.
     */
    async prepareLLMRequest(
        agent: AgentInstance,
        initialPrompt: string,
        originalEvent: NDKEvent,
        conversationHistory: ModelMessage[] = [],
        projectPath?: string
    ): Promise<LLMCompletionRequest> {
        const context: Partial<ExecutionContext> = {
            agent,
            triggeringEvent: originalEvent,
            conversationId: originalEvent.id,
            projectBasePath: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            workingDirectory: projectPath || this.standaloneContext?.project?.tagValue("d") || "",
            currentBranch: "main",
        };

        let messages: ModelMessage[] = [];

        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            messages = [
                {
                    role: "user",
                    content: initialPrompt,
                },
            ];
        }

        const toolNames = agent.tools || [];
        const tools =
            toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

        return { messages, tools };
    }

    /**
     * Execute an agent's assignment for a conversation with streaming
     */
    async execute(context: ExecutionContext): Promise<NDKEvent | undefined> {
        const span = tracer.startSpan("tenex.agent.execute", {
            attributes: {
                "agent.slug": context.agent.slug,
                "agent.pubkey": context.agent.pubkey,
                "agent.role": context.agent.role || "worker",
                "conversation.id": context.conversationId,
                "triggering_event.id": context.triggeringEvent.id,
                "triggering_event.kind": context.triggeringEvent.kind || 0,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const ralRegistry = RALRegistry.getInstance();

                // Check for a resumable RAL (one with completed delegations ready to continue)
                const resumableRal = ralRegistry.findResumableRAL(
                    context.agent.pubkey,
                    context.conversationId
                );

                // Also check for RAL with queued injections (e.g., pairing checkpoint)
                const injectionRal = !resumableRal
                    ? ralRegistry.findRALWithInjections(
                          context.agent.pubkey,
                          context.conversationId
                      )
                    : undefined;

                let ralNumber: number;
                let isResumption = false;

                if (resumableRal) {
                    // Resume existing RAL instead of creating a new one
                    ralNumber = resumableRal.ralNumber;
                    isResumption = true;

                    // Get delegations from conversation storage
                    const completedDelegations = ralRegistry.getConversationCompletedDelegations(
                        context.agent.pubkey, context.conversationId, resumableRal.ralNumber
                    );
                    const pendingDelegations = ralRegistry.getConversationPendingDelegations(
                        context.agent.pubkey, context.conversationId, resumableRal.ralNumber
                    );

                    // Inject delegation results into the RAL as user message
                    // Include pending delegations so agent knows what's still outstanding
                    const resultsMessage = await ralRegistry.buildDelegationResultsMessage(
                        completedDelegations,
                        pendingDelegations
                    );
                    if (resultsMessage) {
                        ralRegistry.queueUserMessage(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            resultsMessage
                        );
                    }

                    // Don't clear completedDelegations here - they'll be cleared when the RAL ends.
                    // This allows subsequent executions to see all completions, not just new ones.

                    span.addEvent("executor.ral_resumed", {
                        "ral.number": ralNumber,
                        "delegation.completed_count": completedDelegations.length,
                        "delegation.pending_count": pendingDelegations.length,
                    });
                } else if (injectionRal) {
                    // Resume RAL with queued injections (pairing checkpoint)
                    ralNumber = injectionRal.ralNumber;
                    isResumption = true;

                    const injectionRalPending = ralRegistry.getConversationPendingDelegations(
                        context.agent.pubkey, context.conversationId, injectionRal.ralNumber
                    );
                    span.addEvent("executor.ral_resumed_for_injection", {
                        "ral.number": ralNumber,
                        "injection.count": injectionRal.queuedInjections.length,
                        pending_delegations: injectionRalPending.length,
                    });
                } else {
                    // Create a new RAL for this execution
                    // Pass trace context so stop events can be correlated
                    const spanContext = span.spanContext();
                    ralNumber = ralRegistry.create(
                        context.agent.pubkey,
                        context.conversationId,
                        context.triggeringEvent.id,
                        { traceId: spanContext.traceId, spanId: spanContext.spanId }
                    );
                }

                span.setAttributes({
                    "ral.number": ralNumber,
                    "ral.is_resumption": isResumption,
                });

                // Store ralNumber in context for use throughout execution
                const contextWithRal = {
                    ...context,
                    ralNumber,
                };

                // Prepare execution context with all necessary components
                const { fullContext, toolTracker, agentPublisher, cleanup } =
                    this.prepareExecution(contextWithRal);

                // Add execution context to span
                const conversation = fullContext.getConversation();
                if (conversation) {
                    span.setAttributes({
                        "conversation.phase": conversation.phase,
                        "conversation.message_count": conversation.getMessageCount(),
                    });
                }

                // Display execution start in console
                span.addEvent("executor.started", {
                    ral_number: ralNumber,
                    is_resumption: isResumption,
                    has_phases: !!context.agent.phases,
                });

                try {
                    const result = await this.executeOnce(
                        fullContext,
                        toolTracker,
                        agentPublisher,
                        ralNumber
                    );

                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                } finally {
                    await cleanup();
                }
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });

                const errorMessage = formatAnyError(error);
                const isCreditsError =
                    errorMessage.includes("Insufficient credits") || errorMessage.includes("402");

                const displayMessage = isCreditsError
                    ? "⚠️ Unable to process your request: Insufficient credits. Please add more credits at https://openrouter.ai/settings/credits to continue."
                    : `⚠️ Unable to process your request due to an error: ${errorMessage}`;

                // Publish error to user
                const conversation = context.getConversation();
                if (conversation) {
                    const agentPublisher = new AgentPublisher(context.agent);
                    try {
                        await agentPublisher.error(
                            {
                                message: displayMessage,
                                errorType: isCreditsError
                                    ? "insufficient_credits"
                                    : "execution_error",
                            },
                            {
                                triggeringEvent: context.triggeringEvent,
                                rootEvent: { id: conversation.getRootEventId() },
                                conversationId: conversation.id,
                                ralNumber: 0, // Error during execution - no active RAL
                            }
                        );
                    } catch (publishError) {
                        logger.error("Failed to publish execution error event", {
                            error: formatAnyError(publishError),
                        });
                    }
                }

                logger.error(
                    isCreditsError
                        ? "[AgentExecutor] Execution failed due to insufficient credits"
                        : "[AgentExecutor] Execution failed",
                    {
                        agent: context.agent.slug,
                        error: errorMessage,
                        conversationId: context.conversationId,
                    }
                );

                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Prepare execution context with all necessary components
     */
    private prepareExecution(
        context: ExecutionContext & { ralNumber: number }
    ): {
        fullContext: ExecutionContext & { ralNumber: number };
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        const toolTracker = new ToolExecutionTracker();
        const agentPublisher = new AgentPublisher(context.agent);

        // Get ConversationStore for this conversation (required)
        // Uses static registry to ensure we get the cached store with all messages
        const conversationStore = ConversationStore.getOrLoad(context.conversationId);
        const projectContext = getProjectContext();

        // Check for active pairings for this agent
        const hasActivePairings = projectContext.pairingManager
            ? projectContext.pairingManager.getActivePairingsForSupervisor(context.agent.pubkey)
                  .length > 0
            : false;

        const fullContext = {
            ...context,
            agentPublisher,
            conversationStore,
            hasActivePairings,
        };

        const conversation = fullContext.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        startExecutionTime(conversation);

        const cleanup = async (): Promise<void> => {
            if (conversation) stopExecutionTime(conversation);
            toolTracker.clear();
        };

        return { fullContext, toolTracker, agentPublisher, cleanup };
    }

    /**
     * Execute streaming and publish result
     */
    private async executeOnce(
        context: ExecutionContext & { ralNumber: number },
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher,
        ralNumber: number
    ): Promise<NDKEvent | undefined> {
        let result: StreamExecutionResult;

        try {
            result = await this.executeStreaming(context, toolTracker, ralNumber);
        } catch (streamError) {
            logger.error("[AgentExecutor] Streaming failed", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            throw streamError;
        }

        // Error already handled - error event was published as finalization
        if (result.kind === "error-handled") {
            return undefined;
        }

        // Execution was aborted by stop signal - publish stopped message, skip supervision
        if (result.aborted) {
            const agentPublisher = context.agentPublisher;
            if (!agentPublisher) {
                throw new Error("AgentPublisher not found in execution context");
            }
            const eventContext = createEventContext(context);
            const responseEvent = await agentPublisher.complete(
                { content: "Manually stopped by user" },
                eventContext
            );

            // Add event to conversation history
            await ConversationStore.addEvent(context.conversationId, responseEvent);

            return responseEvent;
        }

        const completionEvent = result.event;

        // Determine if we should wait for more delegations
        // Use context.hasPendingDelegations (captured at completion time) for delegation completions
        // This avoids race conditions where pendingDelegations array is modified by concurrent completions
        const ralRegistry = RALRegistry.getInstance();

        // Get pending delegations from conversation storage
        const currentPendingDelegations = ralRegistry.getConversationPendingDelegations(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        // For non-delegation-completion executions, check current pending count
        // For delegation completions, use the flag captured at completion time
        const hasPendingDelegations = context.isDelegationCompletion
            ? context.hasPendingDelegations
            : currentPendingDelegations.length > 0;

        // If agent generated no meaningful response and we're waiting for delegations, don't publish anything
        // This handles the case where the agent only called delegate() without outputting any text
        const hasMessageContent = completionEvent?.message && completionEvent.message.length > 0;
        if (!hasMessageContent && hasPendingDelegations) {
            trace.getActiveSpan()?.addEvent("executor.awaiting_delegations", {
                "ral.number": ralNumber,
                "delegation.pending_count": currentPendingDelegations.length,
            });

            return undefined;
        }

        if (!completionEvent) {
            throw new Error("LLM execution completed without producing a completion event");
        }

        // === POST-COMPLETION SUPERVISION CHECK ===
        // Run heuristics to detect suspicious agent behavior before publishing
        const executionId = `${context.agent.pubkey}:${context.conversationId}:${ralNumber}`;

        logger.info("[AgentExecutor] Running supervision check", {
            agent: context.agent.slug,
            ralNumber,
        });

        // Check if we've exceeded max retries for supervision
        if (supervisorOrchestrator.hasExceededMaxRetries(executionId)) {
            logger.warn("[AgentExecutor] Supervision max retries exceeded, publishing anyway", {
                agent: context.agent.slug,
                ralNumber,
            });
            supervisorOrchestrator.clearState(executionId);
        } else {
            // Build supervision context
            const conversationStore = context.conversationStore;
            const projectContext = getProjectContext();

            // Get tool calls from conversation store
            const storeMessages = conversationStore?.getAllMessages() || [];
            const toolCallsMade = storeMessages
                .filter(m => m.ral === ralNumber && m.messageType === "tool-call" && m.toolData)
                .flatMap(m => m.toolData?.map(td => {
                    if (td.type === "tool-call" && "toolName" in td) {
                        return td.toolName;
                    }
                    return undefined;
                }).filter(Boolean) as string[] || []);

            // Build the system prompt for context
            const conversation = context.getConversation();
            const systemPromptMessages = conversation ? await buildSystemPromptMessages({
                agent: context.agent,
                project: projectContext.project,
                conversation,
                projectBasePath: context.projectBasePath,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
                availableAgents: Array.from(projectContext.agents.values()),
                mcpManager: projectContext.mcpManager,
            }) : [];
            const systemPrompt = systemPromptMessages.map(m => m.message.content).join("\n\n");

            // Update known agent slugs for delegation heuristic
            updateKnownAgentSlugs(Array.from(projectContext.agents.values()).map(a => a.slug));

            // Build conversation history
            const conversationMessages = conversationStore
                ? await conversationStore.buildMessagesForRal(context.agent.pubkey, ralNumber)
                : [];

            const toolNames = context.agent.tools || [];
            const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

            const supervisionContext: PostCompletionContext = {
                agentSlug: context.agent.slug,
                agentPubkey: context.agent.pubkey,
                hasPhases: !!context.agent.phases,
                messageContent: completionEvent.message || "",
                toolCallsMade,
                systemPrompt,
                conversationHistory: conversationMessages,
                availableTools: toolsObject,
            };

            const supervisionResult = await supervisorOrchestrator.checkPostCompletion(supervisionContext);

            if (supervisionResult.hasViolation && supervisionResult.correctionAction) {
                trace.getActiveSpan()?.addEvent("executor.supervision_violation", {
                    "ral.number": ralNumber,
                    "heuristic.id": supervisionResult.heuristicId || "unknown",
                    "action.type": supervisionResult.correctionAction.type,
                });

                logger.info("[AgentExecutor] Supervision detected violation", {
                    agent: context.agent.slug,
                    heuristic: supervisionResult.heuristicId,
                    actionType: supervisionResult.correctionAction.type,
                });

                if (supervisionResult.correctionAction.type === "suppress-publish" &&
                    supervisionResult.correctionAction.reEngage) {
                    // Increment retry count
                    supervisorOrchestrator.incrementRetryCount(executionId);

                    // Inject correction message as user message
                    if (supervisionResult.correctionAction.message) {
                        ralRegistry.queueUserMessage(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            supervisionResult.correctionAction.message
                        );
                    }

                    // Re-execute the agent
                    return this.executeOnce(context, toolTracker, agentPublisher, ralNumber);
                }
            } else {
                logger.info("[AgentExecutor] Supervision check passed", {
                    agent: context.agent.slug,
                    ralNumber,
                });
            }
        }
        // === END SUPERVISION CHECK ===

        const eventContext = createEventContext(context, completionEvent?.usage?.model);

        trace.getActiveSpan()?.addEvent("executor.publish", {
            "message.length": completionEvent?.message?.length || 0,
            has_pending_delegations: hasPendingDelegations,
        });

        let responseEvent: NDKEvent;

        if (hasPendingDelegations) {
            // Mid-loop response - use conversation() (kind:1, no p-tag)
            responseEvent = await agentPublisher.conversation(
                { content: completionEvent.message },
                eventContext
            );
        } else {
            // Final completion - use complete() (kind:1, with p-tag)
            responseEvent = await agentPublisher.complete(
                { content: completionEvent.message, usage: completionEvent.usage },
                eventContext
            );
        }

        // Add event to conversation history immediately
        await ConversationStore.addEvent(context.conversationId, responseEvent);

        trace.getActiveSpan()?.addEvent("executor.published", {
            "event.id": responseEvent.id || "",
            is_completion: !hasPendingDelegations,
        });

        return responseEvent;
    }

    /**
     * Execute streaming and return the result.
     * Uses discriminated union: 'complete' for success, 'error-handled' when error already published.
     */
    private async executeStreaming(
        context: ExecutionContext & { ralNumber: number },
        toolTracker: ToolExecutionTracker,
        ralNumber: number
    ): Promise<StreamExecutionResult> {
        const toolNames = context.agent.tools || [];
        const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        // Store reference to active tools in context for dynamic tool injection
        // This allows create_dynamic_tool to add new tools mid-stream
        context.activeToolsObject = toolsObject;

        const sessionManager = new SessionManager(context.agent, context.conversationId);
        const { sessionId } = sessionManager.getSession();

        const ralRegistry = RALRegistry.getInstance();
        const conversationStore = context.conversationStore;
        if (!conversationStore) {
            throw new Error(
                "ConversationStore not available - execution requires ConversationStore"
            );
        }

        // Register RAL in ConversationStore
        conversationStore.ensureRalActive(context.agent.pubkey, ralNumber);

        // Build conversation messages from ConversationStore (single source of truth)
        const conversationMessages = await conversationStore.buildMessagesForRal(
            context.agent.pubkey,
            ralNumber
        );

        // Build system prompt with agent identity, context, and instructions
        const projectContext = getProjectContext();
        const conversation = context.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        const systemPromptMessages = await buildSystemPromptMessages({
            agent: context.agent,
            project: projectContext.project,
            conversation,
            projectBasePath: context.projectBasePath,
            workingDirectory: context.workingDirectory,
            currentBranch: context.currentBranch,
            availableAgents: Array.from(projectContext.agents.values()),
            mcpManager: projectContext.mcpManager,
        });

        // Combine system prompt with conversation messages
        const messages: ModelMessage[] = [
            ...systemPromptMessages.map((sm) => sm.message),
            ...conversationMessages,
        ];

        // Append todo list as a late system message (after conversation history)
        // This ensures the agent sees its current todos near the end of the context
        const todoContent = await agentTodosFragment.template({
            conversation,
            agentPubkey: context.agent.pubkey,
        });
        if (todoContent) {
            messages.push({
                role: "system",
                content: todoContent,
            });
        }

        trace.getActiveSpan()?.addEvent("executor.messages_built_from_store", {
            "ral.number": ralNumber,
            "message.count": messages.length,
            "system_prompt.count": systemPromptMessages.length,
            "conversation.count": conversationMessages.length,
        });

        const abortSignal = llmOpsRegistry.registerOperation(context);

        const llmService = context.agent.createLLMService({ tools: toolsObject, sessionId });

        const agentPublisher = context.agentPublisher;
        if (!agentPublisher) {
            throw new Error("AgentPublisher not found in execution context");
        }
        const eventContext = createEventContext(context, llmService.model);

        let contentBuffer = "";
        let reasoningBuffer = "";
        let result: StreamExecutionResult | undefined;

        const flushReasoningBuffer = async (): Promise<void> => {
            if (reasoningBuffer.trim().length > 0) {
                await agentPublisher.conversation(
                    { content: reasoningBuffer, isReasoning: true },
                    eventContext
                );
                reasoningBuffer = "";
            }
        };

        llmService.on("content", (event: ContentEvent) => {
            process.stdout.write(chalk.white(event.delta));
            contentBuffer += event.delta;
        });

        llmService.on("reasoning", (event: ReasoningEvent) => {
            process.stdout.write(chalk.gray(event.delta));
            reasoningBuffer += event.delta;
        });

        llmService.on("chunk-type-change", async (event: ChunkTypeChangeEvent) => {
            // Flush reasoning buffer when switching away from reasoning
            if (event.from === "reasoning-delta") {
                await flushReasoningBuffer();
            }
            // Content buffer is NOT flushed here - completion event handles final publish
            // to avoid duplicate messages (content would be published both here and at completion)
        });

        llmService.on("complete", (event: CompleteEvent) => {
            // Only set result if no error already occurred
            if (!result) {
                result = { kind: "complete", event };
            }
        });

        llmService.on("stream-error", async (event: StreamErrorEvent) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);
            // Set result FIRST to prevent complete handler from overwriting
            result = { kind: "error-handled" };

            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    error: formatAnyError(publishError),
                });
            }
        });

        llmService.on(
            "session-captured",
            ({ sessionId: capturedSessionId }: SessionCapturedEvent) => {
                sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
            }
        );

        llmService.on("tool-will-execute", async (event: ToolWillExecuteEvent) => {
            const argsStr = event.args !== undefined ? JSON.stringify(event.args) : "";
            const argsPreview = argsStr.substring(0, 50);
            console.log(
                chalk.yellow(
                    `\n🔧 ${event.toolName}(${argsPreview}${argsStr.length > 50 ? "..." : ""})`
                )
            );

            // Add tool-call message to ConversationStore for persistence
            conversationStore.addMessage({
                pubkey: context.agent.pubkey,
                ral: ralNumber,
                content: "",
                messageType: "tool-call",
                toolData: [
                    {
                        type: "tool-call",
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        input: event.args ?? {},
                    },
                ] as ToolCallPart[],
            });

            const toolEvent = await toolTracker.trackExecution({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                toolsObject,
                agentPublisher,
                eventContext,
            });

            // Add tool event to conversation history so it's visible in future turns
            // (delegation tools return null - they publish on completion with delegation event IDs)
            if (toolEvent) {
                await ConversationStore.addEvent(context.conversationId, toolEvent);
            }
        });

        llmService.on("tool-did-execute", async (event: ToolDidExecuteEvent) => {
            // Add tool-result message to ConversationStore for persistence
            conversationStore.addMessage({
                pubkey: context.agent.pubkey,
                ral: ralNumber,
                content: "",
                messageType: "tool-result",
                toolData: [
                    {
                        type: "tool-result" as const,
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        output:
                            event.result !== undefined
                                ? { type: "json" as const, value: event.result }
                                : { type: "text" as const, value: "" },
                    },
                ] as ToolResultPart[],
            });

            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey,
            });
        });

        const executionSpan = trace.getActiveSpan();

        // Track accumulated messages from prepareStep - this is updated before each step
        // and includes all messages up to (but not including) the current step
        let latestAccumulatedMessages: ModelMessage[] = messages;

        try {
            // Mark this RAL as streaming
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, true);

            // prepareStep: async, rebuilds messages from ConversationStore on every step
            // This ensures injections and tool results are always included
            const prepareStep = async (step: {
                messages: ModelMessage[];
                stepNumber: number;
                steps: Array<{
                    toolCalls: Array<{ toolName: string }>;
                    text: string;
                    reasoningText?: string;
                }>;
            }): Promise<{ messages?: ModelMessage[] } | undefined> => {
                console.log("RUNNING prepareStep for step", step.stepNumber, step.steps[step.stepNumber]);
                // Update accumulated messages tracker
                latestAccumulatedMessages = step.messages;

                // Sync any tool calls/results from AI SDK to ConversationStore
                // This ensures we never lose data (e.g., tool errors that didn't emit events)
                const syncer = new MessageSyncer(
                    conversationStore,
                    context.agent.pubkey,
                    ralNumber
                );
                syncer.syncFromSDK(step.messages);

                // Process any new injections - persist them to ConversationStore
                const newInjections = ralRegistry.getAndConsumeInjections(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (newInjections.length > 0) {
                    // Persist injections to ConversationStore as user messages
                    for (const injection of newInjections) {
                        conversationStore.addMessage({
                            pubkey: context.triggeringEvent.pubkey,
                            ral: ralNumber,
                            content: injection.content,
                            messageType: "text",
                            targetedPubkeys: [context.agent.pubkey],
                        });
                    }

                    if (executionSpan) {
                        executionSpan.addEvent("ral_injection.process", {
                            "injection.message_count": newInjections.length,
                            "ral.number": ralNumber,
                        });
                    }
                }

                // Always rebuild messages from ConversationStore - the single source of truth
                // This ensures injections, tool results, and any other updates are included
                const conversationMessages = await conversationStore.buildMessagesForRal(
                    context.agent.pubkey,
                    ralNumber
                );

                // Combine system prompt with fresh conversation messages
                const rebuiltMessages: ModelMessage[] = [
                    ...systemPromptMessages.map((sm) => sm.message),
                    ...conversationMessages,
                ];

                // Re-add todo list (tools may have modified it)
                const todoContent = await agentTodosFragment.template({
                    conversation,
                    agentPubkey: context.agent.pubkey,
                });
                if (todoContent) {
                    rebuiltMessages.push({
                        role: "system",
                        content: todoContent,
                    });
                }

                return { messages: rebuiltMessages };
            };

            const onStopCheck = async (steps: any[]): Promise<boolean> => {
                if (steps.length === 0) return false;

                const lastStep = steps[steps.length - 1];
                const toolResults = lastStep.toolResults ?? [];

                for (const toolResult of toolResults) {
                    if (isStopExecutionSignal(toolResult.output)) {
                        const pendingDelegations = toolResult.output.pendingDelegations;

                        executionSpan?.addEvent("executor.delegation_stop", {
                            "ral.number": ralNumber,
                            "delegation.count": pendingDelegations.length,
                        });

                        // Build complete messages including the current step's tool calls and results.
                        // latestAccumulatedMessages has messages up to but not including this step.
                        // We need to add the assistant's tool calls and the tool results.
                        const toolCalls = lastStep.toolCalls ?? [];
                        const messagesWithToolCalls: ModelMessage[] = [
                            ...latestAccumulatedMessages,
                        ];

                        // Add assistant message with tool calls (if any)
                        if (toolCalls.length > 0) {
                            messagesWithToolCalls.push({
                                role: "assistant",
                                content: toolCalls.map((tc: TypedToolCall<ToolSet>) => ({
                                    type: "tool-call" as const,
                                    toolCallId: tc.toolCallId,
                                    toolName: tc.toolName,
                                    // AI SDK TypedToolCall and ModelMessage both use 'input'
                                    input: tc.input !== undefined ? tc.input : {},
                                })),
                            });
                        }

                        // Add tool results
                        if (toolResults.length > 0) {
                            messagesWithToolCalls.push({
                                role: "tool",
                                content: toolResults.map((tr: TypedToolResult<ToolSet>) => ({
                                    type: "tool-result" as const,
                                    toolCallId: tr.toolCallId,
                                    toolName: tr.toolName,
                                    // Wrap output in LanguageModelV2ToolResultOutput format
                                    // The AI SDK expects { type: 'json', value: ... } for object outputs
                                    output:
                                        tr.output !== undefined
                                            ? { type: "json" as const, value: tr.output }
                                            : { type: "text" as const, value: "" },
                                })),
                            });
                        }

                        // Merge pending delegations instead of replacing them
                        const existingDelegations = ralRegistry.getConversationPendingDelegations(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber
                        );

                        // Merge and deduplicate by delegationConversationId
                        const mergedDelegations = [...existingDelegations];
                        for (const newDelegation of pendingDelegations) {
                            if (
                                !mergedDelegations.some(
                                    (d) =>
                                        d.delegationConversationId ===
                                        newDelegation.delegationConversationId
                                )
                            ) {
                                mergedDelegations.push(newDelegation);
                            }
                        }

                        ralRegistry.setPendingDelegations(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            mergedDelegations
                        );

                        // Tool calls and results are already added to ConversationStore
                        // via tool-will-execute and tool-did-execute handlers.
                        // Just save the store state (don't complete RAL - pending delegations).
                        conversationStore.save();

                        return true;
                    }
                }

                return false;
            };

            await llmService.stream(messages, toolsObject, {
                abortSignal,
                prepareStep,
                onStopCheck,
            });
        } catch (streamError) {
            // Check if this was an abort from a stop signal (kind 24134)
            if (abortSignal.aborted) {
                executionSpan?.addEvent("executor.aborted_by_stop_signal", {
                    "ral.number": ralNumber,
                    "agent.slug": context.agent.slug,
                    "conversation.id": context.conversationId,
                });
                logger.info(`[AgentExecutor] Execution aborted by stop signal`, {
                    agent: context.agent.slug,
                    ralNumber,
                    conversationId: context.conversationId.substring(0, 8),
                });
                throw streamError;
            }

            // Only publish error if not already handled by stream-error event
            if (result?.kind !== "error-handled") {
                result = { kind: "error-handled" };
                try {
                    const { message: errorMessage, errorType } = formatStreamError(streamError);
                    await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
                } catch (publishError) {
                    logger.error("Failed to publish stream error event", {
                        error: formatAnyError(publishError),
                    });
                }
            }
            throw streamError;
        } finally {
            // Mark as no longer streaming
            ralRegistry.setStreaming(
                context.agent.pubkey,
                context.conversationId,
                ralNumber,
                false
            );

            llmOpsRegistry.completeOperation(context);
            llmService.removeAllListeners();

            // Clear LLM span ID to prevent memory leaks
            const currentSpan = trace.getActiveSpan();
            if (currentSpan) {
                clearLLMSpanId(currentSpan.spanContext().traceId);
            }
        }

        // Flush any remaining reasoning buffer
        if (reasoningBuffer.trim().length > 0) {
            await flushReasoningBuffer();
        }

        if (!sessionId && llmService.provider === "claude-code" && result?.kind === "complete") {
            sessionManager.saveLastSentEventId(context.triggeringEvent.id);
        }

        // Clear RAL if execution completed without pending delegations
        // We clear for any terminal finish reason (not just "stop"/"end" - Gemini returns "other")
        const finalPendingDelegations = ralRegistry.getConversationPendingDelegations(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        if (finalPendingDelegations.length === 0) {
            ralRegistry.clearRAL(context.agent.pubkey, context.conversationId, ralNumber);

            // Complete RAL in ConversationStore and persist
            conversationStore.completeRal(context.agent.pubkey, ralNumber);
            await conversationStore.save();
        }

        if (!result) {
            throw new Error("LLM stream completed without emitting complete or stream-error event");
        }

        // Set aborted flag if stop signal was triggered
        if (result.kind === "complete") {
            result.aborted = abortSignal.aborted;
        }

        return result;
    }
}

import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { ConversationStore } from "@/conversations/ConversationStore";
import type {
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
import { isProjectContextInitialized, getProjectContext } from "@/services/projects";
import { homedir } from "os";
import { join } from "path";
import { RALRegistry, isStopExecutionSignal } from "@/services/ral";
import type { RALSummary } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import { formatAnyError, formatStreamError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Tool as CoreTool, ModelMessage, TypedToolCall, TypedToolResult, ToolSet } from "ai";
import chalk from "chalk";
import { SessionManager } from "./SessionManager";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { ExecutionContext, StandaloneAgentContext } from "./types";
import { shouldReleasePausedRALs } from "./ConcurrentRALCoordinator";

const tracer = trace.getTracer("tenex.agent-executor");

export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, CoreTool>;
}

export class AgentExecutor {
    constructor(
        private standaloneContext?: StandaloneAgentContext
    ) {}

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
        const tools = toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

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
        });

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
                    ? ralRegistry.findRALWithInjections(context.agent.pubkey, context.conversationId)
                    : undefined;

                let ralNumber: number;
                let isResumption = false;

                if (resumableRal) {
                    // Resume existing RAL instead of creating a new one
                    ralNumber = resumableRal.ralNumber;
                    isResumption = true;

                    // Inject delegation results into the RAL as user message
                    // Include pending delegations so agent knows what's still outstanding
                    const resultsMessage = ralRegistry.buildDelegationResultsMessage(
                        resumableRal.completedDelegations,
                        resumableRal.pendingDelegations
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
                        "delegation.completed_count": resumableRal.completedDelegations.length,
                        "delegation.pending_count": resumableRal.pendingDelegations.length,
                    });
                } else if (injectionRal) {
                    // Resume RAL with queued injections (pairing checkpoint)
                    ralNumber = injectionRal.ralNumber;
                    isResumption = true;

                    span.addEvent("executor.ral_resumed_for_injection", {
                        "ral.number": ralNumber,
                        "injection.count": injectionRal.queuedInjections.length,
                        "pending_delegations": injectionRal.pendingDelegations.length,
                    });
                } else {
                    // Create a new RAL for this execution
                    ralNumber = ralRegistry.create(
                        context.agent.pubkey,
                        context.conversationId,
                        context.triggeringEvent.id
                    );
                }

                // Check for other active RALs in this conversation
                const existingRALs = ralRegistry.getActiveRALs(context.agent.pubkey, context.conversationId);

                span.setAttributes({
                    "ral.number": ralNumber,
                    "ral.is_resumption": isResumption,
                    "ral.other_active_count": existingRALs.length - 1, // Exclude self
                });

                // Get summaries of other RALs to inject as context
                const otherRALSummaries = ralRegistry.getOtherRALSummaries(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (otherRALSummaries.length > 0) {
                    span.addEvent("executor.concurrent_rals", {
                        "ral.count": otherRALSummaries.length,
                        "ral.numbers": otherRALSummaries.map(r => r.ralNumber).join(","),
                    });

                    // Pause other RALs to give this new RAL time to analyze and decide
                    const activeRalsBeforePause = ralRegistry.getActiveRALs(
                        context.agent.pubkey,
                        context.conversationId
                    );

                    span.addEvent("rals_pause_attempt", {
                        pausing_ral: ralNumber,
                        active_ral_count: activeRalsBeforePause.length,
                        active_ral_numbers: activeRalsBeforePause.map(r => r.ralNumber).join(","),
                        other_ral_summary_count: otherRALSummaries.length,
                    });

                    const pausedCount = ralRegistry.pauseOtherRALs(
                        context.agent.pubkey,
                        context.conversationId,
                        ralNumber
                    );

                    span.addEvent("executor.rals_paused", {
                        "ral.pausing_number": ralNumber,
                        "ral.paused_count": pausedCount,
                    });
                }

                // Store ralNumber in context for use throughout execution
                const contextWithRal = {
                    ...context,
                    ralNumber,
                    otherRALSummaries,
                };

                // Prepare execution context with all necessary components
                const { fullContext, toolTracker, agentPublisher, cleanup } =
                    this.prepareExecution(contextWithRal);

                // Add execution context to span
                const conversation = fullContext.getConversation();
                if (conversation) {
                    span.setAttributes({
                        "conversation.phase": conversation.phase,
                        "conversation.message_count": conversation.history.length,
                    });
                }

                // Get the model info early for console output
                const llmService = context.agent.createLLMService({});
                const modelInfo = llmService.model || "unknown";

                // Display execution start in console
                const ralLabel = isResumption
                    ? ` (RAL #${ralNumber} resuming)`
                    : existingRALs.length > 1 ? ` (RAL #${ralNumber})` : "";
                console.log(chalk.cyan(`\n━━━ ${context.agent.slug} [${modelInfo}]${ralLabel} ━━━`));

                span.addEvent("executor.started", {
                    ral_number: ralNumber,
                    is_resumption: isResumption,
                    has_phases: !!context.agent.phases,
                    concurrent_rals: existingRALs.length - 1,
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
                const isCreditsError = errorMessage.includes("Insufficient credits") || errorMessage.includes("402");

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
                                errorType: isCreditsError ? "insufficient_credits" : "execution_error",
                            },
                            {
                                triggeringEvent: context.triggeringEvent,
                                rootEvent: conversation.history[0],
                                conversationId: conversation.id,
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
    private prepareExecution(context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] }): {
        fullContext: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] };
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        const toolTracker = new ToolExecutionTracker();
        const agentPublisher = new AgentPublisher(context.agent);

        // Initialize ConversationStore for this conversation (required)
        if (!isProjectContextInitialized()) {
            throw new Error("Project context not initialized - cannot create ConversationStore");
        }
        const projectContext = getProjectContext();
        const projectId = projectContext.project.tagValue("d");
        if (!projectId) {
            throw new Error("Project ID not found - cannot create ConversationStore");
        }
        const basePath = join(homedir(), ".tenex");
        const conversationStore = new ConversationStore(basePath);
        conversationStore.load(projectId, context.conversationId);

        // Check for active pairings for this agent
        const hasActivePairings = projectContext.pairingManager
            ? projectContext.pairingManager.getActivePairingsForSupervisor(context.agent.pubkey).length > 0
            : false;

        const fullContext = {
            ...context,
            conversationCoordinator: context.conversationCoordinator,
            agentPublisher,
            conversationStore,
            hasConcurrentRALs: context.otherRALSummaries.length > 0,
            hasActivePairings,
            getConversation: () => context.conversationCoordinator.getConversation(context.conversationId),
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
        context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] },
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher,
        ralNumber: number
    ): Promise<NDKEvent | undefined> {
        let completionEvent: CompleteEvent | undefined;

        try {
            completionEvent = await this.executeStreaming(context, toolTracker, ralNumber);
        } catch (streamError) {
            logger.error("[AgentExecutor] Streaming failed", {
                agent: context.agent.slug,
                error: formatAnyError(streamError),
            });
            throw streamError;
        }

        // Determine if we should wait for more delegations
        // Use context.hasPendingDelegations (captured at completion time) for delegation completions
        // This avoids race conditions where pendingDelegations array is modified by concurrent completions
        const ralRegistry = RALRegistry.getInstance();
        const ralState = ralRegistry.getRAL(context.agent.pubkey, context.conversationId, ralNumber);

        // For non-delegation-completion executions, check current RAL state
        // For delegation completions, use the flag captured at completion time
        const hasPendingDelegations = context.isDelegationCompletion
            ? context.hasPendingDelegations
            : (ralState?.pendingDelegations.length ?? 0) > 0;

        // If agent generated no meaningful response and we're waiting for delegations, don't publish anything
        // This handles the case where the agent only called delegate() without outputting any text
        const hasMessageContent = completionEvent?.message && completionEvent.message.length > 0;
        if (!hasMessageContent && hasPendingDelegations) {
            trace.getActiveSpan()?.addEvent("executor.awaiting_delegations", {
                "ral.number": ralNumber,
                "delegation.pending_count": ralState?.pendingDelegations.length ?? 0,
            });

            console.log(chalk.yellow(`\n⏳ ${context.agent.slug} (RAL #${ralNumber}) - awaiting delegations`));

            return undefined;
        }

        if (!completionEvent) {
            throw new Error("LLM execution completed without producing a completion event");
        }

        const eventContext = createEventContext(context, completionEvent?.usage?.model);

        trace.getActiveSpan()?.addEvent("executor.complete", {
            "message.length": completionEvent?.message?.length || 0,
            "has_pending_delegations": hasPendingDelegations,
        });

        // Publish as intermediate (no p-tag) if there are still pending delegations
        // Otherwise publish as final completion (with p-tag)
        const finalResponseEvent = await agentPublisher.complete(
            {
                content: completionEvent?.message || "",
                usage: completionEvent?.usage,
                isIntermediate: hasPendingDelegations,
            },
            eventContext
        );

        // Add completion event to conversation history immediately
        // This prevents race conditions where user sends another message before
        // the completion event comes back through the Nostr subscription
        if (finalResponseEvent) {
            await context.conversationCoordinator.addEvent(context.conversationId, finalResponseEvent);
        }

        if (hasPendingDelegations) {
            console.log(chalk.cyan(`\n💬 ${context.agent.slug} (RAL #${ralNumber}) - responded (awaiting more delegations)`));
        } else {
            console.log(chalk.green(`\n✅ ${context.agent.slug} (RAL #${ralNumber}) completed`));
        }

        trace.getActiveSpan()?.addEvent("executor.final_published", {
            "event.id": finalResponseEvent?.id || "",
            "is_intermediate": hasPendingDelegations,
        });

        return finalResponseEvent;
    }

    /**
     * Execute streaming and return the completion event
     */
    private async executeStreaming(
        context: ExecutionContext & { ralNumber: number; otherRALSummaries: RALSummary[] },
        toolTracker: ToolExecutionTracker,
        ralNumber: number
    ): Promise<CompleteEvent | undefined> {
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
            throw new Error("ConversationStore not available - execution requires ConversationStore");
        }

        // Register RAL in ConversationStore
        conversationStore.ensureRalActive(context.agent.pubkey, ralNumber);

        // Build conversation messages from ConversationStore (single source of truth)
        const conversationMessages = conversationStore.buildMessagesForRal(context.agent.pubkey, ralNumber);

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
        });

        // Combine system prompt with conversation messages
        const messages: ModelMessage[] = [
            ...systemPromptMessages.map(sm => sm.message),
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

        let completionEvent: CompleteEvent | undefined;

        llmService.on("content", (event: ContentEvent) => {
            process.stdout.write(chalk.white(event.delta));
        });

        llmService.on("reasoning", (event: ReasoningEvent) => {
            process.stdout.write(chalk.gray(event.delta));
        });

        llmService.on("complete", (event: CompleteEvent) => {
            completionEvent = event;
        });

        llmService.on("stream-error", async (event: StreamErrorEvent) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);

            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", { error: formatAnyError(publishError) });
            }
        });

        llmService.on("session-captured", ({ sessionId: capturedSessionId }: SessionCapturedEvent) => {
            sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
        });

        llmService.on("tool-will-execute", async (event: ToolWillExecuteEvent) => {
            const argsStr = event.args !== undefined ? JSON.stringify(event.args) : "";
            const argsPreview = argsStr.substring(0, 50);
            console.log(chalk.yellow(`\n🔧 ${event.toolName}(${argsPreview}${argsStr.length > 50 ? "..." : ""})`));

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
                await context.conversationCoordinator.addEvent(context.conversationId, toolEvent);
            }
        });

        llmService.on("tool-did-execute", async (event: ToolDidExecuteEvent) => {
            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey,
            });
        });

        const executionSpan = trace.getActiveSpan();

        // Track whether we've released paused RALs (happens after first step)
        let hasReleasedPausedRALs = false;

        // Track accumulated messages from prepareStep - this is updated before each step
        // and includes all messages up to (but not including) the current step
        let latestAccumulatedMessages: ModelMessage[] = messages;

        try {
            // Mark this RAL as streaming
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, true);

            // Track message count to detect new messages
            let previousMessageCount = messages.length;

            // prepareStep: synchronous, handles injections and release of paused RALs
            const prepareStep = (
                step: {
                    messages: ModelMessage[];
                    stepNumber: number;
                    steps: Array<{ toolCalls: Array<{ toolName: string }>; text: string; reasoningText?: string }>;
                }
            ): { messages?: ModelMessage[] } | undefined => {
                // Update accumulated messages tracker - this is called BEFORE each step,
                // so step.messages includes all messages up to but not including the current step
                latestAccumulatedMessages = step.messages;

                // Add new messages to ConversationStore for persistence and concurrent RAL visibility
                if (step.stepNumber > 0 && conversationStore) {
                    const newMessages = step.messages.slice(previousMessageCount);
                    for (const msg of newMessages) {
                        conversationStore.addMessage({
                            pubkey: context.agent.pubkey,
                            ral: ralNumber,
                            message: msg,
                        });
                    }
                    previousMessageCount = step.messages.length;
                }

                // Check if we should release paused RALs based on completed steps
                // Only release after a step with actual tool calls (agent made a decision)
                if (!hasReleasedPausedRALs && step.steps.length > 0) {
                    const stepsInfo = step.steps.map((s, i) => ({
                        stepNumber: i,
                        toolCalls: s.toolCalls || [],
                        text: s.text || "",
                        reasoningText: s.reasoningText,
                    }));

                    if (shouldReleasePausedRALs(stepsInfo)) {
                        hasReleasedPausedRALs = true;

                        // Log what tool calls triggered the release
                        const triggeringToolCalls = stepsInfo
                            .flatMap(s => s.toolCalls.map(tc => tc.toolName))
                            .join(", ");

                        const releasedCount = ralRegistry.releaseOtherRALs(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber
                        );

                        if (releasedCount > 0 && executionSpan) {
                            executionSpan.addEvent("executor.rals_released", {
                                "ral.releasing_number": ralNumber,
                                "ral.released_count": releasedCount,
                                "step.completed_count": step.steps.length,
                                "step.triggering_tools": triggeringToolCalls,
                            });
                        }
                    }
                }

                const newInjections = ralRegistry.getAndConsumeInjections(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (newInjections.length === 0) {
                    return undefined;
                }

                const injectedMessages: ModelMessage[] = newInjections.map((q) => ({
                    role: q.role,
                    content: q.content,
                }));

                if (executionSpan) {
                    executionSpan.addEvent("ral_injection.process", {
                        "injection.message_count": newInjections.length,
                        "ral.number": ralNumber,
                    });
                }

                return { messages: [...step.messages, ...injectedMessages] };
            };

            const onStopCheck = async (steps: any[]): Promise<boolean> => {
                // Check if this RAL is paused by another RAL (e.g., a new RAL started)
                // Awaiting here (in async onStopCheck) allows us to pause between steps
                const pausePromise = ralRegistry.getPausePromise(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (pausePromise) {
                    const pausedBy = ralRegistry.getRAL(
                        context.agent.pubkey,
                        context.conversationId,
                        ralNumber
                    )?.pausedByRalNumber;

                    executionSpan?.addEvent("executor.ral_paused_waiting", {
                        "ral.number": ralNumber,
                        "ral.paused_by": pausedBy,
                    });

                    // Wait for the pause to be released
                    await pausePromise;

                    executionSpan?.addEvent("executor.ral_resumed", {
                        "ral.number": ralNumber,
                    });
                }

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
                        const messagesWithToolCalls: ModelMessage[] = [...latestAccumulatedMessages];

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
                                    output: tr.output !== undefined
                                        ? { type: "json" as const, value: tr.output }
                                        : { type: "text" as const, value: "" },
                                })),
                            });
                        }

                        ralRegistry.setPendingDelegations(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber,
                            pendingDelegations
                        );

                        // Also save to ConversationStore for persistence
                        if (conversationStore) {
                            // Add final messages to store
                            const newMessages = messagesWithToolCalls.slice(previousMessageCount);
                            for (const msg of newMessages) {
                                conversationStore.addMessage({
                                    pubkey: context.agent.pubkey,
                                    ral: ralNumber,
                                    message: msg,
                                });
                            }
                            // Don't complete RAL (pending delegations), just save
                            conversationStore.save();
                        }

                        return true;
                    }
                }

                return false;
            };

            await llmService.stream(messages, toolsObject, { abortSignal, prepareStep, onStopCheck });
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

            try {
                const { message: errorMessage, errorType } = formatStreamError(streamError);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", { error: formatAnyError(publishError) });
            }
            throw streamError;
        } finally {
            // Mark as no longer streaming
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, false);

            // Safety release: ensure any RALs we paused are released on cleanup
            if (!hasReleasedPausedRALs) {
                const releasedCount = ralRegistry.releaseOtherRALs(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber
                );

                if (releasedCount > 0) {
                    executionSpan?.addEvent("executor.rals_released_cleanup", {
                        "ral.releasing_number": ralNumber,
                        "ral.released_count": releasedCount,
                    });
                }
            }

            llmOpsRegistry.completeOperation(context);
            llmService.removeAllListeners();
        }

        if (!sessionId && llmService.provider === "claudeCode" && completionEvent) {
            sessionManager.saveLastSentEventId(context.triggeringEvent.id);
        }

        // Clear RAL if execution completed without pending delegations
        // We clear for any terminal finish reason (not just "stop"/"end" - Gemini returns "other")
        const finalRalState = ralRegistry.getRAL(context.agent.pubkey, context.conversationId, ralNumber);

        if (!finalRalState?.pendingDelegations.length) {
            ralRegistry.clearRAL(context.agent.pubkey, context.conversationId, ralNumber);

            // Complete RAL in ConversationStore and persist
            if (conversationStore) {
                conversationStore.completeRal(context.agent.pubkey, ralNumber);
                await conversationStore.save();
            }
        }

        return completionEvent;
    }
}

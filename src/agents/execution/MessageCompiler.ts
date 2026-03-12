import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { providerRegistry } from "@/llm/providers";
import type { ProviderCapabilities } from "@/llm/providers/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import type { CompletedDelegation, PendingDelegation } from "@/services/ral/types";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NudgeToolPermissions, NudgeData } from "@/services/nudge";
import type { LessonComment } from "@/services/prompt-compiler";
import type { SkillData } from "@/services/skill";
import { config } from "@/services/ConfigService";
import type { PromptMessage } from "@/conversations/PromptBuilder";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SessionManager } from "./SessionManager";
import type { LLMService } from "@/llm/service";
import { HistorySummaryService } from "@/services/history-summary/HistorySummaryService";
import { PromptPruningService } from "@/services/prompt-pruning/PromptPruningService";

const tracer = trace.getTracer("tenex.message-compiler");

type CompilationMode = "full" | "delta";

interface MessageCompilationPlan {
    mode: CompilationMode;
    cursor?: number;
}

/**
 * CompiledMessage - A message with event ID for compression tracking.
 * Combines ModelMessage with optional eventId field.
 */
export type CompiledMessage = ModelMessage & {
    id?: string;
    eventId?: string;
};

export interface MessageCompilerContext {
    agent: AgentInstance;
    project: NDKProject;
    conversation: ConversationStore;
    projectBasePath?: string;
    workingDirectory?: string;
    currentBranch?: string;
    availableAgents?: AgentInstance[];
    agentLessons?: Map<string, NDKAgentLesson[]>;
    /** Comments on agent lessons (kind 1111 NIP-22 comments) */
    agentComments?: Map<string, LessonComment[]>;
    mcpManager?: MCPManager;
    nudgeContent?: string;
    /** Individual nudge data for rendering in fragments */
    nudges?: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions?: NudgeToolPermissions;
    /** Concatenated skill content */
    skillContent?: string;
    /** Individual skill data for rendering in fragments */
    skills?: SkillData[];
    respondingToPubkey: string;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    ralNumber: number;
    /** System prompt fragment describing available meta model variants */
    metaModelSystemPrompt?: string;
    /** Variant-specific system prompt to inject when a meta model variant is active */
    variantSystemPrompt?: string;
}

export interface CompiledMessages {
    messages: ModelMessage[];
    mode: CompilationMode;
    counts: {
        systemPrompt: number;
        conversation: number;
        dynamicContext: number;
        total: number;
    };
}

export class MessageCompiler {
    private readonly plan: MessageCompilationPlan;
    private currentCursor: number;
    private readonly historySummaryService: HistorySummaryService;
    private readonly promptPruningService: PromptPruningService;

    constructor(
        private providerId: string,
        private sessionManager: SessionManager,
        private conversationStore: ConversationStore,
        llmService?: LLMService,
        compressionLlmService?: LLMService
    ) {
        this.plan = this.buildPlan();
        this.currentCursor = this.plan.cursor ?? -1;
        this.historySummaryService = new HistorySummaryService(
            conversationStore,
            llmService,
            compressionLlmService
        );
        this.promptPruningService = new PromptPruningService(
            conversationStore,
            conversationStore.getId()
        );
    }

    async compile(context: MessageCompilerContext): Promise<CompiledMessages> {
        return tracer.startActiveSpan("tenex.message.compile", async (span) => {
            try {
                // Validate conversation source - context.conversation must match conversationStore
                if (context.conversation.id !== this.conversationStore.getId()) {
                    throw new Error(
                        `Conversation mismatch: context.conversation.id (${context.conversation.id}) ` +
                        `does not match conversationStore.id (${this.conversationStore.getId()})`
                    );
                }

                span.setAttribute("agent.slug", context.agent.slug);
                span.setAttribute("conversation.id", shortenConversationId(context.conversation.id));
                span.setAttribute("ral.number", context.ralNumber);
                span.setAttribute("compilation.mode", this.plan.mode);

                const cursor = this.currentCursor;
                const session = this.sessionManager.getSession();
                const compressionConfig = this.getCompressionConfig();
                const preservedTailCount = this.mapPreservedTailCount(compressionConfig.slidingWindowSize);
                const messages: ModelMessage[] = [];
                let systemPromptCount = 0;
                const dynamicContextCount = 0;
                let finalPromptTokenEstimate: number | undefined;

                if (this.plan.mode === "full") {
                    if (compressionConfig.enabled) {
                        await this.historySummaryService.ensureUnderLimit(context.conversation.id, {
                            tokenThreshold: compressionConfig.tokenThreshold,
                            tokenBudget: compressionConfig.tokenBudget,
                            preservedTailCount,
                        });
                    }

                    // Build system prompt messages (sub-span removed - parent compile span is sufficient)
                    const systemPromptMessages = await buildSystemPromptMessages(context);

                    // Build raw conversation history; compression is applied explicitly below.
                    const conversationMessages = await this.conversationStore.buildMessagesForRal(
                        context.agent.pubkey,
                        context.ralNumber,
                        {
                            applyPersistedCompression: false,
                            includeMessageIds: true,
                        }
                    ) as PromptMessage[];

                    const systemMessages = systemPromptMessages.map((sm, index) => ({
                        ...sm.message,
                        id: `system:${index}`,
                    })) as PromptMessage[];

                    // Inject meta model system prompts if present
                    // These describe available model variants and variant-specific instructions
                    if (context.metaModelSystemPrompt) {
                        systemMessages.push({
                            id: "system:meta-model",
                            role: "system",
                            content: context.metaModelSystemPrompt,
                        } as PromptMessage);
                        systemPromptCount++;
                    }
                    if (context.variantSystemPrompt) {
                        systemMessages.push({
                            id: "system:variant",
                            role: "system",
                            content: context.variantSystemPrompt,
                        } as PromptMessage);
                        systemPromptCount++;
                    }

                    const preprocessedPrompt = compressionConfig.enabled
                        ? await this.promptPruningService.prune({
                            messages: [...systemMessages, ...conversationMessages],
                            maxTokens: compressionConfig.tokenBudget,
                            preservedTailCount,
                            applyStoredSummarySpans: true,
                        })
                        : undefined;

                    messages.push(
                        ...(
                            compressionConfig.enabled
                                ? preprocessedPrompt!.messages
                                : [...systemMessages, ...conversationMessages]
                        )
                    );
                    finalPromptTokenEstimate = preprocessedPrompt?.stats.finalTokenEstimate;

                    systemPromptCount += systemPromptMessages.length;
                } else {
                    // In delta mode, only send new conversation messages.
                    // The session already has full context from initial compilation.
                    const conversationMessages = await this.conversationStore.buildMessagesForRalAfterIndex(
                        context.agent.pubkey,
                        context.ralNumber,
                        cursor,
                        {
                            applyPersistedCompression: false,
                            includeMessageIds: true,
                        }
                    ) as PromptMessage[];

                    const deltaPrompt = compressionConfig.enabled
                        ? await this.promptPruningService.prune({
                            messages: conversationMessages,
                            maxTokens: compressionConfig.tokenBudget,
                            preservedTailCount,
                            priorContextTokens: session.priorContextTokens,
                            applyStoredSummarySpans: false,
                        })
                        : undefined;

                    messages.push(...(compressionConfig.enabled ? deltaPrompt!.messages : conversationMessages));
                    finalPromptTokenEstimate = deltaPrompt?.stats.finalTokenEstimate;
                }

                this.updatePriorContextTokens(finalPromptTokenEstimate, session.priorContextTokens);

                const conversationCount = this.plan.mode === "full"
                    ? messages.length - systemPromptCount - dynamicContextCount
                    : messages.length;

                const counts = {
                    systemPrompt: systemPromptCount,
                    conversation: conversationCount,
                    dynamicContext: dynamicContextCount,
                    total: messages.length,
                };

                span.setAttribute("message.count", messages.length);
                span.setAttribute("counts.system_prompt", counts.systemPrompt);
                span.setAttribute("counts.conversation", counts.conversation);
                span.setAttribute("counts.dynamic_context", counts.dynamicContext);
                span.setAttribute("counts.total", counts.total);

                // Update cursor for subsequent prepareStep calls within same execution.
                // This prevents resending the same raw conversation entries during streaming.
                this.currentCursor = Math.max(this.conversationStore.getMessageCount() - 1, cursor);

                return { messages, mode: this.plan.mode, counts };
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
            } finally {
                span.end();
            }
        });
    }

    advanceCursor(): void {
        const sessionCapabilities = this.getProviderCapabilities();
        const isStateful = sessionCapabilities?.sessionResumption === true;

        if (!isStateful) {
            return;
        }

        // Use current message count (includes agent's response), not compile-time cursor.
        // advanceCursor is called after agent responds, so we want the cursor to point
        // to the last message the agent knows about (its own response).
        const messageCount = this.conversationStore.getMessageCount();
        const cursorToSave = messageCount - 1;
        this.sessionManager.saveLastSentMessageIndex(cursorToSave);
    }

    maybeSummarizeAsync(): void {
        const compressionConfig = this.getCompressionConfig();
        if (!compressionConfig.enabled) {
            return;
        }

        this.historySummaryService.maybeSummarizeAsync(this.conversationStore.getId(), {
            tokenThreshold: compressionConfig.tokenThreshold,
            tokenBudget: compressionConfig.tokenBudget,
            preservedTailCount: this.mapPreservedTailCount(compressionConfig.slidingWindowSize),
        });
    }

    private buildPlan(): MessageCompilationPlan {
        const session = this.sessionManager.getSession();
        const capabilities = this.getProviderCapabilities();
        const isStateful = capabilities?.sessionResumption === true;
        const hasSession = Boolean(session.sessionId);
        const cursor = session.lastSentMessageIndex;
        const cursorIsValid =
            typeof cursor === "number" && cursor < this.conversationStore.getMessageCount();

        if (isStateful && hasSession && cursorIsValid) {
            return { mode: "delta", cursor };
        }

        return { mode: "full" };
    }

    private getProviderCapabilities(): ProviderCapabilities | undefined {
        const normalized = this.normalizeProviderId(this.providerId);
        const provider = providerRegistry.getProvider(normalized);
        if (provider) {
            return provider.metadata.capabilities;
        }

        const registered = providerRegistry
            .getRegisteredProviders()
            .find((metadata) => metadata.id === normalized);
        return registered?.capabilities;
    }

    private normalizeProviderId(providerId: string): string {
        const normalized = providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
        const registered = providerRegistry.getRegisteredProviders();
        const matches = registered.some((metadata) => metadata.id === normalized);

        return matches ? normalized : providerId;
    }

    private getCompressionConfig(): {
        enabled: boolean;
        tokenThreshold: number;
        tokenBudget: number;
        slidingWindowSize: number;
    } {
        const cfg = (() => {
            try {
                return config.getConfig();
            } catch {
                return undefined;
            }
        })();

        return {
            enabled: cfg?.compression?.enabled ?? true,
            tokenThreshold: cfg?.compression?.tokenThreshold ?? 50000,
            tokenBudget: cfg?.compression?.tokenBudget ?? 40000,
            slidingWindowSize: cfg?.compression?.slidingWindowSize ?? 50,
        };
    }

    private mapPreservedTailCount(slidingWindowSize: number): number {
        return Math.max(4, Math.min(12, slidingWindowSize));
    }

    private updatePriorContextTokens(
        finalPromptTokenEstimate: number | undefined,
        previousPriorContextTokens: number | undefined
    ): void {
        const sessionCapabilities = this.getProviderCapabilities();
        const isStateful = sessionCapabilities?.sessionResumption === true;

        if (!isStateful || finalPromptTokenEstimate === undefined) {
            return;
        }

        if (this.plan.mode === "full") {
            this.sessionManager.savePriorContextTokens(finalPromptTokenEstimate);
            return;
        }

        const nextPriorContextTokens = (previousPriorContextTokens ?? 0) + finalPromptTokenEstimate;
        this.sessionManager.savePriorContextTokens(nextPriorContextTokens);
    }
}

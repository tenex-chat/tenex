import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { providerRegistry } from "@/llm/providers";
import type { ProviderCapabilities } from "@/llm/providers/types";
import { agentTodosFragment } from "@/prompts/fragments/06-agent-todos";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getPubkeyService } from "@/services/PubkeyService";
import type { CompletedDelegation, PendingDelegation } from "@/services/ral/types";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NudgeToolPermissions, NudgeData } from "@/services/nudge";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SessionManager } from "./SessionManager";
import type { LLMService } from "@/llm/service";
import { createCompressionService } from "@/services/compression/CompressionService.js";
import { logger } from "@/utils/logger";

const tracer = trace.getTracer("tenex.message-compiler");

type CompilationMode = "full" | "delta";

interface MessageCompilationPlan {
    mode: CompilationMode;
    cursor?: number;
}

/** Ephemeral message to include in LLM context but NOT persist */
export interface EphemeralMessage {
    role: "user" | "system";
    content: string;
}

/**
 * CompiledMessage - A message with event ID for compression tracking.
 * Combines ModelMessage with optional eventId field.
 */
export type CompiledMessage = ModelMessage & {
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
    mcpManager?: MCPManager;
    nudgeContent?: string;
    /** Individual nudge data for rendering in fragments */
    nudges?: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions?: NudgeToolPermissions;
    respondingToPubkey: string;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    ralNumber: number;
    /** System prompt fragment describing available meta model variants */
    metaModelSystemPrompt?: string;
    /** Variant-specific system prompt to inject when a meta model variant is active */
    variantSystemPrompt?: string;
    /** Ephemeral messages to include in this compilation only (not persisted) */
    ephemeralMessages?: EphemeralMessage[];
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

    constructor(
        private providerId: string,
        private sessionManager: SessionManager,
        private conversationStore: ConversationStore,
        private llmService?: LLMService
    ) {
        this.plan = this.buildPlan();
        this.currentCursor = this.plan.cursor ?? -1;
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
                span.setAttribute("conversation.id", context.conversation.id.substring(0, 12));
                span.setAttribute("ral.number", context.ralNumber);
                span.setAttribute("compilation.mode", this.plan.mode);

                const cursor = this.currentCursor;
                const messages: ModelMessage[] = [];
                let systemPromptCount = 0;
                let dynamicContextCount = 0;

                if (this.plan.mode === "full") {
                    const systemPromptMessages = await tracer.startActiveSpan("tenex.message.build_system_prompt", async (sysSpan) => {
                        try {
                            const result = await buildSystemPromptMessages(context);
                            sysSpan.setAttribute("message.count", result.length);
                            return result;
                        } finally {
                            sysSpan.end();
                        }
                    });

                    // Apply compression: load existing segments and apply to conversation history
                    await this.applyCompression(context);

                    const conversationMessages = await tracer.startActiveSpan("tenex.message.build_conversation_history", async (convSpan) => {
                        try {
                            const result = await this.conversationStore.buildMessagesForRal(
                                context.agent.pubkey,
                                context.ralNumber,
                                context.projectBasePath
                            );
                            convSpan.setAttribute("message.count", result.length);
                            return result;
                        } finally {
                            convSpan.end();
                        }
                    });

                    const dynamicContextMessages = await tracer.startActiveSpan("tenex.message.build_dynamic_context", async (dynSpan) => {
                        try {
                            const result = await this.buildDynamicContextMessages(context);
                            dynSpan.setAttribute("message.count", result.length);
                            return result;
                        } finally {
                            dynSpan.end();
                        }
                    });

                    messages.push(...systemPromptMessages.map((sm) => sm.message));

                    // Inject meta model system prompts if present
                    // These describe available model variants and variant-specific instructions
                    if (context.metaModelSystemPrompt) {
                        messages.push({
                            role: "system",
                            content: context.metaModelSystemPrompt,
                        });
                        systemPromptCount++;
                    }
                    if (context.variantSystemPrompt) {
                        messages.push({
                            role: "system",
                            content: context.variantSystemPrompt,
                        });
                        systemPromptCount++;
                    }

                    messages.push(...conversationMessages);

                    messages.push(...dynamicContextMessages);

                    // Add ephemeral messages (e.g., supervision corrections) LAST in the message array.
                    // This satisfies Gemini's constraint that multi-turn requests should end with a user role.
                    // If ephemeral messages are placed before system messages, Gemini/OpenRouter strips them.
                    if (context.ephemeralMessages?.length) {
                        for (const ephemeral of context.ephemeralMessages) {
                            messages.push({
                                role: ephemeral.role,
                                content: ephemeral.content,
                            });
                        }
                    }

                    systemPromptCount += systemPromptMessages.length;
                    dynamicContextCount = dynamicContextMessages.length + (context.ephemeralMessages?.length ?? 0);
                } else {
                    // In delta mode, only send new conversation messages.
                    // The session already has full context from initial compilation.
                    // Sending wrapped system context as user messages confuses Claude Code
                    // into responding to the context instead of the user's question.
                    const conversationMessages = await this.conversationStore.buildMessagesForRalAfterIndex(
                        context.agent.pubkey,
                        context.ralNumber,
                        cursor,
                        context.projectBasePath
                    );
                    messages.push(...conversationMessages);

                    // Add ephemeral messages LAST in delta mode too (for supervision corrections).
                    // Must be last to satisfy Gemini's message ordering constraints.
                    if (context.ephemeralMessages?.length) {
                        for (const ephemeral of context.ephemeralMessages) {
                            messages.push({
                                role: ephemeral.role,
                                content: ephemeral.content,
                            });
                        }
                    }
                }

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
                // This prevents resending the same messages during streaming.
                // CRITICAL: Use compressed count, not raw count. Cursor must be in compressed space
                // to match the space used by buildMessagesForRalAfterIndex.
                this.currentCursor = Math.max(this.conversationStore.getCompressedMessageCount() - 1, cursor);

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
        // CRITICAL: Use compressed count to save cursor in compressed space.
        const messageCount = this.conversationStore.getCompressedMessageCount();
        const cursorToSave = messageCount - 1;
        this.sessionManager.saveLastSentMessageIndex(cursorToSave);
    }

    private buildPlan(): MessageCompilationPlan {
        const session = this.sessionManager.getSession();
        const capabilities = this.getProviderCapabilities();
        const isStateful = capabilities?.sessionResumption === true;
        const hasSession = Boolean(session.sessionId);
        const cursor = session.lastSentMessageIndex;
        const cursorIsValid =
            typeof cursor === "number" && cursor < this.conversationStore.getCompressedMessageCount();

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

    private async buildDynamicContextMessages(
        context: MessageCompilerContext
    ): Promise<ModelMessage[]> {
        const parts: string[] = [];

        // Add todo content if present
        const todoContent = await agentTodosFragment.template({
            conversation: context.conversation,
            agentPubkey: context.agent.pubkey,
        });
        if (todoContent) {
            parts.push(todoContent);
        }

        // Always add response context
        const responseContextContent = await this.buildResponseContext(context);
        parts.push(responseContextContent);

        // Return as a single combined system message
        return [
            {
                role: "system",
                content: parts.join("\n\n"),
            },
        ];
    }

    private async buildResponseContext(context: MessageCompilerContext): Promise<string> {
        const pubkeyService = getPubkeyService();
        const respondingToName = await pubkeyService.getName(context.respondingToPubkey);
        let responseContextContent = `Your response will be sent to @${respondingToName}.`;

        const allDelegatedPubkeys = [
            ...context.pendingDelegations.map((d) => d.recipientPubkey),
            ...context.completedDelegations.map((d) => d.recipientPubkey),
        ];

        if (allDelegatedPubkeys.length > 0) {
            const delegatedAgentNames = await Promise.all(
                allDelegatedPubkeys.map((pk) => pubkeyService.getName(pk))
            );
            const uniqueNames = [...new Set(delegatedAgentNames)];
            responseContextContent +=
                `\nYou have delegations to: ${uniqueNames.map((n) => `@${n}`).join(", ")}.`;
            responseContextContent +=
                "\nIf you want to follow up with a delegated agent, use delegate_followup with the delegation ID. Do NOT address them directly in your response - they won't see it.";
        }

        return responseContextContent;
    }

    /**
     * Apply reactive compression if needed.
     * This ensures conversation history fits within the token budget.
     */
    private async applyCompression(context: MessageCompilerContext): Promise<void> {
        // Skip compression if LLMService not available
        if (!this.llmService) {
            return;
        }

        const compressionService = createCompressionService(
            this.conversationStore,
            this.llmService!
        );

        // Get compression config with proper defaults (enabled: true by default)
        // CRITICAL: Don't check config.compression?.enabled directly - it bypasses
        // CompressionService defaults. Let CompressionService handle the enabled check.
        const compressionConfig = compressionService.getCompressionConfig();
        if (!compressionConfig.enabled) {
            return;
        }

        return tracer.startActiveSpan("tenex.message.apply_compression", async (span) => {
            try {
                span.setAttribute("conversation.id", context.conversation.id.substring(0, 12));

                // Reactive blocking compression - use configured budget or CompressionService default
                const tokenBudget = compressionConfig.tokenBudget;
                await compressionService.ensureUnderLimit(
                    context.conversation.id,
                    tokenBudget
                );

                span.setAttribute("compression.budget", tokenBudget);
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                // Non-critical - log and continue without compression
                logger.warn("Reactive compression failed", {
                    conversationId: context.conversation.id,
                    ralNumber: context.ralNumber,
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                span.end();
            }
        });
    }
}

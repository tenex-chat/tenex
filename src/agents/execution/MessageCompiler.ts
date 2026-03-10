import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { providerRegistry } from "@/llm/providers";
import type { ProviderCapabilities } from "@/llm/providers/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { agentTodosFragment } from "@/prompts/fragments/06-agent-todos";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getPubkeyService } from "@/services/PubkeyService";
import type { CompletedDelegation, PendingDelegation } from "@/services/ral/types";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NudgeToolPermissions, NudgeData, WhitelistItem } from "@/services/nudge";
import type { LessonComment } from "@/services/prompt-compiler";
import type { SkillData } from "@/services/skill";
import { config } from "@/services/ConfigService";
import type { AddressableModelMessage } from "@/conversations/MessageBuilder";
import { createTenexSystemReminderProviderOptions } from "@/llm/middleware/system-reminders";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SessionManager } from "./SessionManager";
import type { LLMService } from "@/llm/service";
import { createCompressionService } from "@/services/compression/CompressionService.js";
import { applyTenexContextCompression } from "@/services/compression/context-compression";
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
    /** Ephemeral messages to include in this compilation only (not persisted) */
    ephemeralMessages?: EphemeralMessage[];
    /** Available whitelisted nudges for delegation */
    availableNudges?: WhitelistItem[];
    /** Available whitelisted skills */
    availableSkills?: WhitelistItem[];
}

export interface CompiledMessages {
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
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
        private llmService?: LLMService,
        private compressionLlmService?: LLMService
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
                span.setAttribute("conversation.id", shortenConversationId(context.conversation.id));
                span.setAttribute("ral.number", context.ralNumber);
                span.setAttribute("compilation.mode", this.plan.mode);

                // Consume any deferred injections from previous turns (e.g., supervision nudges).
                // These are added to ephemeral messages so they appear in context but aren't persisted.
                const deferredInjections = this.conversationStore.consumeDeferredInjections(context.agent.pubkey);
                if (deferredInjections.length > 0) {
                    span.setAttribute("deferred_injections.count", deferredInjections.length);
                    logger.debug("[MessageCompiler] Consuming deferred injections", {
                        agent: context.agent.slug,
                        count: deferredInjections.length,
                        sources: deferredInjections.map(d => d.source).filter(Boolean),
                    });

                    // Initialize ephemeralMessages if not present
                    if (!context.ephemeralMessages) {
                        context.ephemeralMessages = [];
                    }
                    // Add deferred injections as ephemeral system messages
                    for (const injection of deferredInjections) {
                        context.ephemeralMessages.push({
                            role: injection.role,
                            content: injection.content,
                        });
                    }
                    // Save the store to persist the consumption
                    await this.conversationStore.save();
                }

                const cursor = this.currentCursor;
                const messages: ModelMessage[] = [];
                let providerOptions: ProviderOptions | undefined;
                let systemPromptCount = 0;
                const dynamicContextCount = 0;

                if (this.plan.mode === "full") {
                    const compressionConfig = this.getCompressionConfig();

                    // Build system prompt messages (sub-span removed - parent compile span is sufficient)
                    const systemPromptMessages = await buildSystemPromptMessages(context);

                    // Apply compression: load existing segments and apply to conversation history
                    await this.applyCompression(context);

                    // Build raw conversation history; compression is applied explicitly below.
                    const conversationMessages = await this.conversationStore.buildMessagesForRal(
                        context.agent.pubkey,
                        context.ralNumber,
                        {
                            applyPersistedCompression: false,
                            includeMessageIds: true,
                        }
                    ) as AddressableModelMessage[];

                    // Build dynamic context content (todo state, response context)
                    const dynamicContextContent = await this.buildDynamicContextContent(context);

                    const systemMessages = systemPromptMessages.map((sm, index) => ({
                        ...sm.message,
                        id: `system:${index}`,
                    })) as AddressableModelMessage[];

                    // Inject meta model system prompts if present
                    // These describe available model variants and variant-specific instructions
                    if (context.metaModelSystemPrompt) {
                        systemMessages.push({
                            id: "system:meta-model",
                            role: "system",
                            content: context.metaModelSystemPrompt,
                        } as AddressableModelMessage);
                        systemPromptCount++;
                    }
                    if (context.variantSystemPrompt) {
                        systemMessages.push({
                            id: "system:variant",
                            role: "system",
                            content: context.variantSystemPrompt,
                        } as AddressableModelMessage);
                        systemPromptCount++;
                    }

                    const preprocessedMessages = compressionConfig.enabled
                        ? await applyTenexContextCompression({
                            messages: [...systemMessages, ...conversationMessages],
                            conversationStore: this.conversationStore,
                            conversationId: context.conversation.id,
                            maxTokens: compressionConfig.tokenBudget,
                            slidingWindowSize: compressionConfig.slidingWindowSize,
                        })
                        : [...systemMessages, ...conversationMessages];

                    messages.push(...preprocessedMessages);

                    providerOptions = this.buildSystemReminderProviderOptions(
                        dynamicContextContent,
                        context.ephemeralMessages
                    );

                    systemPromptCount += systemPromptMessages.length;
                    // NOTE: dynamicContextCount stays 0 because reminder content is applied later
                    // by AI SDK middleware, not added as separate compile-time messages.
                } else {
                    // In delta mode, only send new conversation messages.
                    // The session already has full context from initial compilation.
                    // However, dynamic context (todos, response routing) must still be included
                    // since it can change between turns in a stateful session.
                    const conversationMessages = await this.conversationStore.buildMessagesForRalAfterIndex(
                        context.agent.pubkey,
                        context.ralNumber,
                        cursor,
                        {
                            applyPersistedCompression: false,
                            includeMessageIds: true,
                        }
                    );
                    messages.push(...conversationMessages);

                    // Build dynamic context for delta mode (todo state, response context)
                    const dynamicContextContent = await this.buildDynamicContextContent(context);

                    providerOptions = this.buildSystemReminderProviderOptions(
                        dynamicContextContent,
                        context.ephemeralMessages
                    );
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
                // This prevents resending the same raw conversation entries during streaming.
                this.currentCursor = Math.max(this.conversationStore.getMessageCount() - 1, cursor);

                return { messages, providerOptions, mode: this.plan.mode, counts };
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

    /**
     * Build dynamic context content for injection into the last user message.
     * This includes todo state and response context.
     *
     * @returns Combined content string, or empty string if no content
     */
    private async buildDynamicContextContent(
        context: MessageCompilerContext
    ): Promise<string> {
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

        return parts.join("\n\n");
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

    private buildSystemReminderProviderOptions(
        dynamicContextContent: string,
        ephemeralMessages?: EphemeralMessage[]
    ): ProviderOptions | undefined {
        const ephemeralContents = (ephemeralMessages ?? [])
            .map((ephemeral) => ephemeral.content.trim())
            .filter((content) => content.length > 0);

        return createTenexSystemReminderProviderOptions({
            dynamicContext: dynamicContextContent,
            ephemeralContents,
        });
    }

    /**
     * Apply reactive compression if needed.
     * This ensures conversation history fits within the token budget.
     */
    private async applyCompression(context: MessageCompilerContext): Promise<void> {
        // Skip compression if LLMService not available
        const llmService = this.llmService;
        if (!llmService) {
            return;
        }

        const compressionService = createCompressionService(
            this.conversationStore,
            llmService,
            this.compressionLlmService
        );
        const compressionConfig = this.getCompressionConfig();
        if (!compressionConfig.enabled) {
            return;
        }

        // Apply reactive compression (sub-span removed - CompressionService has its own span when work is done)
        try {
            const tokenBudget = compressionConfig.tokenBudget;
            await compressionService.ensureUnderLimit(
                context.conversation.id,
                tokenBudget
            );
        } catch (error) {
            // Non-critical - log and continue without compression
            logger.warn("Reactive compression failed", {
                conversationId: context.conversation.id,
                ralNumber: context.ralNumber,
                error: error instanceof Error ? error.message : String(error),
            });
        }
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
}

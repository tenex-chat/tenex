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
import { combineSystemReminders } from "@/services/system-reminder";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage, TextPart } from "ai";
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
                let systemPromptCount = 0;
                let dynamicContextCount = 0;

                if (this.plan.mode === "full") {
                    // Build system prompt messages (sub-span removed - parent compile span is sufficient)
                    const systemPromptMessages = await buildSystemPromptMessages(context);

                    // Apply compression: load existing segments and apply to conversation history
                    await this.applyCompression(context);

                    // Build conversation history (sub-span removed - parent compile span is sufficient)
                    const conversationMessages = await this.conversationStore.buildMessagesForRal(
                        context.agent.pubkey,
                        context.ralNumber,
                        context.projectBasePath
                    );

                    // Build dynamic context content (todo state, response context)
                    const dynamicContextContent = await this.buildDynamicContextContent(context);

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

                    // Collect all ephemeral content: dynamic context + any queued ephemeral messages.
                    // These are appended to the last user message as <system-reminder> tags.
                    // This unifies behavioral nudges (heuristic violations, deferred injections,
                    // todo state, response context) into a consistent format.
                    // AGENTS.md injections remain tool-bound (in tool result output).
                    //
                    // NOTE: dynamicContextCount is NOT incremented here because ephemeral content
                    // is appended to an existing user message (not added as separate messages).
                    // The count tracks messages in the array, not ephemeral injections.
                    const allEphemeralMessages: EphemeralMessage[] = [];

                    // Add dynamic context as ephemeral
                    if (dynamicContextContent) {
                        allEphemeralMessages.push({
                            role: "system",
                            content: dynamicContextContent,
                        });
                    }

                    // Add queued ephemeral messages (heuristic violations, deferred injections, etc.)
                    if (context.ephemeralMessages?.length) {
                        allEphemeralMessages.push(...context.ephemeralMessages);
                    }

                    // Append all ephemeral content to the last user message
                    if (allEphemeralMessages.length > 0) {
                        this.appendEphemeralMessagesToLastUserMessage(messages, allEphemeralMessages);
                    }

                    systemPromptCount += systemPromptMessages.length;
                    // NOTE: dynamicContextCount stays 0 because ephemeral content is appended to
                    // existing user messages, not added as separate messages. The count is retained
                    // in the interface for backwards compatibility with telemetry consumers.
                } else {
                    // In delta mode, only send new conversation messages.
                    // The session already has full context from initial compilation.
                    // However, dynamic context (todos, response routing) must still be included
                    // since it can change between turns in a stateful session.
                    const conversationMessages = await this.conversationStore.buildMessagesForRalAfterIndex(
                        context.agent.pubkey,
                        context.ralNumber,
                        cursor,
                        context.projectBasePath
                    );
                    messages.push(...conversationMessages);

                    // Build dynamic context for delta mode (todo state, response context)
                    const dynamicContextContent = await this.buildDynamicContextContent(context);

                    // Collect all ephemeral content for delta mode
                    const allEphemeralMessages: EphemeralMessage[] = [];

                    if (dynamicContextContent) {
                        allEphemeralMessages.push({
                            role: "system",
                            content: dynamicContextContent,
                        });
                    }

                    if (context.ephemeralMessages?.length) {
                        allEphemeralMessages.push(...context.ephemeralMessages);
                    }

                    // Append all ephemeral content to the last user message
                    if (allEphemeralMessages.length > 0) {
                        this.appendEphemeralMessagesToLastUserMessage(messages, allEphemeralMessages);
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

    /**
     * Append ephemeral messages to the last user message as <system-reminder> tags.
     *
     * This method finds the last user message in the array and appends all ephemeral
     * messages as system-reminder blocks. This unifies behavioral nudges (heuristic
     * violations, deferred injections, supervision corrections) into a consistent format.
     *
     * Handles both string content and multimodal content (TextPart + ImagePart arrays).
     * For multimodal messages, the reminder is appended to the last text part.
     *
     * If no user message exists, the ephemeral messages are added as a new user message.
     *
     * @param messages - The message array to modify in place
     * @param ephemeralMessages - The ephemeral messages to append
     */
    private appendEphemeralMessagesToLastUserMessage(
        messages: ModelMessage[],
        ephemeralMessages: EphemeralMessage[]
    ): void {
        if (ephemeralMessages.length === 0) {
            return;
        }

        // Collect all ephemeral content, extracting inner content from already-wrapped reminders
        const reminderContents: string[] = [];
        for (const ephemeral of ephemeralMessages) {
            const content = ephemeral.content.trim();
            if (content) {
                // If content already has system-reminder tags, extract the inner content
                // to avoid double-wrapping when we combine them
                if (content.startsWith("<system-reminder>")) {
                    // Extract all system-reminder blocks from the content
                    const extracted = this.extractAllSystemReminderContents(content);
                    if (extracted.length > 0) {
                        reminderContents.push(...extracted);
                    } else {
                        // Fallback: use raw content if extraction fails
                        reminderContents.push(content);
                    }
                } else {
                    reminderContents.push(content);
                }
            }
        }

        if (reminderContents.length === 0) {
            return;
        }

        // Combine all contents into a single system-reminder block
        const combinedReminder = combineSystemReminders(reminderContents);

        // Find the last user message (searching from the end)
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    // String content: append directly
                    messages[i] = {
                        ...msg,
                        content: `${msg.content}\n\n${combinedReminder}`,
                    };
                    return;
                } else if (Array.isArray(msg.content)) {
                    // Multimodal content: find the last text part and append to it
                    // We need to work with the array generically since content can be various part types
                    const contentArray = msg.content;
                    let lastTextIndex = -1;

                    // Find the last text part
                    for (let j = contentArray.length - 1; j >= 0; j--) {
                        const part = contentArray[j];
                        if (typeof part === "object" && part !== null && "type" in part &&
                            part.type === "text" && "text" in part && typeof part.text === "string") {
                            lastTextIndex = j;
                            break;
                        }
                    }

                    if (lastTextIndex >= 0) {
                        // Append to the last text part
                        const textPart = contentArray[lastTextIndex] as TextPart;
                        const newTextPart: TextPart = {
                            type: "text",
                            text: `${textPart.text}\n\n${combinedReminder}`,
                        };
                        // Create new array with modified text part
                        const newContent = contentArray.map((part, idx) =>
                            idx === lastTextIndex ? newTextPart : part
                        );
                        messages[i] = {
                            ...msg,
                            content: newContent,
                        };
                        return;
                    }
                    // No text part found in multimodal - add a text part
                    const newTextPart: TextPart = { type: "text", text: combinedReminder };
                    messages[i] = {
                        ...msg,
                        content: [...contentArray, newTextPart],
                    };
                    return;
                }
            }
        }

        // No user message found - add as a new user message
        // This is a fallback; in practice there should always be a user message
        logger.warn("[MessageCompiler] No user message found for ephemeral injection, adding as new message");
        messages.push({
            role: "user",
            content: combinedReminder,
        });
    }

    /**
     * Extract all content blocks from system-reminder tags.
     * Handles multiple consecutive system-reminder blocks and trailing text.
     *
     * @param content - String potentially containing system-reminder tags
     * @returns Array of extracted content blocks
     */
    private extractAllSystemReminderContents(content: string): string[] {
        const results: string[] = [];
        const regex = /<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/g;
        let match: RegExpExecArray | null;
        let lastIndex = 0;

        while ((match = regex.exec(content)) !== null) {
            // Check for text before this match (after the last match)
            const beforeText = content.substring(lastIndex, match.index).trim();
            if (beforeText) {
                results.push(beforeText);
            }

            // Add the inner content of this system-reminder block
            const innerContent = match[1].trim();
            if (innerContent) {
                results.push(innerContent);
            }

            lastIndex = regex.lastIndex;
        }

        // Check for text after the last match
        const afterText = content.substring(lastIndex).trim();
        if (afterText) {
            results.push(afterText);
        }

        return results;
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
            this.llmService!,
            this.compressionLlmService
        );

        // Get compression config with proper defaults (enabled: true by default)
        // CRITICAL: Don't check config.compression?.enabled directly - it bypasses
        // CompressionService defaults. Let CompressionService handle the enabled check.
        const compressionConfig = compressionService.getCompressionConfig();
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
}

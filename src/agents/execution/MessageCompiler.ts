import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { shortenConversationId } from "@/utils/conversation-id";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import type { CompletedDelegation, PendingDelegation } from "@/services/ral/types";
import type { PromptMessage } from "@/conversations/PromptBuilder";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { trace } from "@opentelemetry/api";

/**
 * CompiledMessage - A message with optional prompt lineage metadata.
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
    triggeringEnvelope?: import("@/events/runtime/InboundEnvelope").InboundEnvelope;
    projectBasePath?: string;
    workingDirectory?: string;
    currentBranch?: string;
    availableAgents?: AgentInstance[];
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    ralNumber: number;
    /** System prompt fragment describing available meta model variants */
    metaModelSystemPrompt?: string;
    /** Variant-specific system prompt to inject when a meta model variant is active */
    variantSystemPrompt?: string;
    /** Whether the scratchpad strategy is active. When false, scratchpad-practice prompt is omitted. Defaults to true. */
    scratchpadAvailable?: boolean;
}

export interface CompiledMessages {
    messages: ModelMessage[];
    systemPrompt: string;
    counts: {
        systemPrompt: number;
        conversation: number;
        dynamicContext: number;
        total: number;
    };
}

export class MessageCompiler {
    constructor(private conversationStore: ConversationStore) {}

    async compile(context: MessageCompilerContext): Promise<CompiledMessages> {
        // Validate conversation source - context.conversation must match conversationStore
        if (context.conversation.id !== this.conversationStore.getId()) {
            throw new Error(
                `Conversation mismatch: context.conversation.id (${context.conversation.id}) ` +
                `does not match conversationStore.id (${this.conversationStore.getId()})`
            );
        }

        const activeSpan = trace.getActiveSpan();
        activeSpan?.setAttribute("agent.slug", context.agent.slug);
        activeSpan?.setAttribute("conversation.id", shortenConversationId(context.conversation.id));
        activeSpan?.setAttribute("ral.number", context.ralNumber);

        const messages: ModelMessage[] = [];
        let systemPromptCount = 0;
        const dynamicContextCount = 0;

        let t0 = performance.now();
        const systemPromptMessages = await buildSystemPromptMessages(context);
        const systemPromptText = systemPromptMessages.map(sm => sm.message.content).join("\n\n");
        activeSpan?.addEvent("system_prompt_built", { "duration_ms": Math.round(performance.now() - t0) });

        t0 = performance.now();
        const conversationMessages = await this.conversationStore.buildMessagesForRal(
            context.agent.pubkey,
            context.ralNumber,
            {
                includeMessageIds: true,
            }
        ) as PromptMessage[];
        activeSpan?.addEvent("conversation_messages_built", {
            "duration_ms": Math.round(performance.now() - t0),
        });

        const systemMessages = systemPromptMessages.map((sm, index) => ({
            ...sm.message,
            id: `system:${index}`,
        })) as PromptMessage[];

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

        messages.push(...systemMessages, ...conversationMessages);
        systemPromptCount += systemPromptMessages.length;

        const conversationCount = messages.length - systemPromptCount - dynamicContextCount;

        const counts = {
            systemPrompt: systemPromptCount,
            conversation: conversationCount,
            dynamicContext: dynamicContextCount,
            total: messages.length,
        };

        activeSpan?.setAttribute("message.count", messages.length);
        activeSpan?.setAttribute("counts.system_prompt", counts.systemPrompt);
        activeSpan?.setAttribute("counts.conversation", counts.conversation);
        activeSpan?.setAttribute("counts.dynamic_context", counts.dynamicContext);
        activeSpan?.setAttribute("counts.total", counts.total);

        return { messages, systemPrompt: systemPromptText, counts };
    }
}

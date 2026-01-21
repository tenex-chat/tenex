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
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import type { SessionManager } from "./SessionManager";

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
        private conversationStore: ConversationStore
    ) {
        this.plan = this.buildPlan();
        this.currentCursor = this.plan.cursor ?? -1;
    }

    async compile(context: MessageCompilerContext): Promise<CompiledMessages> {
        const cursor = this.currentCursor;
        const messages: ModelMessage[] = [];
        let systemPromptCount = 0;
        let dynamicContextCount = 0;

        if (this.plan.mode === "full") {
            const systemPromptMessages = await buildSystemPromptMessages(context);
            const conversationMessages = await this.conversationStore.buildMessagesForRal(
                context.agent.pubkey,
                context.ralNumber
            );
            const dynamicContextMessages = await this.buildDynamicContextMessages(context);

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

            // Add ephemeral messages (e.g., supervision corrections) after conversation
            // but before dynamic context. These influence the current turn but don't persist.
            if (context.ephemeralMessages?.length) {
                for (const ephemeral of context.ephemeralMessages) {
                    messages.push({
                        role: ephemeral.role,
                        content: ephemeral.content,
                    });
                }
            }

            messages.push(...dynamicContextMessages);

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
                cursor
            );
            messages.push(...conversationMessages);

            // Add ephemeral messages in delta mode too (for supervision corrections)
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

        // Update cursor for subsequent prepareStep calls within same execution.
        // This prevents resending the same messages during streaming.
        this.currentCursor = Math.max(this.conversationStore.getMessageCount() - 1, cursor);

        return { messages, mode: this.plan.mode, counts };
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

    private async buildDynamicContextMessages(
        context: MessageCompilerContext
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];
        const todoContent = await agentTodosFragment.template({
            conversation: context.conversation,
            agentPubkey: context.agent.pubkey,
        });

        if (todoContent) {
            messages.push({
                role: "system",
                content: todoContent,
            });
        }

        const responseContextContent = await this.buildResponseContext(context);
        messages.push({
            role: "system",
            content: responseContextContent,
        });

        return messages;
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
}

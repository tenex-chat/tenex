import {
    CONTEXT_MANAGEMENT_KEY,
    ScratchpadStrategy,
    SlidingWindowStrategy,
    createContextManagementRuntime,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
} from "ai-sdk-context-management";
import type { LanguageModelMiddleware } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { providerRegistry } from "@/llm/providers";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type NudgeToolPermissions } from "@/services/nudge";
import type { AISdkTool } from "@/tools/types";

export interface ExecutionContextManagement {
    middleware: LanguageModelMiddleware;
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
}

function normalizeProviderId(providerId: string): string {
    const normalized = providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const registered = providerRegistry.getRegisteredProviders();
    const matches = registered.some((metadata) => metadata.id === normalized);

    return matches ? normalized : providerId;
}

function isResumableProvider(providerId: string): boolean {
    const normalized = normalizeProviderId(providerId);
    const provider = providerRegistry.getProvider(normalized);

    if (provider) {
        return provider.metadata.capabilities.sessionResumption === true;
    }

    const registered = providerRegistry
        .getRegisteredProviders()
        .find((metadata) => metadata.id === normalized);
    return registered?.capabilities.sessionResumption === true;
}

function getContextManagementConfig(): {
    enabled: boolean;
    keepLastMessages: number;
    maxPromptTokens?: number;
} {
    const cfg = (() => {
        try {
            return configService.getConfig();
        } catch {
            return undefined;
        }
    })();

    const keepLastMessages = Math.max(0, Math.floor(cfg?.compression?.slidingWindowSize ?? 50));
    const rawBudget = cfg?.compression?.tokenBudget ?? 40000;
    const maxPromptTokens = Number.isFinite(rawBudget) && rawBudget > 0
        ? Math.floor(rawBudget)
        : undefined;

    return {
        enabled: cfg?.compression?.enabled ?? true,
        keepLastMessages,
        maxPromptTokens,
    };
}

function createConversationScratchpadRuntime(
    conversationStore: ConversationStore,
    config: ReturnType<typeof getContextManagementConfig>
): ContextManagementRuntime {
    return createContextManagementRuntime({
        strategies: [
            new SlidingWindowStrategy({
                keepLastMessages: config.keepLastMessages,
                maxPromptTokens: config.maxPromptTokens,
            }),
            new ScratchpadStrategy({
                scratchpadStore: {
                    get: ({ agentId }) => conversationStore.getContextManagementScratchpad(agentId),
                    set: async ({ agentId }, state) => {
                        conversationStore.setContextManagementScratchpad(agentId, state);
                        await conversationStore.save();
                    },
                    listConversation: (conversationId) =>
                        conversationId === conversationStore.getId()
                            ? conversationStore.listContextManagementScratchpads()
                            : [],
                },
            }),
        ],
    });
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    nudgeToolPermissions?: NudgeToolPermissions;
}): ExecutionContextManagement | undefined {
    const config = getContextManagementConfig();
    if (!config.enabled || isResumableProvider(options.providerId)) {
        return undefined;
    }

    const runtime = createConversationScratchpadRuntime(options.conversationStore, config);
    const optionalTools = options.nudgeToolPermissions && isOnlyToolMode(options.nudgeToolPermissions)
        ? {}
        : runtime.optionalTools as Record<string, AISdkTool>;

    return {
        middleware: runtime.middleware as LanguageModelMiddleware,
        optionalTools,
        requestContext: {
            conversationId: options.conversationId,
            agentId: options.agent.pubkey,
            agentLabel: options.agent.name || options.agent.slug,
        },
    };
}

export { CONTEXT_MANAGEMENT_KEY };

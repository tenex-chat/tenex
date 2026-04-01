import {
    CONTEXT_MANAGEMENT_KEY,
    type ContextManagementModelRef,
    type PrepareContextManagementRequestOptions,
    createDefaultPromptTokenEstimator,
} from "ai-sdk-context-management";
import type {
    ModelMessage,
    Tool as CoreTool,
    ToolChoice,
    LanguageModelMiddleware,
} from "ai";
import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    SharedV3ProviderOptions as ProviderOptions,
} from "@ai-sdk/provider";
import type { SharedPrefixObservation } from "ai-sdk-context-management";
import { prepareMessagesForRequest } from "@/llm/MessageProcessor";
import { createMessageSanitizerMiddleware } from "@/llm/middleware/message-sanitizer";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { mergeProviderOptions } from "@/llm/provider-options";
import type { AISdkTool } from "@/tools/types";
import { analysisTelemetryService } from "@/services/analysis/AnalysisTelemetryService";
import type { ExecutionContextManagement } from "./context-management";
import { normalizeMessagesForContextManagement } from "./context-management/normalize-messages";
import { withContextManagementAnalysisScope } from "./context-management/telemetry";
import type { LLMModelRequest } from "./types";

const messageSanitizer = createMessageSanitizerMiddleware();
const promptEstimator = createDefaultPromptTokenEstimator();
const ANTHROPIC_CLEAR_TOOL_USES_EDIT = {
    type: "clear_tool_uses_20250919",
    trigger: { type: "tool_uses", value: 25 },
    keep: { type: "tool_uses", value: 10 },
    clearAtLeast: { type: "input_tokens", value: 4000 },
    clearToolInputs: true,
    excludeTools: ["delegate", "delegate_followup", "delegate_crossproject"],
};

function buildMiddlewareModel(
    model: ContextManagementModelRef | undefined,
    fallbackProvider: string
): LanguageModelV3 {
    return {
        specificationVersion: "v3",
        provider: model?.provider ?? fallbackProvider,
        modelId: model?.modelId ?? "prepared-request",
        supportedUrls: {},
        doGenerate: async () => {
            throw new Error("buildMiddlewareModel.doGenerate should never be called");
        },
        doStream: async () => {
            throw new Error("buildMiddlewareModel.doStream should never be called");
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withAnthropicClearToolUses(
    providerOptions: ProviderOptions | undefined
): ProviderOptions {
    const anthropicOptions = isObject(providerOptions?.anthropic)
        ? (providerOptions?.anthropic as Record<string, unknown>)
        : {};
    const contextManagement = isObject(anthropicOptions.contextManagement)
        ? (anthropicOptions.contextManagement as Record<string, unknown>)
        : {};
    const existingEdits = Array.isArray(contextManagement.edits)
        ? contextManagement.edits
        : [];
    const hasClearToolUses = existingEdits.some(
        (edit) => isObject(edit) && edit.type === ANTHROPIC_CLEAR_TOOL_USES_EDIT.type
    );

    return mergeProviderOptions(providerOptions, {
        anthropic: {
            ...anthropicOptions,
            contextManagement: {
                ...contextManagement,
                edits: hasClearToolUses
                    ? existingEdits
                    : [...existingEdits, ANTHROPIC_CLEAR_TOOL_USES_EDIT],
            },
        },
    }) ?? {
        anthropic: {
            contextManagement: {
                edits: [ANTHROPIC_CLEAR_TOOL_USES_EDIT],
            },
        },
    };
}

function withAnthropicSharedPrefixBreakpoint(
    messages: ModelMessage[],
    observation: SharedPrefixObservation
): ModelMessage[] {
    if (observation.lastSharedMessageIndex === undefined) {
        return messages;
    }

    const cloned = structuredClone(messages) as ModelMessage[];
    const target = cloned[observation.lastSharedMessageIndex] as (ModelMessage & {
        providerOptions?: ProviderOptions;
    }) | undefined;
    if (!target) {
        return messages;
    }

    const anthropicOptions = isObject(target.providerOptions?.anthropic)
        ? (target.providerOptions?.anthropic as Record<string, unknown>)
        : {};
    target.providerOptions = {
        ...(target.providerOptions ?? {}),
        anthropic: {
            ...anthropicOptions,
            cacheControl: { type: "ephemeral", ttl: "1h" },
        },
    };
    return cloned;
}

async function applyPromptMiddleware(options: {
    middleware: LanguageModelMiddleware;
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
    model: LanguageModelV3;
}): Promise<{ messages: ModelMessage[]; providerOptions?: ProviderOptions }> {
    const transformed = await options.middleware.transformParams?.({
        params: {
            prompt: options.messages as unknown as LanguageModelV3CallOptions["prompt"],
            providerOptions: options.providerOptions,
        } as LanguageModelV3CallOptions,
        type: "stream",
        model: options.model,
    });

    return {
        messages:
            (transformed?.prompt as unknown as ModelMessage[] | undefined)
            ?? options.messages,
        providerOptions: transformed?.providerOptions ?? options.providerOptions,
    };
}

export async function prepareLLMRequest(options: {
    messages: ModelMessage[];
    tools: Record<string, AISdkTool>;
    providerId: string;
    model?: ContextManagementModelRef;
    contextManagement?: ExecutionContextManagement;
    providerOptions?: ProviderOptions;
    toolChoice?: ToolChoice<Record<string, CoreTool>>;
    analysisContext?: {
        projectId?: string;
        conversationId?: string;
        agentSlug?: string;
        agentId?: string;
    };
}): Promise<LLMModelRequest> {
    const estimatePromptTokens = (messages: ModelMessage[]): number =>
        Math.max(
            0,
            promptEstimator.estimatePrompt(messages as never)
                + (promptEstimator.estimateTools?.(
                    options.tools as unknown as PrepareContextManagementRequestOptions["tools"]
                ) ?? 0)
        );
    const model = buildMiddlewareModel(options.model, options.providerId);
    let preparedMessages = normalizeMessagesForContextManagement(options.messages);
    let preparedProviderOptions = options.providerOptions;
    let preparedToolChoice = options.toolChoice;
    let reportContextManagementUsage:
        | LLMModelRequest["reportContextManagementUsage"]
        | undefined;
    const preContextEstimatedInputTokens = estimatePromptTokens(preparedMessages);
    const analysisRequestSeed = analysisTelemetryService.createRequestSeed({
        preparedPromptMetrics: {
            preContextEstimatedInputTokens,
        },
    });

    if (options.contextManagement) {
        const contextManagement = options.contextManagement;
        const contextManagedRequest = await withContextManagementAnalysisScope(
            analysisRequestSeed
                ? {
                      requestId: analysisRequestSeed.requestId,
                      projectId: options.analysisContext?.projectId,
                      conversationId:
                          options.analysisContext?.conversationId
                          ?? contextManagement.requestContext.conversationId,
                      agentSlug: options.analysisContext?.agentSlug,
                      agentId:
                          options.analysisContext?.agentId
                          ?? contextManagement.requestContext.agentId,
                      provider: options.model?.provider ?? options.providerId,
                      model: options.model?.modelId ?? "prepared-request",
                  }
                : undefined,
            async () =>
                await contextManagement.prepareRequest({
                    messages: preparedMessages,
                    // ai-sdk-context-management resolves its own nested `ai` types, so this
                    // boundary needs an explicit cast despite the runtime tool shape matching.
                    tools:
                        options.tools as unknown as Omit<
                            PrepareContextManagementRequestOptions,
                            "requestContext"
                        >["tools"],
                    toolChoice: preparedToolChoice,
                    providerOptions: preparedProviderOptions,
                    model: options.model,
                })
        );

        preparedMessages = contextManagedRequest.messages;
        preparedProviderOptions = contextManagedRequest.providerOptions;
        preparedToolChoice =
            contextManagedRequest.toolChoice as ToolChoice<Record<string, CoreTool>> | undefined;
        reportContextManagementUsage = contextManagedRequest.reportActualUsage;
    }

    ({
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
    } = await applyPromptMiddleware({
        middleware: messageSanitizer,
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
        model,
    }));

    preparedMessages = prepareMessagesForRequest(preparedMessages, options.providerId);
    let promptCachingDiagnostics = analysisRequestSeed?.promptCachingDiagnostics;
    if (
        options.contextManagement
        && options.contextManagement.promptStabilityTracker
        && options.providerId === PROVIDER_IDS.ANTHROPIC
    ) {
        preparedProviderOptions = withAnthropicClearToolUses(preparedProviderOptions);
        const observation = options.contextManagement.promptStabilityTracker.observe(
            preparedMessages as never
        );
        preparedMessages = withAnthropicSharedPrefixBreakpoint(
            preparedMessages,
            observation
        );
        promptCachingDiagnostics = {
            sharedPrefixBreakpointApplied: observation.hasSharedPrefix,
            sharedPrefixMessageCount: observation.sharedPrefixMessageCount,
            sharedPrefixLastMessageIndex: observation.lastSharedMessageIndex,
            anthropicClearToolUsesEnabled: true,
        };
    }
    const sentEstimatedInputTokens = estimatePromptTokens(preparedMessages);

    return {
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
        experimentalContext: options.contextManagement
            ? {
                  [CONTEXT_MANAGEMENT_KEY]: options.contextManagement.requestContext,
              }
            : undefined,
        toolChoice: preparedToolChoice,
        analysisRequestSeed: analysisRequestSeed
            ? {
                  ...analysisRequestSeed,
                  telemetryMetadata: {
                      ...analysisRequestSeed.telemetryMetadata,
                      ...(promptCachingDiagnostics?.sharedPrefixBreakpointApplied !== undefined
                          ? {
                                "analysis.shared_prefix_breakpoint_applied":
                                    promptCachingDiagnostics.sharedPrefixBreakpointApplied,
                            }
                          : {}),
                      ...(promptCachingDiagnostics?.sharedPrefixMessageCount !== undefined
                          ? {
                                "analysis.shared_prefix_message_count":
                                    promptCachingDiagnostics.sharedPrefixMessageCount,
                            }
                          : {}),
                      ...(promptCachingDiagnostics?.sharedPrefixLastMessageIndex !== undefined
                          ? {
                                "analysis.shared_prefix_last_message_index":
                                    promptCachingDiagnostics.sharedPrefixLastMessageIndex,
                            }
                          : {}),
                      ...(promptCachingDiagnostics?.anthropicClearToolUsesEnabled !== undefined
                          ? {
                                "analysis.anthropic_clear_tool_uses_enabled":
                                    promptCachingDiagnostics.anthropicClearToolUsesEnabled,
                            }
                          : {}),
                  },
                  preparedPromptMetrics: {
                      preContextEstimatedInputTokens,
                      sentEstimatedInputTokens,
                      estimatedInputTokensSaved: Math.max(
                          0,
                          preContextEstimatedInputTokens - sentEstimatedInputTokens
                      ),
                  },
                  promptCachingDiagnostics,
              }
            : undefined,
        reportContextManagementUsage,
    };
}

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
import { prepareMessagesForRequest } from "@/llm/MessageProcessor";
import { createMessageSanitizerMiddleware } from "@/llm/middleware/message-sanitizer";
import {
    getSystemReminderContext,
    type CollectedSystemReminder,
} from "@/llm/system-reminder-context";
import type { AISdkTool } from "@/tools/types";
import { analysisTelemetryService } from "@/services/analysis/AnalysisTelemetryService";
import type { ExecutionContextManagement } from "./context-management";
import { normalizeMessagesForContextManagement } from "./context-management/normalize-messages";
import { withContextManagementAnalysisScope } from "./context-management/telemetry";
import type { LLMModelRequest } from "./types";

const messageSanitizer = createMessageSanitizerMiddleware();
const promptEstimator = createDefaultPromptTokenEstimator();

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

function mapQueuedRemindersToContextManagement(
    reminders: CollectedSystemReminder[]
): PrepareContextManagementRequestOptions["queuedReminders"] {
    return reminders.map((reminder) => ({
        kind: reminder.type,
        content: reminder.content,
        ...(reminder.attributes ? { attributes: reminder.attributes } : {}),
        ...(reminder.placement ? { placement: reminder.placement } : {}),
        ...(reminder.disposition ? { disposition: reminder.disposition } : {}),
        ...(reminder.persistInHistory !== undefined
            ? { persistInHistory: reminder.persistInHistory }
            : {}),
    }));
}

export async function prepareLLMRequest(options: {
    messages: ModelMessage[];
    tools: Record<string, AISdkTool>;
    providerId: string;
    model?: ContextManagementModelRef;
    contextManagement?: ExecutionContextManagement;
    reminderData?: unknown;
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
    let runtimeOverlays = undefined as LLMModelRequest["runtimeOverlays"] | undefined;
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
                    reminderData: options.reminderData,
                    queuedReminders: mapQueuedRemindersToContextManagement(
                        await getSystemReminderContext().collect()
                    ),
                })
        );

        preparedMessages = contextManagedRequest.messages;
        preparedProviderOptions = contextManagedRequest.providerOptions;
        preparedToolChoice =
            contextManagedRequest.toolChoice as ToolChoice<Record<string, CoreTool>> | undefined;
        reportContextManagementUsage = contextManagedRequest.reportActualUsage;
        runtimeOverlays = contextManagedRequest.runtimeOverlays;
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
    const promptCachingDiagnostics = analysisRequestSeed?.promptCachingDiagnostics;
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
        runtimeOverlays,
        analysisRequestSeed: analysisRequestSeed
            ? {
                  ...analysisRequestSeed,
                  telemetryMetadata: analysisRequestSeed.telemetryMetadata,
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

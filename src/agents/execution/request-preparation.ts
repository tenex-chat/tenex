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
import type { RuntimePromptOverlay } from "./prompt-history";

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

function escapeReminderAttribute(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("\"", "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function renderReminderXml(reminder: CollectedSystemReminder): string {
    const attrs = reminder.attributes
        ? Object.entries(reminder.attributes)
            .filter(([key, value]) => key.trim().length > 0 && value.trim().length > 0)
            .map(([key, value]) => `${key}="${escapeReminderAttribute(value)}"`)
            .join(" ")
        : "";
    return `<${reminder.type}${attrs.length > 0 ? ` ${attrs}` : ""}>${reminder.content.trim()}</${reminder.type}>`;
}

function normalizeReminderOverlayContent(content: string): string {
    const startTag = "<system-reminders>";
    const endTag = "</system-reminders>";

    if (!content.includes(startTag) || !content.includes(endTag)) {
        return content.trim();
    }

    const inner = content
        .slice(content.indexOf(startTag) + startTag.length, content.lastIndexOf(endTag))
        .trim();
    if (inner.length === 0) {
        return "";
    }

    return `${startTag}\n${inner}\n${endTag}`;
}

function replaceOverlayMessageContent(
    message: ModelMessage,
    content: string
): ModelMessage {
    switch (message.role) {
        case "system":
        case "user":
        case "assistant":
            return {
                ...message,
                content,
            };
        case "tool":
            return message;
    }
}

function stripTransientReminderXml(
    content: string,
    reminders: CollectedSystemReminder[]
): string {
    let nextContent = content;

    for (const reminder of reminders) {
        const xml = renderReminderXml(reminder);
        nextContent = nextContent.replace(`\n${xml}`, "");
        nextContent = nextContent.replace(`${xml}\n`, "");
        nextContent = nextContent.replace(xml, "");
    }

    return normalizeReminderOverlayContent(nextContent);
}

function filterRuntimeOverlaysForPersistence(params: {
    overlays: RuntimePromptOverlay[] | undefined;
    queuedReminders: CollectedSystemReminder[];
}): RuntimePromptOverlay[] | undefined {
    const transientQueuedReminders = params.queuedReminders.filter(
        (reminder) => reminder.persistInHistory !== true
    );

    if (transientQueuedReminders.length === 0 || !params.overlays?.length) {
        return params.overlays;
    }

    const filtered: RuntimePromptOverlay[] = [];

    for (const overlay of params.overlays) {
        if (overlay.overlayType !== "system-reminders") {
            filtered.push(overlay);
            continue;
        }

        const content = overlay.message.content;
        const stringContent = typeof content === "string"
            ? content
            : Array.isArray(content)
                && content.length === 1
                && content[0]?.type === "text"
                ? content[0].text
                : undefined;

        if (typeof stringContent !== "string") {
            filtered.push(overlay);
            continue;
        }

        const strippedContent = stripTransientReminderXml(
            stringContent,
            transientQueuedReminders
        );
        if (strippedContent.length === 0) {
            continue;
        }

        filtered.push({
            ...overlay,
            message: replaceOverlayMessageContent(overlay.message, strippedContent),
        });
    }

    return filtered;
}

function getReminderOverlayText(
    message: ModelMessage | RuntimePromptOverlay["message"]
): string | undefined {
    const content = message.content;

    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content) || content.length === 0) {
        return undefined;
    }

    const textParts = content.filter(
        (part): part is { type: "text"; text: string } =>
            part?.type === "text" && typeof part.text === "string"
    );

    return textParts.length === content.length
        ? textParts.map((part) => part.text).join("")
        : undefined;
}

function isContextManagementReminderOverlayMessage(message: ModelMessage): boolean {
    return message.role === "user"
        && typeof message.providerOptions === "object"
        && message.providerOptions !== null
        && typeof message.providerOptions[CONTEXT_MANAGEMENT_KEY] === "object"
        && message.providerOptions[CONTEXT_MANAGEMENT_KEY] !== null
        && (message.providerOptions[CONTEXT_MANAGEMENT_KEY] as { type?: unknown }).type === "reminder-overlay";
}

function appendReminderTextToLastUserMessage(
    messages: ModelMessage[],
    reminderText: string
): ModelMessage[] | undefined {
    const cloned = structuredClone(messages);

    for (let index = cloned.length - 1; index >= 0; index--) {
        const message = cloned[index];
        if (message.role === "system") {
            continue;
        }
        if (message.role !== "user" || isContextManagementReminderOverlayMessage(message)) {
            continue;
        }

        if (typeof message.content === "string") {
            cloned[index] = {
                ...message,
                content: message.content.length > 0
                    ? `${message.content}\n\n${reminderText}`
                    : reminderText,
            };
            return cloned;
        }

        if (!Array.isArray(message.content)) {
            continue;
        }

        const content = [...message.content];
        const lastPart = content.at(-1);
        if (lastPart?.type === "text" && typeof lastPart.text === "string") {
            content[content.length - 1] = {
                ...lastPart,
                text: `${lastPart.text}\n\n${reminderText}`,
            };
        } else {
            content.push({ type: "text", text: reminderText });
        }

        cloned[index] = {
            ...message,
            content,
        };
        return cloned;
    }

    return undefined;
}

function collapseSystemReminderOverlaysIntoLastUserMessage(params: {
    messages: ModelMessage[];
    runtimeOverlays: RuntimePromptOverlay[] | undefined;
}): {
    messages: ModelMessage[];
    runtimeOverlays: RuntimePromptOverlay[] | undefined;
} {
    const reminderOverlayTexts = (params.runtimeOverlays ?? [])
        .filter((overlay) => overlay.overlayType === "system-reminders")
        .map((overlay) => getReminderOverlayText(overlay.message))
        .filter((text): text is string => typeof text === "string" && text.length > 0);

    if (reminderOverlayTexts.length === 0) {
        return {
            messages: params.messages,
            runtimeOverlays: params.runtimeOverlays,
        };
    }

    const mergedMessages = appendReminderTextToLastUserMessage(
        params.messages,
        reminderOverlayTexts.join("\n\n")
    );
    if (!mergedMessages) {
        return {
            messages: params.messages,
            runtimeOverlays: params.runtimeOverlays,
        };
    }

    const remainingOverlayCounts = new Map<string, number>();
    for (const text of reminderOverlayTexts) {
        remainingOverlayCounts.set(text, (remainingOverlayCounts.get(text) ?? 0) + 1);
    }

    const filteredMessages = mergedMessages.filter((message) => {
        if (!isContextManagementReminderOverlayMessage(message)) {
            return true;
        }

        const text = getReminderOverlayText(message);
        if (!text) {
            return true;
        }

        const remaining = remainingOverlayCounts.get(text) ?? 0;
        if (remaining <= 0) {
            return true;
        }

        remainingOverlayCounts.set(text, remaining - 1);
        return false;
    });

    const filteredRuntimeOverlays = params.runtimeOverlays?.filter(
        (overlay) => overlay.overlayType !== "system-reminders"
    );

    return {
        messages: filteredMessages,
        runtimeOverlays:
            filteredRuntimeOverlays && filteredRuntimeOverlays.length > 0
                ? filteredRuntimeOverlays
                : undefined,
    };
}

export async function prepareLLMRequest(options: {
    messages: ModelMessage[];
    tools: Record<string, AISdkTool>;
    providerId: string;
    model?: ContextManagementModelRef;
    contextManagement?: ExecutionContextManagement;
    promptHistoryCacheAnchored?: boolean;
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
    let queuedReminders: CollectedSystemReminder[] = [];

    if (options.contextManagement) {
        const contextManagement = options.contextManagement;
        queuedReminders = await getSystemReminderContext().collect();
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
                    queuedReminders: mapQueuedRemindersToContextManagement(queuedReminders),
                })
        );

        preparedMessages = contextManagedRequest.messages;
        preparedProviderOptions = contextManagedRequest.providerOptions;
        preparedToolChoice =
            contextManagedRequest.toolChoice as ToolChoice<Record<string, CoreTool>> | undefined;
        reportContextManagementUsage = contextManagedRequest.reportActualUsage;
        runtimeOverlays = filterRuntimeOverlaysForPersistence({
            overlays: contextManagedRequest.runtimeOverlays as RuntimePromptOverlay[] | undefined,
            queuedReminders,
        });

        if (options.promptHistoryCacheAnchored !== true) {
            const collapsedReminders = collapseSystemReminderOverlaysIntoLastUserMessage({
                messages: preparedMessages,
                runtimeOverlays: runtimeOverlays as RuntimePromptOverlay[] | undefined,
            });
            preparedMessages = collapsedReminders.messages;
            runtimeOverlays = collapsedReminders.runtimeOverlays;
        }
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
              }
            : undefined,
        reportContextManagementUsage,
    };
}

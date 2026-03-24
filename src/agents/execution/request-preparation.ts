import {
    CONTEXT_MANAGEMENT_KEY,
    type ContextManagementModelRef,
} from "ai-sdk-context-management";
import type {
    LanguageModel,
    ModelMessage,
    Tool as CoreTool,
    ToolChoice,
} from "ai";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import { prepareMessagesForRequest } from "@/llm/MessageProcessor";
import { createMessageSanitizerMiddleware } from "@/llm/middleware/message-sanitizer";
import { createTenexSystemRemindersMiddleware } from "@/llm/middleware/system-reminders";
import type { AISdkTool } from "@/tools/types";
import type { ExecutionContextManagement } from "./context-management";
import type { LLMModelRequest } from "./types";

const messageSanitizer = createMessageSanitizerMiddleware();
const systemReminders = createTenexSystemRemindersMiddleware();

function buildMiddlewareModel(
    model: ContextManagementModelRef | undefined,
    fallbackProvider: string
): LanguageModel {
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
    } as unknown as LanguageModel;
}

async function applyPromptMiddleware(options: {
    middleware: {
        transformParams?: (args: {
            params: { prompt: ModelMessage[]; providerOptions?: ProviderOptions };
            type: "generate" | "stream";
            model: LanguageModel;
        }) => Promise<
            { prompt: ModelMessage[]; providerOptions?: ProviderOptions } | undefined
        >;
    };
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
    model: LanguageModel;
}): Promise<{ messages: ModelMessage[]; providerOptions?: ProviderOptions }> {
    const transformed = await options.middleware.transformParams?.({
        params: {
            prompt: options.messages,
            providerOptions: options.providerOptions,
        },
        type: "stream",
        model: options.model,
    });

    return {
        messages: transformed?.prompt ?? options.messages,
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
}): Promise<LLMModelRequest> {
    const model = buildMiddlewareModel(options.model, options.providerId);
    let preparedMessages = options.messages;
    let preparedProviderOptions = options.providerOptions;
    let preparedToolChoice = options.toolChoice;
    let reportContextManagementUsage:
        | LLMModelRequest["reportContextManagementUsage"]
        | undefined;

    if (options.contextManagement) {
        const contextManagedRequest =
            await options.contextManagement.prepareRequest({
                messages: preparedMessages,
                tools: options.tools,
                toolChoice: preparedToolChoice,
                providerOptions: preparedProviderOptions,
                model: options.model,
            });

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

    ({
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
    } = await applyPromptMiddleware({
        middleware: systemReminders,
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
        model,
    }));

    preparedMessages = prepareMessagesForRequest(preparedMessages, options.providerId);

    return {
        messages: preparedMessages,
        providerOptions: preparedProviderOptions,
        experimentalContext: options.contextManagement
            ? {
                  [CONTEXT_MANAGEMENT_KEY]: options.contextManagement.requestContext,
              }
            : undefined,
        toolChoice: preparedToolChoice,
        reportContextManagementUsage,
    };
}

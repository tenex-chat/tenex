import {
    CONTEXT_MANAGEMENT_KEY,
    type ContextManagementModelRef,
    type PrepareContextManagementRequestOptions,
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
import { createTenexSystemRemindersMiddleware } from "@/llm/middleware/system-reminders";
import type { AISdkTool } from "@/tools/types";
import type { ExecutionContextManagement } from "./context-management";
import { normalizeMessagesForContextManagement } from "./context-management/normalize-messages";
import type { LLMModelRequest } from "./types";

const messageSanitizer = createMessageSanitizerMiddleware();
const systemReminders = createTenexSystemRemindersMiddleware();

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
    let preparedMessages = normalizeMessagesForContextManagement(options.messages);
    let preparedProviderOptions = options.providerOptions;
    let preparedToolChoice = options.toolChoice;
    let reportContextManagementUsage:
        | LLMModelRequest["reportContextManagementUsage"]
        | undefined;

    if (options.contextManagement) {
        const contextManagedRequest =
            await options.contextManagement.prepareRequest({
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

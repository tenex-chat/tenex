import {
    RemindersStrategy,
    createContextManagementRuntime,
} from "ai-sdk-context-management";
import type { ModelMessage } from "ai";
import type { RuntimePromptOverlay } from "../prompt-history";
import type { ExecutionContextManagement } from "../context-management";
import { prepareLLMRequest } from "../request-preparation";
import {
    createTenexReminderProviders,
    createTenexReminderStateStore,
    type TenexReminderData,
} from "../system-reminders";

function normalizeOverlay(
    overlay: RuntimePromptOverlay | undefined
): RuntimePromptOverlay | undefined {
    if (
        overlay?.message.role !== "user"
        || !Array.isArray(overlay.message.content)
        || overlay.message.content.length !== 1
        || overlay.message.content[0]?.type !== "text"
    ) {
        return overlay;
    }

    return {
        ...overlay,
        message: {
            ...overlay.message,
            content: overlay.message.content[0].text,
        },
    } as RuntimePromptOverlay;
}

function normalizeOverlays(
    overlays: RuntimePromptOverlay[] | undefined
): RuntimePromptOverlay[] {
    return (overlays ?? [])
        .map((overlay) => normalizeOverlay(overlay))
        .filter((overlay): overlay is RuntimePromptOverlay => overlay !== undefined);
}

function normalizeMessage(message: ModelMessage): ModelMessage {
    if (
        !Array.isArray(message.content)
        || message.content.length !== 1
        || message.content[0]?.type !== "text"
    ) {
        return message;
    }

    return {
        ...message,
        content: message.content[0].text,
    } as ModelMessage;
}

export async function prepareTenexReminderRequest(params: {
    messages: ModelMessage[];
    data: Pick<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">
        & Partial<Omit<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">>;
}): Promise<{
    messages: ModelMessage[];
    runtimeOverlays: RuntimePromptOverlay[];
}> {
    const reminderData: TenexReminderData = {
        pendingDelegations: [],
        completedDelegations: [],
        loadedSkills: [],
        ...params.data,
    };
    const runtime = createContextManagementRuntime({
        strategies: [
            new RemindersStrategy<TenexReminderData>({
                stateStore: createTenexReminderStateStore({
                    conversationStore: reminderData.conversation,
                }),
                providers: createTenexReminderProviders(),
                overlayType: "system-reminders",
            }),
        ],
    });
    const contextManagement: ExecutionContextManagement = {
        optionalTools: {},
        scratchpadAvailable: true,
        requestContext: {
            conversationId: reminderData.conversation.getId(),
            agentId: reminderData.agent.pubkey,
            agentLabel: reminderData.agent.name || reminderData.agent.slug,
        },
        prepareRequest: async (options) =>
            await runtime.prepareRequest({
                ...options,
                requestContext: {
                    conversationId: reminderData.conversation.getId(),
                    agentId: reminderData.agent.pubkey,
                    agentLabel: reminderData.agent.name || reminderData.agent.slug,
                },
            }),
    };
    const prepared = await prepareLLMRequest({
        messages: params.messages,
        tools: {},
        providerId: "test-provider",
        model: {
            provider: "test-provider",
            modelId: "test-model",
        },
        contextManagement,
        reminderData,
    });

    return {
        messages: prepared.messages.map((message) => normalizeMessage(message as ModelMessage)),
        runtimeOverlays: normalizeOverlays(
            prepared.runtimeOverlays
        ),
    };
}

export async function collectTenexReminderOverlays(
    data: Pick<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">
        & Partial<Omit<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">>
): Promise<RuntimePromptOverlay[]> {
    const prepared = await prepareTenexReminderRequest({
        messages: [],
        data,
    });
    return prepared.runtimeOverlays;
}

export async function collectTenexReminderOverlay(
    data: Pick<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">
        & Partial<Omit<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">>
): Promise<RuntimePromptOverlay | undefined> {
    const overlays = await collectTenexReminderOverlays(data);
    return overlays[0];
}

export async function collectTenexReminderXml(
    data: Pick<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">
        & Partial<Omit<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">>
): Promise<string> {
    const overlay = await collectTenexReminderOverlay(data);
    return typeof overlay?.message.content === "string"
        ? overlay.message.content
        : "";
}

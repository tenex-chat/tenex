import {
    RemindersStrategy,
    createContextManagementRuntime,
    type ContextManagementReminder,
} from "ai-sdk-context-management";
import type { RuntimePromptOverlay } from "../prompt-history";
import {
    createTenexReminderProviders,
    createTenexReminderStateStore,
    type TenexReminderData,
} from "../system-reminders";
import {
    getSystemReminderContext,
    type CollectedSystemReminder,
} from "@/llm/system-reminder-context";

function mapQueuedReminders(
    reminders: CollectedSystemReminder[]
): ContextManagementReminder[] {
    return reminders.map((reminder) => ({
        kind: reminder.type,
        content: reminder.content,
        ...(reminder.attributes ? { attributes: reminder.attributes } : {}),
        ...(reminder.placement ? { placement: reminder.placement } : {}),
        ...(reminder.disposition ? { disposition: reminder.disposition } : {}),
    }));
}

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

export async function collectTenexReminderOverlay(
    data: Pick<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">
        & Partial<Omit<TenexReminderData, "agent" | "conversation" | "respondingToPrincipal">>
): Promise<RuntimePromptOverlay | undefined> {
    const reminderData: TenexReminderData = {
        pendingDelegations: [],
        completedDelegations: [],
        loadedSkills: [],
        ...data,
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
    const prepared = await runtime.prepareRequest({
        requestContext: {
            conversationId: reminderData.conversation.getId(),
            agentId: reminderData.agent.pubkey,
            agentLabel: reminderData.agent.name || reminderData.agent.slug,
        },
        messages: [],
        reminderData,
        queuedReminders: mapQueuedReminders(
            await getSystemReminderContext().collect()
        ),
    });

    return normalizeOverlay(
        prepared.runtimeOverlays?.[0] as RuntimePromptOverlay | undefined
    );
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

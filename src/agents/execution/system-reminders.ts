import type { SystemReminderDescriptor } from "ai-sdk-system-reminders";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { agentTodosFragment } from "@/prompts/fragments/06-agent-todos";
import { getPubkeyService } from "@/services/PubkeyService";
import type {
    CompletedDelegation,
    PendingDelegation,
} from "@/services/ral/types";

export interface TenexReminderData {
    agent: AgentInstance;
    conversation: ConversationStore;
    respondingToPubkey: string;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
}

async function todoListProvider(
    data: TenexReminderData | undefined
): Promise<SystemReminderDescriptor | null> {
    if (!data) return null;

    const todoContent = await agentTodosFragment.template({
        conversation: data.conversation,
        agentPubkey: data.agent.pubkey,
    });

    if (!todoContent) return null;

    return { type: "todo-list", content: todoContent };
}

async function responseRoutingProvider(
    data: TenexReminderData | undefined
): Promise<SystemReminderDescriptor | null> {
    if (!data) return null;

    const pubkeyService = getPubkeyService();
    const respondingToName = await pubkeyService.getName(data.respondingToPubkey);

    return {
        type: "response-routing",
        content: `Your response will be sent to @${respondingToName}.`,
    };
}

async function delegationsProvider(
    data: TenexReminderData | undefined
): Promise<SystemReminderDescriptor | null> {
    if (!data) return null;

    const allDelegatedPubkeys = [
        ...data.pendingDelegations.map((delegation) => delegation.recipientPubkey),
        ...data.completedDelegations.map((delegation) => delegation.recipientPubkey),
    ];

    if (allDelegatedPubkeys.length === 0) return null;

    const pubkeyService = getPubkeyService();
    const delegatedAgentNames = await Promise.all(
        allDelegatedPubkeys.map((pubkey) => pubkeyService.getName(pubkey))
    );
    const uniqueNames = [...new Set(delegatedAgentNames)];

    return {
        type: "delegations",
        content: [
            `You have delegations to: ${uniqueNames.map((name) => `@${name}`).join(", ")}.`,
            "If you want to follow up with a delegated agent, use delegate_followup with the delegation ID. Do NOT address them directly in your response - they won't see it.",
        ].join("\n"),
    };
}

export function initializeReminderProviders(): void {
    const ctx = getSystemReminderContext();
    ctx.registerProvider("todo-list", todoListProvider);
    ctx.registerProvider("response-routing", responseRoutingProvider);
    ctx.registerProvider("delegations", delegationsProvider);
}

export function updateReminderData(data: TenexReminderData): void {
    getSystemReminderContext().setProviderData(data);
}

export function resetSystemReminders(): void {
    getSystemReminderContext().clear();
}

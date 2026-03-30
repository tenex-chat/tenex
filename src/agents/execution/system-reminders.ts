import type { SystemReminderDescriptor } from "ai-sdk-system-reminders";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { agentTodosFragment } from "@/prompts/fragments/06-agent-todos";
import { getIdentityService } from "@/services/identity";
import type {
    CompletedDelegation,
    PendingDelegation,
} from "@/services/ral/types";

export interface TenexReminderData {
    agent: AgentInstance;
    conversation: ConversationStore;
    respondingToPrincipal: PrincipalRef;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    conversationsContent?: string;
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

    const identityService = getIdentityService();
    const respondingToName = await identityService.getDisplayName({
        principalId: data.respondingToPrincipal.id,
        linkedPubkey: data.respondingToPrincipal.linkedPubkey,
        displayName: data.respondingToPrincipal.displayName,
        username: data.respondingToPrincipal.username,
        kind: data.respondingToPrincipal.kind,
    });

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

    const identityService = getIdentityService();
    const delegatedAgentNames = await Promise.all(
        allDelegatedPubkeys.map((pubkey) => identityService.getName(pubkey))
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

async function conversationsProvider(
    data: TenexReminderData | undefined
): Promise<SystemReminderDescriptor | null> {
    if (!data?.conversationsContent) return null;
    return { type: "conversations", content: data.conversationsContent };
}

export function initializeReminderProviders(): void {
    const ctx = getSystemReminderContext();
    ctx.registerProvider("todo-list", todoListProvider);
    ctx.registerProvider("response-routing", responseRoutingProvider);
    ctx.registerProvider("delegations", delegationsProvider);
    ctx.registerProvider("conversations", conversationsProvider);
}

export function updateReminderData(data: TenexReminderData): void {
    getSystemReminderContext().setProviderData(data);
}

export function resetSystemReminders(): void {
    getSystemReminderContext().clear();
}

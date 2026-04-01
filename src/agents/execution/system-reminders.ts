import type { SystemReminderDescriptor } from "ai-sdk-system-reminders";
import { combineSystemReminders } from "ai-sdk-system-reminders";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { getIdentityService } from "@/services/identity";
import type {
    CompletedDelegation,
    PendingDelegation,
    TodoItem,
} from "@/services/ral/types";
import type { Span } from "@opentelemetry/api";
import type { ModelMessage } from "ai";

export interface TenexReminderData {
    agent: AgentInstance;
    conversation: ConversationStore;
    respondingToPrincipal: PrincipalRef;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    conversationsContent?: string;
}

// ---------------------------------------------------------------------------
// Todo formatting (inlined from removed 06-agent-todos fragment)
// ---------------------------------------------------------------------------

const STATUS_MARKER: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    done: "[x]",
    skipped: "[-]",
};

function formatTodoItem(item: TodoItem): string {
    let line = `${STATUS_MARKER[item.status]} ${item.title} (id: ${item.id})`;
    if (item.status === "skipped" && item.skipReason) {
        line += ` (skipped: ${item.skipReason})`;
    }
    return line;
}

function formatTodos(todos: TodoItem[]): string {
    if (todos.length === 0) return "";

    const parts: string[] = [];
    const pending = todos.filter((t) => t.status === "pending");
    const inProgress = todos.filter((t) => t.status === "in_progress");
    const done = todos.filter((t) => t.status === "done");
    const skipped = todos.filter((t) => t.status === "skipped");

    parts.push("<agent-todos>");
    parts.push("");
    parts.push(
        `Status: ${pending.length} pending, ${inProgress.length} in progress, ${done.length} done, ${skipped.length} skipped`
    );
    parts.push("");

    for (const todo of todos) {
        parts.push(formatTodoItem(todo));
    }

    parts.push("");
    parts.push("**Instructions:**");
    parts.push(
        "- Use `todo_write` to mark items as 'in_progress' when starting, 'done' when complete"
    );
    parts.push("- If skipping an item, set status='skipped' and provide a skip_reason");
    parts.push("- Items with 'pending' status have not been started and require attention");

    if (pending.length > 0) {
        parts.push("");
        parts.push(
            `**ATTENTION:** You have ${pending.length} pending todo item(s) that need to be addressed.`
        );
    }

    parts.push("</agent-todos>");
    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function todoListProvider(
    data: TenexReminderData | undefined
): Promise<SystemReminderDescriptor | null> {
    if (!data) return null;

    const todos = data.conversation.getTodos(data.agent.pubkey);
    const todoContent = formatTodos(todos);
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

export async function collectAndInjectSystemReminders(
    messages: ModelMessage[],
    span: Span | undefined
): Promise<ModelMessage[]> {
    const ctx = getSystemReminderContext();
    const reminders = await ctx.collect();

    if (reminders.length === 0) return messages;

    const combinedXml = combineSystemReminders(reminders);
    if (combinedXml === "") return messages;

    span?.addEvent("system-reminders.applied", {
        "reminders.count": reminders.length,
        "reminders.types": reminders.map((r) => r.type).join(","),
        "reminders.content": combinedXml,
    });

    const result = [...messages];
    for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i];
        if (msg.role === "system") {
            result[i] = {
                ...msg,
                content: `${msg.content}\n\n${combinedXml}`,
            };
            return result;
        }
    }

    result.unshift({ role: "system", content: combinedXml });
    return result;
}

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
import type { ModelMessage, UserModelMessage } from "ai";

export interface TenexReminderData {
    agent: AgentInstance;
    conversation: ConversationStore;
    respondingToPrincipal: PrincipalRef;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    conversationsContent?: string;
}

// ---------------------------------------------------------------------------
// Delta state management
// ---------------------------------------------------------------------------

type DeltaRenderResult = SystemReminderDescriptor | null | "full";

interface DeltaProviderConfig<TSnapshot> {
    type: string;
    fullInterval: number;
    snapshot: (data: TenexReminderData) => TSnapshot | Promise<TSnapshot>;
    renderFull: (
        snapshot: TSnapshot,
        data: TenexReminderData
    ) => SystemReminderDescriptor | null | Promise<SystemReminderDescriptor | null>;
    renderDelta: (
        prev: TSnapshot,
        curr: TSnapshot,
        data: TenexReminderData
    ) => DeltaRenderResult | Promise<DeltaRenderResult>;
}

interface DeltaState {
    snapshot: unknown;
    turnsSinceFullState: number;
}

const deltaStateStore = new Map<string, DeltaState>();

interface ProviderTelemetry {
    type: string;
    mode: "full" | "delta" | "skip";
    contentLength: number;
}

const deltaTelemetry: ProviderTelemetry[] = [];

function createDeltaProvider<TSnapshot>(
    config: DeltaProviderConfig<TSnapshot>
): (data: TenexReminderData | undefined) => Promise<SystemReminderDescriptor | null> {
    return async (data) => {
        if (!data) return null;

        const stateKey = `${data.conversation.getId()}:${config.type}`;
        const currentSnapshot = await config.snapshot(data);
        const prevState = deltaStateStore.get(stateKey);

        // First turn or periodic full refresh
        if (!prevState || prevState.turnsSinceFullState >= config.fullInterval) {
            const result = await config.renderFull(currentSnapshot, data);
            deltaStateStore.set(stateKey, { snapshot: currentSnapshot, turnsSinceFullState: 0 });
            deltaTelemetry.push({
                type: config.type,
                mode: "full",
                contentLength: result?.content.length ?? 0,
            });
            return result;
        }

        const deltaResult = await config.renderDelta(
            prevState.snapshot as TSnapshot,
            currentSnapshot,
            data
        );

        if (deltaResult === null) {
            prevState.turnsSinceFullState++;
            deltaTelemetry.push({ type: config.type, mode: "skip", contentLength: 0 });
            return null;
        }

        if (deltaResult === "full") {
            const result = await config.renderFull(currentSnapshot, data);
            deltaStateStore.set(stateKey, { snapshot: currentSnapshot, turnsSinceFullState: 0 });
            deltaTelemetry.push({
                type: config.type,
                mode: "full",
                contentLength: result?.content.length ?? 0,
            });
            return result;
        }

        deltaStateStore.set(stateKey, {
            snapshot: currentSnapshot,
            turnsSinceFullState: prevState.turnsSinceFullState + 1,
        });
        deltaTelemetry.push({
            type: config.type,
            mode: "delta",
            contentLength: deltaResult.content.length,
        });
        return deltaResult;
    };
}

// ---------------------------------------------------------------------------
// Todo formatting
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
// Provider factories
// ---------------------------------------------------------------------------

const DATETIME_BUCKET_MS = 5 * 60 * 1000;

function createDatetimeProvider() {
    return createDeltaProvider<string>({
        type: "datetime",
        fullInterval: 15,
        snapshot: () => {
            const now = new Date(
                Math.floor(Date.now() / DATETIME_BUCKET_MS) * DATETIME_BUCKET_MS
            );
            const hours = now.getUTCHours();
            const minutes = now.getUTCMinutes().toString().padStart(2, "0");
            const period = hours >= 12 ? "pm" : "am";
            const hour12 = hours % 12 || 12;
            const date = now.toISOString().slice(0, 10);
            return `now: ${date} ${hour12}.${minutes}${period} UTC`;
        },
        renderFull: (snapshot) => ({ type: "datetime", content: snapshot }),
        renderDelta: (prev, curr) => (prev === curr ? null : "full"),
    });
}

interface TodoSnapshot {
    id: string;
    title: string;
    status: string;
}

function createTodoListProvider() {
    return createDeltaProvider<TodoSnapshot[]>({
        type: "todo-list",
        fullInterval: 6,
        snapshot: (data) => {
            const todos = data.conversation.getTodos(data.agent.pubkey);
            return todos.map((t) => ({ id: t.id, title: t.title, status: t.status }));
        },
        renderFull: (_snapshot, data) => {
            const todos = data.conversation.getTodos(data.agent.pubkey);
            const content = formatTodos(todos);
            return content ? { type: "todo-list", content } : null;
        },
        renderDelta: (prev, curr) => {
            if (curr.length === 0 && prev.length === 0) return null;

            const prevMap = new Map(prev.map((t) => [t.id, t]));
            const currMap = new Map(curr.map((t) => [t.id, t]));
            const changes: string[] = [];

            for (const t of curr) {
                if (!prevMap.has(t.id)) {
                    changes.push(`New: ${STATUS_MARKER[t.status]} ${t.title} (id: ${t.id})`);
                }
            }

            for (const t of prev) {
                if (!currMap.has(t.id)) {
                    changes.push(`Removed: ${t.title} (id: ${t.id})`);
                }
            }

            for (const t of curr) {
                const prevItem = prevMap.get(t.id);
                if (prevItem && prevItem.status !== t.status) {
                    changes.push(
                        `${t.title} (id: ${t.id}): ${prevItem.status} → ${t.status}`
                    );
                }
            }

            if (changes.length === 0) return null;

            const pending = curr.filter((t) => t.status === "pending");
            const parts = ["<agent-todos-update>", "", ...changes];
            if (pending.length > 0) {
                parts.push("", `**ATTENTION:** You have ${pending.length} pending todo item(s).`);
            }
            parts.push("", "</agent-todos-update>");

            return { type: "todo-list", content: parts.join("\n") };
        },
    });
}

function createResponseRoutingProvider() {
    return createDeltaProvider<string>({
        type: "response-routing",
        fullInterval: 12,
        snapshot: (data) => data.respondingToPrincipal.id,
        renderFull: async (_snapshot, data) => {
            const identityService = getIdentityService();
            const respondingToName = await identityService.getDisplayName({
                principalId: data.respondingToPrincipal.id,
                linkedPubkey: data.respondingToPrincipal.linkedPubkey,
                displayName: data.respondingToPrincipal.displayName,
                username: data.respondingToPrincipal.username,
                kind: data.respondingToPrincipal.kind,
            });

            const isSelfDelegation =
                data.respondingToPrincipal.linkedPubkey === data.agent.pubkey;
            const content = isSelfDelegation
                ? `Your response will be sent to @${respondingToName}. Note: this is a self-delegation — you are executing a task delegated by a parent instance of yourself.`
                : `Your response will be sent to @${respondingToName}.`;

            return { type: "response-routing", content };
        },
        renderDelta: (prev, curr) => (prev === curr ? null : "full"),
    });
}

function createDelegationsProvider() {
    return createDeltaProvider<string>({
        type: "delegations",
        fullInterval: 8,
        snapshot: (data) => {
            const allPubkeys = [
                ...data.pendingDelegations.map((d) => d.recipientPubkey),
                ...data.completedDelegations.map((d) => d.recipientPubkey),
            ];
            return [...new Set(allPubkeys)].sort().join(",");
        },
        renderFull: async (_snapshot, data) => {
            const allDelegatedPubkeys = [
                ...data.pendingDelegations.map((d) => d.recipientPubkey),
                ...data.completedDelegations.map((d) => d.recipientPubkey),
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
        },
        renderDelta: (prev, curr) => (prev === curr ? null : "full"),
    });
}

function createConversationsProvider() {
    return createDeltaProvider<string>({
        type: "conversations",
        fullInterval: 5,
        snapshot: (data) => data.conversationsContent ?? "",
        renderFull: (_snapshot, data) => {
            if (!data.conversationsContent) return null;
            return { type: "conversations", content: data.conversationsContent };
        },
        renderDelta: (prev, curr) => (prev === curr ? null : "full"),
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initializeReminderProviders(): void {
    const ctx = getSystemReminderContext();
    ctx.registerProvider("datetime", createDatetimeProvider());
    ctx.registerProvider("todo-list", createTodoListProvider());
    ctx.registerProvider("response-routing", createResponseRoutingProvider());
    ctx.registerProvider("delegations", createDelegationsProvider());
    ctx.registerProvider("conversations", createConversationsProvider());
}

export function updateReminderData(data: TenexReminderData): void {
    getSystemReminderContext().setProviderData(data);
}

export function resetSystemReminders(): void {
    getSystemReminderContext().clear();
    deltaStateStore.clear();
    deltaTelemetry.length = 0;
}

export async function collectAndInjectSystemReminders(
    messages: ModelMessage[],
    span: Span | undefined
): Promise<ModelMessage[]> {
    deltaTelemetry.length = 0;
    const ctx = getSystemReminderContext();
    const reminders = await ctx.collect();

    // Log delta telemetry
    if (span && deltaTelemetry.length > 0) {
        const emitted = deltaTelemetry.filter((t) => t.mode !== "skip");
        const skipped = deltaTelemetry.filter((t) => t.mode === "skip");
        span.addEvent("system-reminders.delta-stats", {
            "delta.providers": deltaTelemetry.map((t) => `${t.type}:${t.mode}`).join(","),
            "delta.emitted": emitted.length,
            "delta.skipped": skipped.length,
            "delta.skippedTypes": skipped.map((t) => t.type).join(","),
        });
    }

    if (reminders.length === 0) return messages;

    const combinedXml = combineSystemReminders(reminders);
    if (combinedXml === "") return messages;

    span?.addEvent("system-reminders.applied", {
        "reminders.count": reminders.length,
        "reminders.types": reminders.map((r) => r.type).join(","),
        "reminders.content": combinedXml,
    });

    const result = [...messages];

    // Inject into the last user message, matching the ai-sdk-system-reminders convention
    for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i];
        if (msg.role !== "user") continue;

        const userMsg = msg as UserModelMessage;
        if (typeof userMsg.content === "string") {
            result[i] = { ...userMsg, content: `${userMsg.content}\n\n${combinedXml}` };
        } else {
            const parts = userMsg.content.map((p) => ({ ...p }));
            let injected = false;
            for (let j = parts.length - 1; j >= 0; j--) {
                const part = parts[j];
                if (part.type === "text") {
                    parts[j] = { ...part, text: `${part.text}\n\n${combinedXml}` };
                    injected = true;
                    break;
                }
            }
            if (!injected) {
                parts.push({ type: "text" as const, text: combinedXml });
            }
            result[i] = { ...userMsg, content: parts };
        }
        return result;
    }

    // No user message found — append one
    result.push({ role: "user", content: combinedXml });
    return result;
}

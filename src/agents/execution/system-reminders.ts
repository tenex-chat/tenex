import type {
    ReminderDescriptor,
    ReminderPlacement,
    ReminderPlacementPolicy,
    ReminderProvider,
    ReminderProviderDeltaResult,
    ReminderState,
    ReminderStateStore,
} from "ai-sdk-context-management";
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
import type { SkillData, SkillToolPermissions } from "@/services/skill";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { homedir } from "node:os";
import type { ProjectDTag } from "@/types/project-ids";
import { renderLoadedSkillsBlock } from "./skill-reminder-renderers";
import {
    buildConversationsReminderSnapshot,
    renderConversationsReminderDelta,
    renderConversationsReminderFromSnapshot,
    type ConversationsReminderSnapshot,
} from "@/prompts/reminders/conversations";

function cloneReminderState(state: ReminderState | undefined): ReminderState | undefined {
    return state ? structuredClone(state) : undefined;
}

function buildReminderPathVars(data: TenexReminderData): Record<string, string> {
    const vars: Record<string, string> = {
        "$USER_HOME": homedir(),
        "$AGENT_HOME": getAgentHomeDirectory(data.agent.pubkey),
    };
    if (data.projectPath) {
        vars["$PROJECT_BASE"] = data.projectPath;
    }
    return vars;
}

function getDelegationIdsAlreadyRepresentedInConversation(
    data: TenexReminderData
): Set<string> {
    const representedIds = new Set<string>();

    for (const message of data.conversation.getAllMessages()) {
        if (message.messageType !== "delegation-marker") {
            continue;
        }

        const marker = message.delegationMarker;
        if (!marker?.delegationConversationId) {
            continue;
        }

        const isTargetedToCurrentAgent =
            message.targetedPubkeys?.includes(data.agent.pubkey)
            || message.pubkey === data.agent.pubkey;

        if (!isTargetedToCurrentAgent) {
            continue;
        }

        representedIds.add(marker.delegationConversationId);
    }

    return representedIds;
}

function getDelegationIdsRepresentedByTrailingToolResults(
    data: TenexReminderData
): string[] {
    const representedIds: string[] = [];
    const messages = data.conversation.getAllMessages();

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const isFromCurrentAgent = message.pubkey === data.agent.pubkey;

        if (
            isFromCurrentAgent
            && message.messageType === "tool-result"
            && Array.isArray(message.toolData)
        ) {
            for (const part of message.toolData) {
                if (
                    part.type !== "tool-result"
                    || !part.output
                    || part.output.type !== "json"
                    || typeof part.output.value !== "object"
                    || !part.output.value
                ) {
                    continue;
                }

                const maybeDelegationId = (part.output.value as Record<string, unknown>).delegationConversationId;
                if (typeof maybeDelegationId === "string" && maybeDelegationId.trim().length > 0) {
                    representedIds.push(maybeDelegationId.trim());
                }
            }
            continue;
        }

        if (isFromCurrentAgent && message.messageType === "tool-call") {
            continue;
        }

        break;
    }

    return representedIds;
}

function isDelegationAlreadyRepresented(
    delegationConversationId: string,
    representedIds: Iterable<string>
): boolean {
    for (const representedId of representedIds) {
        if (
            representedId === delegationConversationId
            || delegationConversationId.startsWith(representedId)
            || representedId.startsWith(delegationConversationId)
        ) {
            return true;
        }
    }

    return false;
}

export interface TenexReminderData {
    agent: AgentInstance;
    conversation: ConversationStore;
    respondingToPrincipal: PrincipalRef;
    pendingDelegations: PendingDelegation[];
    completedDelegations: CompletedDelegation[];
    projectId?: ProjectDTag;
    loadedSkills: SkillData[];
    skillToolPermissions?: SkillToolPermissions;
    projectPath?: string;
}

export function createTenexReminderPlacementPolicy(options: {
    conversationStore: ConversationStore;
    agentPubkey: string;
}): ReminderPlacementPolicy<TenexReminderData> {
    return ({ defaultPlacement }) => {
        if (defaultPlacement !== "latest-user-append") {
            return defaultPlacement;
        }

        return options.conversationStore.isAgentPromptHistoryCacheAnchored(options.agentPubkey)
            ? "latest-user-append"
            : "fallback-system";
    };
}

type DeltaProviderConfig<TSnapshot> = {
    type: string;
    fullInterval: number;
    placement?:
        | ReminderPlacement
        | ((data: TenexReminderData | undefined) => ReminderPlacement);
    emptySnapshot: TSnapshot;
    snapshot: (data: TenexReminderData) => TSnapshot | Promise<TSnapshot>;
    renderFull: (
        snapshot: TSnapshot,
        data: TenexReminderData
    ) => ReminderDescriptor | null | Promise<ReminderDescriptor | null>;
    renderDelta: (
        previous: TSnapshot,
        current: TSnapshot,
        data: TenexReminderData
    ) => ReminderProviderDeltaResult | Promise<ReminderProviderDeltaResult>;
};

function createDeltaProvider<TSnapshot>(
    config: DeltaProviderConfig<TSnapshot>
): ReminderProvider<TenexReminderData, TSnapshot> {
    return {
        type: config.type,
        fullInterval: config.fullInterval,
        placement: ({ data }) =>
            typeof config.placement === "function"
                ? config.placement(data)
                : config.placement ?? "overlay-user",
        snapshot: async (data) => {
            if (!data) {
                return structuredClone(config.emptySnapshot);
            }
            return await config.snapshot(data);
        },
        renderFull: async (snapshot, data) => {
            if (!data) {
                return null;
            }
            return await config.renderFull(snapshot, data);
        },
        renderDelta: async (previous, current, data) => {
            if (!data) {
                return null;
            }
            return await config.renderDelta(previous, current, data);
        },
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

function createDatetimeProvider(): ReminderProvider<TenexReminderData, string> {
    return createDeltaProvider<string>({
        type: "datetime",
        fullInterval: 15,
        placement: "latest-user-append",
        emptySnapshot: "",
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
        renderFull: (snapshot) => snapshot ? { type: "datetime", content: snapshot } : null,
        renderDelta: (previous, current) => (previous === current ? null : "full"),
    });
}

interface TodoSnapshot {
    id: string;
    title: string;
    status: string;
}

function createTodoListProvider(): ReminderProvider<TenexReminderData, TodoSnapshot[]> {
    return createDeltaProvider<TodoSnapshot[]>({
        type: "todo-list",
        fullInterval: 6,
        placement: "latest-user-append",
        emptySnapshot: [],
        snapshot: (data) => {
            const todos = data.conversation.getTodos(data.agent.pubkey);
            return todos.map((todo) => ({ id: todo.id, title: todo.title, status: todo.status }));
        },
        renderFull: (_snapshot, data) => {
            const todos = data.conversation.getTodos(data.agent.pubkey);
            const content = formatTodos(todos);
            return content ? { type: "todo-list", content } : null;
        },
        renderDelta: (previous, current) => {
            if (current.length === 0 && previous.length === 0) {
                return null;
            }

            const previousById = new Map(previous.map((todo) => [todo.id, todo]));
            const currentById = new Map(current.map((todo) => [todo.id, todo]));
            const changes: string[] = [];

            for (const todo of current) {
                if (!previousById.has(todo.id)) {
                    changes.push(`New: ${STATUS_MARKER[todo.status]} ${todo.title} (id: ${todo.id})`);
                }
            }

            for (const todo of previous) {
                if (!currentById.has(todo.id)) {
                    changes.push(`Removed: ${todo.title} (id: ${todo.id})`);
                }
            }

            for (const todo of current) {
                const previousTodo = previousById.get(todo.id);
                if (previousTodo && previousTodo.status !== todo.status) {
                    changes.push(`${todo.title} (id: ${todo.id}): ${previousTodo.status} → ${todo.status}`);
                }
            }

            if (changes.length === 0) {
                return null;
            }

            const pending = current.filter((todo) => todo.status === "pending");
            const parts = ["<agent-todos-update>", "", ...changes];
            if (pending.length > 0) {
                parts.push("", `**ATTENTION:** You have ${pending.length} pending todo item(s).`);
            }
            parts.push("", "</agent-todos-update>");

            return { type: "todo-list", content: parts.join("\n") };
        },
    });
}

function createResponseRoutingProvider(): ReminderProvider<TenexReminderData, string> {
    return createDeltaProvider<string>({
        type: "response-routing",
        fullInterval: 12,
        placement: "latest-user-append",
        emptySnapshot: "",
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
        renderDelta: (previous, current) => (previous === current ? null : "full"),
    });
}

function createDelegationsProvider(): ReminderProvider<TenexReminderData, string> {
    return createDeltaProvider<string>({
        type: "delegations",
        fullInterval: 8,
        placement: "latest-user-append",
        emptySnapshot: "",
        snapshot: (data) => {
            const allPubkeys = [
                ...data.pendingDelegations.map((delegation) => delegation.recipientPubkey),
                ...data.completedDelegations.map((delegation) => delegation.recipientPubkey),
            ];
            return [...new Set(allPubkeys)].sort().join(",");
        },
        renderFull: async (_snapshot, data) => {
            const markerRepresentedDelegationIds =
                getDelegationIdsAlreadyRepresentedInConversation(data);
            const trailingToolResultDelegationIds =
                getDelegationIdsRepresentedByTrailingToolResults(data);
            const pendingDelegations = data.pendingDelegations.filter(
                (delegation) =>
                    !isDelegationAlreadyRepresented(
                        delegation.delegationConversationId,
                        markerRepresentedDelegationIds
                    )
                    && !isDelegationAlreadyRepresented(
                        delegation.delegationConversationId,
                        trailingToolResultDelegationIds
                    )
            );
            const completedDelegations = data.completedDelegations.filter(
                (delegation) =>
                    !isDelegationAlreadyRepresented(
                        delegation.delegationConversationId,
                        markerRepresentedDelegationIds
                    )
            );
            const allDelegatedPubkeys = [
                ...pendingDelegations.map((delegation) => delegation.recipientPubkey),
                ...completedDelegations.map((delegation) => delegation.recipientPubkey),
            ];

            if (allDelegatedPubkeys.length === 0) {
                return null;
            }

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
        renderDelta: (previous, current) => (previous === current ? null : "full"),
    });
}

const CONVERSATIONS_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

interface ConversationsSnapshotWithTimestamp {
    timeBucket: number;
    snapshot: ConversationsReminderSnapshot;
}

function createConversationsProvider(): ReminderProvider<TenexReminderData, ConversationsSnapshotWithTimestamp> {
    return createDeltaProvider<ConversationsSnapshotWithTimestamp>({
        type: "conversations",
        fullInterval: 10,
        placement: "latest-user-append",
        emptySnapshot: {
            timeBucket: 0,
            snapshot: {
                active: [],
                recent: [],
            },
        },
        snapshot: (data) => {
            const timeBucket = Math.floor(Date.now() / CONVERSATIONS_BUCKET_MS);
            const snapshot = buildConversationsReminderSnapshot({
                agentPubkey: data.agent.pubkey,
                currentConversationId: data.conversation.getId(),
                projectId: data.projectId,
            });
            return { timeBucket, snapshot };
        },
        renderFull: (_snapshotWithTime, _data) => {
            const content = renderConversationsReminderFromSnapshot(_snapshotWithTime.snapshot);
            return content ? { type: "conversations", content } : null;
        },
        renderDelta: (previous, current) => {
            // Only render if at least 5 minutes have elapsed since last update
            if (previous.timeBucket === current.timeBucket) {
                return null;
            }

            const content = renderConversationsReminderDelta(previous.snapshot, current.snapshot);
            return content ? { type: "conversations", content } : null;
        },
    });
}

function createLoadedSkillsProvider(): ReminderProvider<TenexReminderData, string> {
    return {
        type: "loaded-skills",
        fullInterval: 10,
        placement: "latest-user-append",
        snapshot: async (data) => {
            if (!data) {
                return "";
            }
            const skillParts = data.loadedSkills
                .map((skill) => `${skill.identifier}:${skill.content.length}`)
                .sort()
                .join("|");
            const permissionParts = data.skillToolPermissions
                ? JSON.stringify(data.skillToolPermissions)
                : "";
            return `${skillParts}||${permissionParts}`;
        },
        renderFull: async (_snapshot, data) => {
            if (!data) {
                return null;
            }
            const content = renderLoadedSkillsBlock(
                data.loadedSkills,
                data.skillToolPermissions,
                buildReminderPathVars(data)
            );
            return content ? { type: "loaded-skills", content } : null;
        },
        renderDelta: async (previous, current) => (previous === current ? null : "full"),
    };
}

export function createTenexReminderProviders(): ReminderProvider<TenexReminderData, unknown>[] {
    return [
        createDatetimeProvider(),
        createTodoListProvider(),
        createResponseRoutingProvider(),
        createDelegationsProvider(),
        createConversationsProvider(),
        createLoadedSkillsProvider(),
    ];
}

export function createTenexReminderStateStore(options: {
    conversationStore: ConversationStore;
}): ReminderStateStore {
    return {
        get: ({ agentId }) => {
            if (!options.conversationStore.isAgentPromptHistoryCacheAnchored(agentId)) {
                return undefined;
            }

            return cloneReminderState(
                options.conversationStore.getContextManagementReminderState(agentId)
            );
        },
        set: ({ agentId }, state) => {
            if (!options.conversationStore.isAgentPromptHistoryCacheAnchored(agentId)) {
                options.conversationStore.clearContextManagementReminderState(agentId);
                return;
            }

            options.conversationStore.setContextManagementReminderState(
                agentId,
                structuredClone(state)
            );
        },
    };
}

export function resetSystemReminders(): void {
    getSystemReminderContext().clear();
}

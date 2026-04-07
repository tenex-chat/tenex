/**
 * ConversationStore - Single source of truth for conversation state
 *
 * This class manages persistent storage of conversation messages, RAL lifecycle,
 * and message visibility rules. Nostr events hydrate the store, and the store
 * is used to build messages for agent execution.
 *
 * Static methods delegate to ConversationRegistry singleton for global management.
 * Instance methods handle individual conversation state.
 *
 * File location: ~/.tenex/projects/{projectId}/conversations/{conversationId}.json
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { ReminderState } from "ai-sdk-context-management";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";
import type { TodoItem } from "@/services/ral/types";
import { ConversationCatalogService } from "./ConversationCatalogService";
import { buildPromptMessagesFromRecords } from "./PromptBuilder";
import { getConversationRecordAuthorPubkey } from "./record-author";
import { ensureConversationRecord } from "./record-id";
import { conversationRegistry } from "./ConversationRegistry";
import { normalizeScratchpadEntries } from "./utils/normalize-scratchpad-entries";
import type {
    AgentPromptHistoryState,
    ContextManagementCompactionAnchor,
    ContextManagementCompactionEdit,
    ContextManagementCompactionEntry,
    ContextManagementCompactionState,
    ConversationRecordInput,
    ConversationRecord,
    ConversationMetadata,
    ConversationState,
    ContextManagementScratchpadEntry,
    ContextManagementScratchpadState,
    DelegationMarker,
    ExecutionTime,
    FrozenPromptMessage,
    Injection,
    MessagePrincipalContext,
    PerAgentReminderDeltaState,
    PrincipalSnapshot,
} from "./types";
import { logger } from "@/utils/logger";
import type { FullEventId } from "@/types/event-ids";
import type { ProjectDTag } from "@/types/project-ids";
import { ActiveRalIndex } from "./ActiveRalIndex";

interface BuildMessagesOptions {
    includeMessageIds?: boolean;
    inFlightToolCallIds?: Set<string>;
}

/**
 * Type alias for conversation IDs accepted by ConversationStore methods.
 * Accepts both typed FullEventId and plain strings for backward compatibility.
 */
export type ConversationIdInput = string | FullEventId;

// Re-export types for convenience
export type {
    ConversationRecordInput,
    ConversationRecord,
    ConversationMetadata,
    Injection,
} from "./types";

function normalizeLoadedMessages(messages: ConversationRecordInput[]): ConversationRecord[] {
    return messages.map((message, index) => ensureConversationRecord(message, index));
}

function normalizeLoadedMetadata(
    metadata: ConversationMetadata | Record<string, unknown> | undefined
): ConversationMetadata {
    if (!metadata || typeof metadata !== "object") {
        return {};
    }

    const {
        last_user_message: legacyLastUserMessage,
        ...rest
    } = metadata as ConversationMetadata & { last_user_message?: unknown };

    const lastUserMessage = typeof metadata.lastUserMessage === "string"
        ? metadata.lastUserMessage
        : typeof legacyLastUserMessage === "string"
            ? legacyLastUserMessage
            : undefined;

    return {
        ...(rest as ConversationMetadata),
        ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
    };
}

function normalizeContextManagementScratchpadState(
    state: ContextManagementScratchpadState | Record<string, unknown> | undefined
): ContextManagementScratchpadState | undefined {
    if (!state) {
        return undefined;
    }

    const rawState = state as Record<string, unknown>;
    const rawEntries = typeof rawState.entries === "object" && rawState.entries !== null
        ? rawState.entries as Record<string, unknown>
        : undefined;
    const legacyNotes = typeof rawState.notes === "string" ? rawState.notes : undefined;
    const entries = normalizeScratchpadEntries(rawEntries)
        ?? normalizeScratchpadEntries(legacyNotes ? { notes: legacyNotes } : undefined);
    const rawPreserveTurns = typeof rawState.preserveTurns === "number"
        ? rawState.preserveTurns
        : rawState.keepLastMessages;
    const preserveTurns = typeof rawPreserveTurns === "number"
        && Number.isFinite(rawPreserveTurns)
        ? Math.max(0, Math.floor(rawPreserveTurns))
        : undefined;
    const rawActiveNotice = typeof rawState.activeNotice === "object" && rawState.activeNotice !== null
        ? rawState.activeNotice as Record<string, unknown>
        : undefined;
    const activeNotice = rawActiveNotice
        && typeof rawActiveNotice.description === "string"
        && rawActiveNotice.description.trim().length > 0
        && typeof rawActiveNotice.toolCallId === "string"
        && rawActiveNotice.toolCallId.trim().length > 0
        && typeof rawActiveNotice.rawTurnCountAtCall === "number"
        && Number.isFinite(rawActiveNotice.rawTurnCountAtCall)
        && typeof rawActiveNotice.projectedTurnCountAtCall === "number"
        && Number.isFinite(rawActiveNotice.projectedTurnCountAtCall)
        ? {
            description: rawActiveNotice.description.trim(),
            toolCallId: rawActiveNotice.toolCallId.trim(),
            rawTurnCountAtCall: Math.max(0, Math.floor(rawActiveNotice.rawTurnCountAtCall)),
            projectedTurnCountAtCall: Math.max(
                0,
                Math.floor(rawActiveNotice.projectedTurnCountAtCall)
            ),
        }
        : undefined;
    const agentLabel = typeof rawState.agentLabel === "string" && rawState.agentLabel.trim().length > 0
        ? rawState.agentLabel
        : undefined;
    const updatedAt = typeof rawState.updatedAt === "number" ? rawState.updatedAt : undefined;

    return {
        ...(entries ? { entries } : {}),
        ...(preserveTurns !== undefined ? { preserveTurns } : {}),
        ...(activeNotice ? { activeNotice } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(agentLabel ? { agentLabel } : {}),
    };
}

function normalizeLoadedContextManagementScratchpads(
    scratchpads: Record<string, ContextManagementScratchpadState> | undefined
): Record<string, ContextManagementScratchpadState> {
    return Object.fromEntries(
        Object.entries(scratchpads ?? {}).flatMap(([agentId, state]) => {
            const normalizedState = normalizeContextManagementScratchpadState(state);
            return normalizedState ? [[agentId, normalizedState] as const] : [];
        })
    );
}

function normalizeContextManagementCompactionAnchor(
    anchor: ContextManagementCompactionAnchor | Record<string, unknown> | undefined
): ContextManagementCompactionAnchor | undefined {
    if (!anchor || typeof anchor !== "object") {
        return undefined;
    }

    const rawAnchor = anchor as Record<string, unknown>;
    const normalizedAnchor = {
        ...(typeof rawAnchor.sourceRecordId === "string" && rawAnchor.sourceRecordId.trim().length > 0
            ? { sourceRecordId: rawAnchor.sourceRecordId.trim() }
            : {}),
        ...(typeof rawAnchor.eventId === "string" && rawAnchor.eventId.trim().length > 0
            ? { eventId: rawAnchor.eventId.trim() }
            : {}),
        ...(typeof rawAnchor.messageId === "string" && rawAnchor.messageId.trim().length > 0
            ? { messageId: rawAnchor.messageId.trim() }
            : {}),
    } satisfies ContextManagementCompactionAnchor;

    return normalizedAnchor.sourceRecordId || normalizedAnchor.eventId || normalizedAnchor.messageId
        ? normalizedAnchor
        : undefined;
}

function normalizeContextManagementCompactionEdit(
    edit: ContextManagementCompactionEdit | Record<string, unknown> | undefined
): ContextManagementCompactionEdit | undefined {
    if (!edit || typeof edit !== "object") {
        return undefined;
    }

    const rawEdit = edit as Record<string, unknown>;
    const id = typeof rawEdit.id === "string" && rawEdit.id.trim().length > 0
        ? rawEdit.id.trim()
        : undefined;
    const source = rawEdit.source === "manual" || rawEdit.source === "auto"
        ? rawEdit.source
        : undefined;
    const start = normalizeContextManagementCompactionAnchor(
        rawEdit.start as ContextManagementCompactionAnchor | Record<string, unknown> | undefined
    );
    const end = normalizeContextManagementCompactionAnchor(
        rawEdit.end as ContextManagementCompactionAnchor | Record<string, unknown> | undefined
    );
    const replacement = typeof rawEdit.replacement === "string"
        ? rawEdit.replacement.trim()
        : "";
    const createdAt = typeof rawEdit.createdAt === "number" && Number.isFinite(rawEdit.createdAt)
        ? rawEdit.createdAt
        : undefined;
    const compactedMessageCount = typeof rawEdit.compactedMessageCount === "number"
        && Number.isFinite(rawEdit.compactedMessageCount)
        ? Math.max(0, Math.floor(rawEdit.compactedMessageCount))
        : undefined;

    if (!id || !source || !start || !end || replacement.length === 0 || createdAt === undefined || compactedMessageCount === undefined) {
        return undefined;
    }

    return {
        id,
        source,
        start,
        end,
        replacement,
        createdAt,
        compactedMessageCount,
        ...(typeof rawEdit.steeringMessage === "string" && rawEdit.steeringMessage.trim().length > 0
            ? { steeringMessage: rawEdit.steeringMessage.trim() }
            : {}),
        ...(typeof rawEdit.fromText === "string" && rawEdit.fromText.trim().length > 0
            ? { fromText: rawEdit.fromText.trim() }
            : {}),
        ...(typeof rawEdit.toText === "string" && rawEdit.toText.trim().length > 0
            ? { toText: rawEdit.toText.trim() }
            : {}),
    };
}

function normalizeContextManagementCompactionState(
    state: ContextManagementCompactionState | Record<string, unknown> | undefined
): ContextManagementCompactionState | undefined {
    if (!state || typeof state !== "object") {
        return undefined;
    }

    const rawState = state as Record<string, unknown>;
    const edits = Array.isArray(rawState.edits)
        ? rawState.edits.flatMap((edit) => {
            const normalizedEdit = normalizeContextManagementCompactionEdit(
                edit as ContextManagementCompactionEdit | Record<string, unknown>
            );
            return normalizedEdit ? [normalizedEdit] : [];
        })
        : [];

    if (edits.length === 0) {
        return undefined;
    }

    return {
        edits,
        ...(typeof rawState.updatedAt === "number" && Number.isFinite(rawState.updatedAt)
            ? { updatedAt: rawState.updatedAt }
            : {}),
        ...(typeof rawState.agentLabel === "string" && rawState.agentLabel.trim().length > 0
            ? { agentLabel: rawState.agentLabel }
            : {}),
    };
}

function normalizeLoadedContextManagementCompactions(
    compactions: Record<string, ContextManagementCompactionState> | undefined
): Record<string, ContextManagementCompactionState> {
    return Object.fromEntries(
        Object.entries(compactions ?? {}).flatMap(([agentId, state]) => {
            const normalizedState = normalizeContextManagementCompactionState(state);
            return normalizedState ? [[agentId, normalizedState] as const] : [];
        })
    );
}

function createEmptyAgentPromptHistoryState(): AgentPromptHistoryState {
    return {
        messages: [],
        seenMessageIds: [],
        reminderDeltaState: {},
        nextSequence: 0,
    };
}

function isPromptMessageRole(value: unknown): value is FrozenPromptMessage["role"] {
    return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function normalizeReminderDeltaState(
    state: PerAgentReminderDeltaState | Record<string, unknown> | undefined
): PerAgentReminderDeltaState | undefined {
    if (!state || typeof state !== "object") {
        return undefined;
    }

    const raw = state as Record<string, unknown>;
    const turnsSinceFullState = typeof raw.turnsSinceFullState === "number"
        && Number.isFinite(raw.turnsSinceFullState)
        ? Math.max(0, Math.floor(raw.turnsSinceFullState))
        : undefined;

    if (turnsSinceFullState === undefined) {
        return undefined;
    }

    return {
        snapshot: raw.snapshot,
        turnsSinceFullState,
    };
}

function normalizeLoadedReminderDeltaState(
    states: Record<string, PerAgentReminderDeltaState> | undefined
): Record<string, PerAgentReminderDeltaState> {
    return Object.fromEntries(
        Object.entries(states ?? {}).flatMap(([type, state]) => {
            const normalized = normalizeReminderDeltaState(state);
            return normalized ? [[type, normalized] as const] : [];
        })
    );
}

function normalizeReminderState(
    state: ReminderState | Record<string, unknown> | undefined
): ReminderState | undefined {
    if (!state || typeof state !== "object") {
        return undefined;
    }

    const raw = state as Record<string, unknown>;
    const providers = normalizeLoadedReminderDeltaState(
        typeof raw.providers === "object" && raw.providers !== null
            ? raw.providers as Record<string, PerAgentReminderDeltaState>
            : undefined
    );
    const deferred = Array.isArray(raw.deferred)
        ? raw.deferred.filter((reminder): reminder is ReminderState["deferred"][number] => {
            return Boolean(
                reminder
                && typeof reminder === "object"
                && typeof (reminder as { kind?: unknown }).kind === "string"
                && typeof (reminder as { content?: unknown }).content === "string"
            );
        })
        : [];

    return {
        providers,
        deferred: structuredClone(deferred),
    };
}

function buildReminderStatesFromLegacyPromptHistories(
    histories: Record<string, AgentPromptHistoryState>
): Record<string, ReminderState> {
    return Object.fromEntries(
        Object.entries(histories).flatMap(([agentId, history]) => {
            const providers = normalizeLoadedReminderDeltaState(history.reminderDeltaState);
            if (Object.keys(providers).length === 0) {
                return [];
            }

            return [[agentId, {
                providers,
                deferred: [],
            } satisfies ReminderState] as const];
        })
    );
}

function normalizeLoadedReminderStates(
    states: Record<string, ReminderState> | undefined,
    promptHistories: Record<string, AgentPromptHistoryState>
): Record<string, ReminderState> {
    const normalized = Object.fromEntries(
        Object.entries(states ?? {}).flatMap(([agentId, state]) => {
            const normalizedState = normalizeReminderState(state);
            return normalizedState ? [[agentId, normalizedState] as const] : [];
        })
    );

    if (Object.keys(normalized).length > 0) {
        return normalized;
    }

    return buildReminderStatesFromLegacyPromptHistories(promptHistories);
}

function normalizeFrozenPromptMessage(
    message: FrozenPromptMessage | Record<string, unknown>,
    index: number
): FrozenPromptMessage | undefined {
    if (!message || typeof message !== "object") {
        return undefined;
    }

    const raw = message as Record<string, unknown>;
    const role = raw.role;
    const id = typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id
        : `prompt:${index}`;
    const source = typeof raw.source === "object" && raw.source !== null
        ? raw.source as Record<string, unknown>
        : undefined;
    const kind = source?.kind;

    if (!isPromptMessageRole(role)) {
        return undefined;
    }

    if (
        kind !== "canonical"
        && kind !== "runtime-overlay"
    ) {
        if (kind !== "mutable-update") {
            return undefined;
        }
    }

    return {
        id,
        role,
        content: raw.content as FrozenPromptMessage["content"],
        source: {
            kind: kind === "mutable-update" ? "canonical" : kind,
            ...(typeof source?.sourceMessageId === "string"
                ? { sourceMessageId: source.sourceMessageId }
                : {}),
            ...(typeof source?.sourceRecordId === "string"
                ? { sourceRecordId: source.sourceRecordId }
                : {}),
            ...(typeof source?.sourceEventId === "string"
                ? { sourceEventId: source.sourceEventId }
                : {}),
            ...(typeof source?.overlayType === "string"
                ? { overlayType: source.overlayType }
                : {}),
        },
    };
}

function normalizeLoadedAgentPromptHistories(
    histories: Record<string, AgentPromptHistoryState> | undefined
): Record<string, AgentPromptHistoryState> {
    return Object.fromEntries(
        Object.entries(histories ?? {}).map(([agentId, state]) => {
            const rawState = (state ?? {}) as unknown as Record<string, unknown>;
            const messages = Array.isArray(rawState.messages)
                ? rawState.messages.flatMap((message, index) => {
                    const normalized = normalizeFrozenPromptMessage(
                        message as FrozenPromptMessage | Record<string, unknown>,
                        index
                    );
                    return normalized ? [normalized] : [];
                })
                : [];
            const seenMessageIds = Array.from(
                new Set([
                    ...(
                        Array.isArray(rawState.seenMessageIds)
                            ? rawState.seenMessageIds.filter(
                                (messageId): messageId is string =>
                                    typeof messageId === "string" && messageId.length > 0
                            )
                            : []
                    ),
                    ...Object.keys(
                        typeof rawState.sourceVersions === "object" && rawState.sourceVersions !== null
                            ? rawState.sourceVersions as Record<string, unknown>
                            : {}
                    ),
                    ...messages.flatMap((message) =>
                        message.source.kind === "canonical"
                        && typeof message.source.sourceMessageId === "string"
                        && message.source.sourceMessageId.length > 0
                            ? [message.source.sourceMessageId]
                            : []
                    ),
                ])
            );
            const reminderDeltaState = normalizeLoadedReminderDeltaState(
                typeof rawState.reminderDeltaState === "object" && rawState.reminderDeltaState !== null
                    ? rawState.reminderDeltaState as Record<string, PerAgentReminderDeltaState>
                    : undefined
            );
            const nextSequence = typeof rawState.nextSequence === "number"
                && Number.isFinite(rawState.nextSequence)
                ? Math.max(0, Math.floor(rawState.nextSequence))
                : messages.length;

            return [agentId, {
                messages,
                seenMessageIds,
                reminderDeltaState,
                nextSequence,
            }] as const;
        })
    );
}

export class ConversationStore {
    // ========== STATIC METHODS (delegate to registry) ==========

    static initialize(metadataPath: string, agentPubkeys?: Iterable<string>): void {
        conversationRegistry.initialize(metadataPath, agentPubkeys);
    }

    /**
     * Get or load a conversation store by ID.
     * @param conversationId - Full 64-char conversation ID (FullEventId or string)
     */
    static getOrLoad(conversationId: ConversationIdInput): ConversationStore {
        return conversationRegistry.getOrLoad(conversationId);
    }

    /**
     * Get a conversation store if it exists.
     * @param conversationId - Full 64-char conversation ID (FullEventId or string)
     */
    static get(conversationId: ConversationIdInput): ConversationStore | undefined {
        return conversationRegistry.get(conversationId);
    }

    /**
     * Check if a conversation exists.
     * @param conversationId - Full 64-char conversation ID (FullEventId or string)
     */
    static has(conversationId: ConversationIdInput): boolean {
        return conversationRegistry.has(conversationId);
    }

    static async create(envelope: InboundEnvelope, principalContext?: MessagePrincipalContext): Promise<ConversationStore> {
        return conversationRegistry.create(envelope, principalContext);
    }

    static findByEventId(eventId: string): ConversationStore | undefined {
        return conversationRegistry.findByEventId(eventId);
    }

    static getAll(): ConversationStore[] {
        return conversationRegistry.getAll();
    }

    static cacheEnvelope(envelope: InboundEnvelope): void {
        conversationRegistry.cacheEnvelope(envelope);
    }

    static getCachedEnvelope(nativeId: string): InboundEnvelope | undefined {
        return conversationRegistry.getCachedEnvelope(nativeId);
    }

    static async addEnvelope(
        conversationId: string,
        envelope: InboundEnvelope,
        principalContext?: MessagePrincipalContext
    ): Promise<void> {
        return conversationRegistry.addEnvelope(conversationId, envelope, principalContext);
    }

    static setConversationTitle(conversationId: string, title: string): void {
        conversationRegistry.setConversationTitle(conversationId, title);
    }

    static async updateConversationMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        return conversationRegistry.updateConversationMetadata(conversationId, metadata);
    }

    static archive(conversationId: string): void {
        conversationRegistry.archive(conversationId);
    }

    static async complete(conversationId: string): Promise<void> {
        return conversationRegistry.complete(conversationId);
    }

    static async cleanup(): Promise<void> {
        return conversationRegistry.cleanup();
    }

    static search(query: string): ConversationStore[] {
        return conversationRegistry.search(query);
    }

    static getProjectId(): ProjectDTag | null {
        return conversationRegistry.projectId;
    }

    static getBasePath(): string {
        return conversationRegistry.basePath;
    }

    static getConversationsDir(): string | null {
        return conversationRegistry.getConversationsDir();
    }

    static listConversationIdsFromDisk(): string[] {
        return conversationRegistry.listConversationIdsFromDisk();
    }

    static listProjectIdsFromDisk(): ProjectDTag[] {
        return conversationRegistry.listProjectIdsFromDisk();
    }

    static listConversationIdsFromDiskForProject(projectId: ProjectDTag): string[] {
        return conversationRegistry.listConversationIdsFromDiskForProject(projectId);
    }

    static isAgentPubkey(pubkey: string): boolean {
        return conversationRegistry.isAgentPubkey(pubkey);
    }

    static get agentPubkeys(): Set<string> {
        return conversationRegistry.agentPubkeys;
    }

    static readLightweightMetadata(
        conversationId: string
    ): ReturnType<typeof conversationRegistry.readLightweightMetadata> {
        return conversationRegistry.readLightweightMetadata(conversationId);
    }

    static readMessagesFromDisk(conversationId: string): ConversationRecordInput[] | null {
        return conversationRegistry.readMessagesFromDisk(conversationId);
    }

    static readConversationPreview(
        conversationId: string,
        agentPubkey: string
    ): ReturnType<typeof conversationRegistry.readConversationPreview> {
        return conversationRegistry.readConversationPreview(conversationId, agentPubkey);
    }

    static readConversationPreviewForProject(
        conversationId: string,
        agentPubkey: string,
        projectId: ProjectDTag
    ): ReturnType<typeof conversationRegistry.readConversationPreviewForProject> {
        return conversationRegistry.readConversationPreviewForProject(conversationId, agentPubkey, projectId);
    }

    static reset(): void {
        conversationRegistry.reset();
    }

    // ========== INSTANCE MEMBERS ==========

    private basePath: string;
    private projectId: ProjectDTag | null = null;
    private conversationId: string | null = null;
    private state: ConversationState = {
        activeRal: {},
        nextRalNumber: {},
        injections: [],
        messages: [],
        metadata: {},
        agentTodos: {},
        todoNudgedAgents: [],
        blockedAgents: [],
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        contextManagementScratchpads: {},
        contextManagementCompactions: {},
        selfAppliedSkills: {},
        agentPromptHistories: {},
        contextManagementReminderStates: {},
    };
    private eventIdSet: Set<string> = new Set();
    private blockedAgentsSet: Set<string> = new Set();

    constructor(basePath: string) {
        this.basePath = basePath;
    }

    private getFilePath(): string {
        if (!this.projectId || !this.conversationId) {
            throw new Error("Must call load() before accessing file");
        }
        return join(this.basePath, this.projectId, "conversations", `${this.conversationId}.json`);
    }

    private ensureDirectory(): void {
        if (!this.projectId) {
            throw new Error("Must call load() before accessing directory");
        }
        const dir = join(this.basePath, this.projectId, "conversations");
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    load(projectId: ProjectDTag, conversationId: string): void {
        this.projectId = projectId;
        this.conversationId = conversationId;

        const filePath = this.getFilePath();
        if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            const loaded = JSON.parse(content);
            const messages = normalizeLoadedMessages((loaded.messages ?? []) as ConversationRecordInput[]);
            this.state = {
                activeRal: loaded.activeRal ?? {},
                nextRalNumber: loaded.nextRalNumber ?? {},
                injections: loaded.injections ?? [],
                messages,
                metadata: normalizeLoadedMetadata(
                    loaded.metadata as ConversationMetadata | Record<string, unknown> | undefined
                ),
                agentTodos: loaded.agentTodos ?? {},
                todoNudgedAgents: loaded.todoNudgedAgents ?? [],
                // Note: todoRemindedAgents removed in refactor - ignore if present in old files
                blockedAgents: loaded.blockedAgents ?? [],
                executionTime: loaded.executionTime ?? { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                metaModelVariantOverride: loaded.metaModelVariantOverride,
                contextManagementScratchpads: normalizeLoadedContextManagementScratchpads(
                    loaded.contextManagementScratchpads as
                        | Record<string, ContextManagementScratchpadState>
                        | undefined
                ),
                contextManagementCompactions: normalizeLoadedContextManagementCompactions(
                    loaded.contextManagementCompactions as
                        | Record<string, ContextManagementCompactionState>
                        | undefined
                ),
                selfAppliedSkills: loaded.selfAppliedSkills ?? {},
                agentPromptHistories: normalizeLoadedAgentPromptHistories(
                    loaded.agentPromptHistories as
                        | Record<string, AgentPromptHistoryState>
                        | undefined
                ),
                contextManagementReminderStates: {},
            };
            this.state.contextManagementReminderStates = normalizeLoadedReminderStates(
                loaded.contextManagementReminderStates as Record<string, ReminderState> | undefined,
                this.state.agentPromptHistories ?? {}
            );
            this.eventIdSet = new Set(
                this.state.messages.map((m) => m.eventId).filter((id): id is string => id !== undefined)
            );
            this.blockedAgentsSet = new Set(this.state.blockedAgents);
        } else {
            this.state = {
                activeRal: {},
                nextRalNumber: {},
                injections: [],
                messages: [],
                metadata: {},
                agentTodos: {},
                todoNudgedAgents: [],
                blockedAgents: [],
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                contextManagementScratchpads: {},
                contextManagementCompactions: {},
                selfAppliedSkills: {},
                agentPromptHistories: {},
                contextManagementReminderStates: {},
            };
            this.eventIdSet = new Set();
            this.blockedAgentsSet = new Set();
        }
    }

    getId(): string {
        if (!this.conversationId) throw new Error("Must call load() before accessing ID");
        return this.conversationId;
    }

    get id(): string {
        return this.getId();
    }

    getProjectId(): ProjectDTag | null {
        return this.projectId;
    }

    get title(): string | undefined {
        return this.state.metadata.title;
    }

    get metadata(): ConversationMetadata {
        return this.state.metadata;
    }

    get executionTime(): ExecutionTime {
        return this.state.executionTime;
    }

    getMessageCount(): number {
        return this.state.messages.length;
    }

    getLastActivityTime(): number {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        return lastMessage?.timestamp || 0;
    }

    getRootEventId(): string | undefined {
        return this.state.messages[0]?.eventId;
    }

    getRootAuthorPubkey(): string | undefined {
        const rootMessage = this.state.messages[0];
        return rootMessage ? getConversationRecordAuthorPubkey(rootMessage) : undefined;
    }

    async save(): Promise<void> {
        this.ensureDirectory();
        const filePath = this.getFilePath();
        await writeFile(filePath, JSON.stringify(this.state, null, 2));

        if (this.projectId) {
            try {
                ConversationCatalogService.getInstance(
                    this.projectId,
                    join(this.basePath, this.projectId)
                ).upsertFromStore(this);
            } catch (error) {
                logger.warn("[ConversationStore] Failed to update conversation catalog", {
                    conversationId: this.conversationId,
                    projectId: this.projectId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            if (this.conversationId) {
                conversationRegistry.triggerIndexUpdate(this.conversationId);
            }
        }
    }

    // RAL Lifecycle

    createRal(agentPubkey: string): number {
        const nextNum = (this.state.nextRalNumber[agentPubkey] || 0) + 1;
        this.state.nextRalNumber[agentPubkey] = nextNum;
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }
        this.state.activeRal[agentPubkey].push({ id: nextNum });
        this.syncActiveRalIndex();
        return nextNum;
    }

    ensureRalActive(agentPubkey: string, ralNumber: number): void {
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }
        if (!this.isRalActive(agentPubkey, ralNumber)) {
            this.state.activeRal[agentPubkey].push({ id: ralNumber });
            const currentNext = this.state.nextRalNumber[agentPubkey] || 0;
            if (ralNumber >= currentNext) {
                this.state.nextRalNumber[agentPubkey] = ralNumber;
            }
            this.syncActiveRalIndex();
        }
    }

    completeRal(agentPubkey: string, ralNumber: number): void {
        const activeRals = this.state.activeRal[agentPubkey];
        if (activeRals) {
            this.state.activeRal[agentPubkey] = activeRals.filter((r) => r.id !== ralNumber);
        }
        this.syncActiveRalIndex();
    }

    isRalActive(agentPubkey: string, ralNumber: number): boolean {
        const activeRals = this.state.activeRal[agentPubkey] || [];
        return activeRals.some((r) => r.id === ralNumber);
    }

    getActiveRals(agentPubkey: string): number[] {
        const activeRals = this.state.activeRal[agentPubkey] || [];
        return activeRals.map((r) => r.id);
    }

    getAllActiveRals(): Map<string, number[]> {
        const result = new Map<string, number[]>();
        for (const [agentPubkey, rals] of Object.entries(this.state.activeRal)) {
            if (rals.length > 0) {
                result.set(agentPubkey, rals.map((r) => r.id));
            }
        }
        return result;
    }

    /**
     * Sync this conversation's presence in the active RAL index.
     * Adds the conversation if it has any active RALs, removes it if none remain.
     */
    private syncActiveRalIndex(): void {
        if (!this.projectId || !this.conversationId) return;
        const projectPath = join(this.basePath, this.projectId);
        const index = ActiveRalIndex.getInstance(projectPath);
        const hasActiveRals = Object.values(this.state.activeRal).some(rals => rals.length > 0);
        if (hasActiveRals) {
            index.add(this.conversationId);
        } else {
            index.remove(this.conversationId);
        }
    }

    // Message Operations

    addMessage(entry: ConversationRecordInput): number {
        if (entry.eventId && this.eventIdSet.has(entry.eventId)) {
            return -1;
        }
        const index = this.state.messages.length;
        this.state.messages.push(ensureConversationRecord(entry, index));
        if (entry.eventId) {
            this.eventIdSet.add(entry.eventId);
        }
        return index;
    }

    relocateToEnd(eventId: string, updates: Partial<ConversationRecordInput>): boolean {
        const index = this.state.messages.findIndex(m => m.eventId === eventId);
        if (index === -1) return false;

        const [entry] = this.state.messages.splice(index, 1);
        Object.assign(entry, updates);
        this.state.messages.push(entry);
        return true;
    }

    getAllMessages(): ConversationRecord[] {
        return this.state.messages;
    }

    setEventId(messageIndex: number, eventId: string): void {
        if (messageIndex >= 0 && messageIndex < this.state.messages.length) {
            this.state.messages[messageIndex].eventId = eventId;
            this.eventIdSet.add(eventId);
        }
    }

    hasEventId(eventId: string): boolean {
        return this.eventIdSet.has(eventId);
    }

    getFirstUserMessage(): (ConversationRecord & { index: number }) | undefined {
        for (let i = 0; i < this.state.messages.length; i++) {
            const msg = this.state.messages[i];
            const authorPubkey = getConversationRecordAuthorPubkey(msg);
            if (
                msg.messageType === "text" &&
                (!authorPubkey || !ConversationStore.agentPubkeys.has(authorPubkey))
            ) {
                return { ...msg, index: i };
            }
        }
        return undefined;
    }

    updateMessageContent(messageIndex: number, newContent: string): void {
        if (messageIndex >= 0 && messageIndex < this.state.messages.length) {
            this.state.messages[messageIndex].content = newContent;
        }
    }

    getMetaModelVariantOverride(agentPubkey: string): string | undefined {
        return this.state.metaModelVariantOverride?.[agentPubkey];
    }

    setMetaModelVariantOverride(agentPubkey: string, variantName: string): void {
        if (!this.state.metaModelVariantOverride) {
            this.state.metaModelVariantOverride = {};
        }
        this.state.metaModelVariantOverride[agentPubkey] = variantName;
    }

    clearMetaModelVariantOverride(agentPubkey: string): void {
        if (this.state.metaModelVariantOverride) {
            delete this.state.metaModelVariantOverride[agentPubkey];
        }
    }

    getContextManagementScratchpad(agentId: string): ContextManagementScratchpadState | undefined {
        return this.state.contextManagementScratchpads?.[agentId];
    }

    setContextManagementScratchpad(agentId: string, state: ContextManagementScratchpadState): void {
        if (!this.state.contextManagementScratchpads) {
            this.state.contextManagementScratchpads = {};
        }

        const normalizedState = normalizeContextManagementScratchpadState(state);
        const hasEntries = Object.keys(normalizedState?.entries ?? {}).length > 0;
        const hasPreserveTurns = typeof normalizedState?.preserveTurns === "number";
        const hasActiveNotice = normalizedState?.activeNotice !== undefined;

        if (!normalizedState || (!hasEntries && !hasPreserveTurns && !hasActiveNotice)) {
            delete this.state.contextManagementScratchpads[agentId];
            return;
        }

        this.state.contextManagementScratchpads[agentId] = normalizedState;
    }

    listContextManagementScratchpads(): ContextManagementScratchpadEntry[] {
        const entries = Object.entries(this.state.contextManagementScratchpads ?? {}).map(
            ([agentId, state]) => ({
                agentId,
                agentLabel: state.agentLabel,
                state,
            })
        );

        return entries.sort((a, b) =>
            (a.agentLabel ?? a.agentId).localeCompare(b.agentLabel ?? b.agentId)
        );
    }

    getContextManagementCompaction(agentId: string): ContextManagementCompactionState | undefined {
        return this.state.contextManagementCompactions?.[agentId];
    }

    setContextManagementCompaction(agentId: string, state: ContextManagementCompactionState): void {
        if (!this.state.contextManagementCompactions) {
            this.state.contextManagementCompactions = {};
        }

        const normalizedState = normalizeContextManagementCompactionState(state);
        if (!normalizedState) {
            delete this.state.contextManagementCompactions[agentId];
            return;
        }

        this.state.contextManagementCompactions[agentId] = normalizedState;
    }

    listContextManagementCompactions(): ContextManagementCompactionEntry[] {
        const entries = Object.entries(this.state.contextManagementCompactions ?? {}).map(
            ([agentId, state]) => ({
                agentId,
                agentLabel: state.agentLabel,
                state,
            })
        );

        return entries.sort((a, b) =>
            (a.agentLabel ?? a.agentId).localeCompare(b.agentLabel ?? b.agentId)
        );
    }

    hasToolCall(toolCallId: string): boolean {
        return this.state.messages.some(
            (m) =>
                m.messageType === "tool-call" &&
                (m.toolData as ToolCallPart[] | undefined)?.some((part) => part.toolCallId === toolCallId)
        );
    }

    hasToolResult(toolCallId: string): boolean {
        return this.state.messages.some(
            (m) =>
                m.messageType === "tool-result" &&
                (m.toolData as ToolResultPart[] | undefined)?.some((part) => part.toolCallId === toolCallId)
        );
    }

    /**
     * Add a delegation marker to the conversation.
     * Markers are lazily expanded when building messages - only direct child
     * delegations are expanded, preventing exponential transcript bloat.
     *
     * @param marker - The delegation marker data
     * @param agentPubkey - The pubkey of the agent this marker is for
     * @param ralNumber - The RAL number for targeting
     * @returns The index of the added message
     */
    addDelegationMarker(
        marker: DelegationMarker,
        agentPubkey: string,
        ralNumber?: number
    ): number {
        const entry: ConversationRecordInput = {
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "", // Markers have no text content
            messageType: "delegation-marker",
            timestamp: marker.completedAt ?? marker.initiatedAt ?? Math.floor(Date.now() / 1000),
            targetedPubkeys: [agentPubkey], // Target the delegator
            delegationMarker: marker,
        };
        return this.addMessage(entry);
    }

    /**
     * Append a new completed/aborted delegation marker when a pending marker exists.
     * Returns true if the target status is already present or a new marker was appended.
     * Returns false when no marker for the delegation conversation exists.
     *
     * Idempotent: Returns true if marker is already in the target state.
     */
    updateDelegationMarker(
        delegationConversationId: string,
        updates: {
            status: "completed" | "aborted";
            completedAt: number;
            abortReason?: string;
        }
    ): boolean {
        const existingTargetMarker = this.state.messages.find(
            (msg) =>
                msg.messageType === "delegation-marker" &&
                msg.delegationMarker?.delegationConversationId === delegationConversationId &&
                msg.delegationMarker?.status === updates.status
        );

        if (existingTargetMarker) {
            return true;
        }

        const markerEntry = this.state.messages.find(
            msg =>
                msg.messageType === "delegation-marker" &&
                msg.delegationMarker?.delegationConversationId === delegationConversationId &&
                msg.delegationMarker?.status === "pending"
        );

        if (!markerEntry) {
            return false;
        }

        const dm = markerEntry.delegationMarker;
        if (!dm) throw new Error(`Delegation marker missing on message of type "delegation-marker" for conversation ${delegationConversationId}`);

        this.addDelegationMarker(
            {
                ...dm,
                status: updates.status,
                completedAt: updates.completedAt,
                ...(updates.abortReason ? { abortReason: updates.abortReason } : {}),
            },
            markerEntry.pubkey,
            markerEntry.ral
        );

        return true;
    }

    // Injection Operations

    addInjection(injection: Injection): void {
        this.state.injections.push(injection);
    }

    getPendingInjections(agentPubkey: string, ralNumber: number): Injection[] {
        return this.state.injections.filter(
            (i) => i.targetRal.pubkey === agentPubkey && i.targetRal.ral === ralNumber
        );
    }

    consumeInjections(agentPubkey: string, ralNumber: number): Injection[] {
        const toConsume = this.getPendingInjections(agentPubkey, ralNumber);
        this.state.injections = this.state.injections.filter(
            (i) => !(i.targetRal.pubkey === agentPubkey && i.targetRal.ral === ralNumber)
        );
        for (const injection of toConsume) {
            this.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: injection.content,
                messageType: "text",
                targetedPubkeys: injection.role === "user" ? [agentPubkey] : undefined,
            });
        }
        return toConsume;
    }

    // Message Building

    async buildMessagesForRal(
        agentPubkey: string,
        ralNumber: number,
        options: BuildMessagesOptions = {}
    ): Promise<ModelMessage[]> {
        // INVARIANT: conversationId should always be set after load()
        // If missing, delegation markers won't expand - log a warning for debugging
        if (!this.conversationId) {
            logger.warn("[ConversationStore.buildMessagesForRal] conversationId is null - delegation markers will not expand");
        }

        const activeRals = new Set(this.getActiveRals(agentPubkey));

        // Callback to get delegation messages for marker expansion
        const getDelegationMessages = (
            delegationConversationId: string
        ): ConversationRecord[] | undefined => {
            const store = conversationRegistry.get(delegationConversationId);
            return store?.getAllMessages();
        };

        return buildPromptMessagesFromRecords(this.state.messages, {
            viewingAgentPubkey: agentPubkey,
            ralNumber,
            activeRals,

            agentPubkeys: ConversationStore.agentPubkeys,
            conversationId: this.conversationId ?? undefined,
            getDelegationMessages,
            includeMessageIds: options.includeMessageIds,
            inFlightToolCallIds: options.inFlightToolCallIds,
        });
    }

    // Metadata Operations

    getMetadata(): ConversationMetadata {
        return this.state.metadata;
    }

    updateMetadata(updates: Partial<ConversationMetadata>): void {
        this.state.metadata = { ...this.state.metadata, ...updates };
    }

    getTitle(): string | undefined {
        return this.state.metadata.title;
    }

    setTitle(title: string): void {
        this.state.metadata.title = title;
    }

    // Todo Operations

    getTodos(agentPubkey: string): TodoItem[] {
        return this.state.agentTodos[agentPubkey] ?? [];
    }

    setTodos(agentPubkey: string, todos: TodoItem[]): void {
        this.state.agentTodos[agentPubkey] = todos;
    }

    hasBeenNudgedAboutTodos(agentPubkey: string): boolean {
        return this.state.todoNudgedAgents.includes(agentPubkey);
    }

    setNudgedAboutTodos(agentPubkey: string): void {
        if (!this.state.todoNudgedAgents.includes(agentPubkey)) {
            this.state.todoNudgedAgents.push(agentPubkey);
        }
    }

    // Blocked Agents

    isAgentBlocked(agentPubkey: string): boolean {
        return this.blockedAgentsSet.has(agentPubkey);
    }

    blockAgent(agentPubkey: string): void {
        this.blockedAgentsSet.add(agentPubkey);
        this.state.blockedAgents = Array.from(this.blockedAgentsSet);
    }

    unblockAgent(agentPubkey: string): void {
        this.blockedAgentsSet.delete(agentPubkey);
        this.state.blockedAgents = Array.from(this.blockedAgentsSet);
    }

    getBlockedAgents(): Set<string> {
        return this.blockedAgentsSet;
    }

    // Self-Applied Skills Operations

    setSelfAppliedSkills(skillIds: string[], agentPubkey: string): void {
        if (!this.state.selfAppliedSkills) this.state.selfAppliedSkills = {};
        this.state.selfAppliedSkills[agentPubkey] = [...skillIds];
    }

    getSelfAppliedSkillIds(agentPubkey: string): string[] {
        return this.state.selfAppliedSkills?.[agentPubkey] ?? [];
    }

    // Prompt History Operations

    getAgentPromptHistory(agentPubkey: string): AgentPromptHistoryState {
        if (!this.state.agentPromptHistories) {
            this.state.agentPromptHistories = {};
        }

        if (!this.state.agentPromptHistories[agentPubkey]) {
            this.state.agentPromptHistories[agentPubkey] = createEmptyAgentPromptHistoryState();
        }

        return this.state.agentPromptHistories[agentPubkey];
    }

    setAgentPromptHistory(agentPubkey: string, history: AgentPromptHistoryState): void {
        if (!this.state.agentPromptHistories) {
            this.state.agentPromptHistories = {};
        }

        this.state.agentPromptHistories[agentPubkey] = history;
    }

    clearAgentPromptHistory(agentPubkey: string): void {
        if (this.state.agentPromptHistories) {
            delete this.state.agentPromptHistories[agentPubkey];
        }
    }

    getContextManagementReminderState(agentPubkey: string): ReminderState | undefined {
        return this.state.contextManagementReminderStates?.[agentPubkey];
    }

    setContextManagementReminderState(agentPubkey: string, state: ReminderState): void {
        if (!this.state.contextManagementReminderStates) {
            this.state.contextManagementReminderStates = {};
        }

        this.state.contextManagementReminderStates[agentPubkey] = structuredClone(state);
    }

    clearContextManagementReminderState(agentPubkey: string): void {
        if (this.state.contextManagementReminderStates) {
            delete this.state.contextManagementReminderStates[agentPubkey];
        }
    }

    // Envelope Message Operations

    addEnvelopeMessage(
        envelope: InboundEnvelope,
        isFromAgent: boolean,
        principalContext?: MessagePrincipalContext
    ): void {
        const nativeId = envelope.message.nativeId;
        if (!nativeId) return;
        if (envelope.metadata.eventKind !== undefined && envelope.metadata.eventKind !== NDKKind.Text) return;
        if (envelope.metadata.toolName) return;
        if (this.hasEventId(nativeId)) return;

        const targetedPubkeys = envelope.recipients
            .map((r) => r.linkedPubkey)
            .filter((pk): pk is string => !!pk);

        const defaultTargetedPrincipals = targetedPubkeys.length > 0
            ? envelope.recipients.map((r) => ({
                  id: r.id,
                  transport: r.transport,
                  linkedPubkey: r.linkedPubkey,
              }))
            : undefined;

        const targetedPrincipals =
            principalContext?.targetedPrincipals?.length
                ? principalContext.targetedPrincipals
                : defaultTargetedPrincipals;

        const senderPrincipal: PrincipalSnapshot = principalContext?.senderPrincipal ?? {
            id: envelope.principal.id,
            transport: envelope.principal.transport,
            linkedPubkey: envelope.principal.linkedPubkey,
        };
        const senderPubkey = senderPrincipal.linkedPubkey ?? envelope.principal.linkedPubkey;

        this.addMessage({
            pubkey: senderPubkey ?? "",
            content: envelope.content,
            messageType: "text",
            eventId: nativeId,
            timestamp: envelope.occurredAt,
            targetedPubkeys: targetedPubkeys.length > 0 ? targetedPubkeys : undefined,
            targetedPrincipals,
            senderPubkey,
            senderPrincipal,
        });

        if (!isFromAgent) {
            this.state.metadata.lastUserMessage = envelope.content;
        }
    }

}

// Register store class with registry to avoid circular imports.
conversationRegistry.setConversationStoreClass(ConversationStore);

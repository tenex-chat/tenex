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

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { TodoItem } from "@/services/ral/types";
import { buildMessagesFromEntries } from "./MessageBuilder";
import { conversationRegistry } from "./ConversationRegistry";
import type {
    ConversationEntry,
    ConversationMetadata,
    ConversationState,
    DeferredInjection,
    DelegationMarker,
    ExecutionTime,
    Injection,
} from "./types";
import type { CompressionSegment, CompressionLog } from "@/services/compression/compression-types.js";
import { applySegmentsToEntries } from "@/services/compression/compression-utils.js";
import { logger } from "@/utils/logger";
import type { FullEventId } from "@/types/event-ids";

/**
 * Type alias for conversation IDs accepted by ConversationStore methods.
 * Accepts both typed FullEventId and plain strings for backward compatibility.
 */
export type ConversationIdInput = string | FullEventId;

// Re-export types for convenience
export type {
    ConversationEntry,
    ConversationMetadata,
    DeferredInjection,
    Injection,
} from "./types";

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

    static async create(event: NDKEvent): Promise<ConversationStore> {
        return conversationRegistry.create(event);
    }

    static findByEventId(eventId: string): ConversationStore | undefined {
        return conversationRegistry.findByEventId(eventId);
    }

    static getAll(): ConversationStore[] {
        return conversationRegistry.getAll();
    }

    static cacheEvent(event: NDKEvent): void {
        conversationRegistry.cacheEvent(event);
    }

    static getCachedEvent(eventId: string): NDKEvent | undefined {
        return conversationRegistry.getCachedEvent(eventId);
    }

    static async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        return conversationRegistry.addEvent(conversationId, event);
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

    static getProjectId(): string | null {
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

    static listProjectIdsFromDisk(): string[] {
        return conversationRegistry.listProjectIdsFromDisk();
    }

    static listConversationIdsFromDiskForProject(projectId: string): string[] {
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

    static readMessagesFromDisk(conversationId: string): ConversationEntry[] | null {
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
        projectId: string
    ): ReturnType<typeof conversationRegistry.readConversationPreviewForProject> {
        return conversationRegistry.readConversationPreviewForProject(conversationId, agentPubkey, projectId);
    }

    static reset(): void {
        conversationRegistry.reset();
    }

    // ========== INSTANCE MEMBERS ==========

    private basePath: string;
    private projectId: string | null = null;
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

    load(projectId: string, conversationId: string): void {
        this.projectId = projectId;
        this.conversationId = conversationId;

        const filePath = this.getFilePath();
        if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            const loaded = JSON.parse(content);
            this.state = {
                activeRal: loaded.activeRal ?? {},
                nextRalNumber: loaded.nextRalNumber ?? {},
                injections: loaded.injections ?? [],
                messages: loaded.messages ?? [],
                metadata: loaded.metadata ?? {},
                agentTodos: loaded.agentTodos ?? {},
                todoNudgedAgents: loaded.todoNudgedAgents ?? [],
                // Note: todoRemindedAgents removed in refactor - ignore if present in old files
                blockedAgents: loaded.blockedAgents ?? [],
                executionTime: loaded.executionTime ?? { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                metaModelVariantOverride: loaded.metaModelVariantOverride,
                deferredInjections: loaded.deferredInjections ?? [],
            };
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

    getProjectId(): string | null {
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

    /**
     * Get the message count after applying compression segments.
     * This is the count in "compressed space" used for delta-mode cursors.
     *
     * CRITICAL: Delta-mode cursors must reference compressed space, not raw space.
     * If cursor is in raw space, it can exceed compressed array length after compression,
     * causing buildMessagesForRalAfterIndex to silently drop new messages.
     */
    getCompressedMessageCount(): number {
        if (!this.conversationId) {
            return this.state.messages.length;
        }

        const segments = this.loadCompressionLog(this.conversationId);
        if (segments.length === 0) {
            return this.state.messages.length;
        }

        const compressed = applySegmentsToEntries(this.state.messages, segments);
        return compressed.length;
    }

    getLastActivityTime(): number {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        return lastMessage?.timestamp || 0;
    }

    getRootEventId(): string | undefined {
        return this.state.messages[0]?.eventId;
    }

    getRootAuthorPubkey(): string | undefined {
        return this.state.messages[0]?.pubkey;
    }

    async save(): Promise<void> {
        this.ensureDirectory();
        const filePath = this.getFilePath();
        await writeFile(filePath, JSON.stringify(this.state, null, 2));
    }

    // RAL Lifecycle

    createRal(agentPubkey: string): number {
        const nextNum = (this.state.nextRalNumber[agentPubkey] || 0) + 1;
        this.state.nextRalNumber[agentPubkey] = nextNum;
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }
        this.state.activeRal[agentPubkey].push({ id: nextNum });
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
        }
    }

    completeRal(agentPubkey: string, ralNumber: number): void {
        const activeRals = this.state.activeRal[agentPubkey];
        if (activeRals) {
            this.state.activeRal[agentPubkey] = activeRals.filter((r) => r.id !== ralNumber);
        }
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

    // Message Operations

    addMessage(entry: ConversationEntry): number {
        if (entry.eventId && this.eventIdSet.has(entry.eventId)) {
            return -1;
        }
        const index = this.state.messages.length;
        this.state.messages.push(entry);
        if (entry.eventId) {
            this.eventIdSet.add(entry.eventId);
        }
        return index;
    }

    getAllMessages(): ConversationEntry[] {
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

    getFirstUserMessage(): (ConversationEntry & { id: number }) | undefined {
        for (let i = 0; i < this.state.messages.length; i++) {
            const msg = this.state.messages[i];
            if (msg.messageType === "text" && !ConversationStore.agentPubkeys.has(msg.pubkey)) {
                return { ...msg, id: i };
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
        const entry: ConversationEntry = {
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "", // Markers have no text content
            messageType: "delegation-marker",
            timestamp: Math.floor(marker.completedAt / 1000), // Convert ms to seconds
            targetedPubkeys: [agentPubkey], // Target the delegator
            delegationMarker: marker,
        };
        return this.addMessage(entry);
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

    // Deferred Injection Operations (for next-turn messages)

    /**
     * Add a deferred injection for an agent's next turn.
     *
     * Unlike regular injections that target a specific RAL, deferred injections
     * are consumed at the START of any future RAL for the target agent.
     * This is used for supervision messages that should NOT block the current
     * completion but should appear in the agent's next conversation turn.
     */
    addDeferredInjection(injection: DeferredInjection): void {
        if (!this.state.deferredInjections) {
            this.state.deferredInjections = [];
        }
        this.state.deferredInjections.push(injection);
    }

    /**
     * Get pending deferred injections for an agent.
     */
    getPendingDeferredInjections(agentPubkey: string): DeferredInjection[] {
        return (this.state.deferredInjections ?? []).filter(
            (i) => i.targetPubkey === agentPubkey
        );
    }

    /**
     * Consume deferred injections for an agent, returning them and removing from queue.
     *
     * Unlike consumeInjections which adds messages to store, this just returns
     * the injections for the caller to handle (typically as ephemeral messages
     * in MessageCompiler).
     */
    consumeDeferredInjections(agentPubkey: string): DeferredInjection[] {
        const toConsume = this.getPendingDeferredInjections(agentPubkey);
        this.state.deferredInjections = (this.state.deferredInjections ?? []).filter(
            (i) => i.targetPubkey !== agentPubkey
        );
        return toConsume;
    }

    // Message Building

    async buildMessagesForRal(
        agentPubkey: string,
        ralNumber: number,
        projectRoot?: string
    ): Promise<ModelMessage[]> {
        // INVARIANT: conversationId should always be set after load()
        // If missing, delegation markers won't expand - log a warning for debugging
        if (!this.conversationId) {
            logger.warn("[ConversationStore.buildMessagesForRal] conversationId is null - delegation markers will not expand");
        }

        const activeRals = new Set(this.getActiveRals(agentPubkey));
        const rootAuthorPubkey = this.state.messages[0]?.pubkey;

        // Apply compression segments if they exist
        const segments = this.conversationId ? this.loadCompressionLog(this.conversationId) : [];
        const entries = segments.length > 0
            ? applySegmentsToEntries(this.state.messages, segments)
            : this.state.messages;

        // Callback to get delegation messages for marker expansion
        const getDelegationMessages = (delegationConversationId: string) => {
            const store = conversationRegistry.get(delegationConversationId);
            return store?.getAllMessages();
        };

        return buildMessagesFromEntries(entries, {
            viewingAgentPubkey: agentPubkey,
            ralNumber,
            activeRals,
            totalMessages: entries.length,
            rootAuthorPubkey,
            projectRoot,
            conversationId: this.conversationId ?? undefined,
            getDelegationMessages,
        });
    }

    async buildMessagesForRalAfterIndex(
        agentPubkey: string,
        ralNumber: number,
        afterIndex: number,
        projectRoot?: string
    ): Promise<ModelMessage[]> {
        // INVARIANT: conversationId should always be set after load()
        // If missing, delegation markers won't expand - log a warning for debugging
        if (!this.conversationId) {
            logger.warn("[ConversationStore.buildMessagesForRalAfterIndex] conversationId is null - delegation markers will not expand");
        }

        const activeRals = new Set(this.getActiveRals(agentPubkey));
        const startIndex = Math.max(afterIndex + 1, 0);

        // Apply compression segments if they exist
        const segments = this.conversationId ? this.loadCompressionLog(this.conversationId) : [];
        const allEntries = segments.length > 0
            ? applySegmentsToEntries(this.state.messages, segments)
            : this.state.messages;

        if (startIndex >= allEntries.length) return [];
        const entries = allEntries.slice(startIndex);
        const rootAuthorPubkey = allEntries[0]?.pubkey;

        // Callback to get delegation messages for marker expansion
        const getDelegationMessages = (delegationConversationId: string) => {
            const store = conversationRegistry.get(delegationConversationId);
            return store?.getAllMessages();
        };

        return buildMessagesFromEntries(entries, {
            viewingAgentPubkey: agentPubkey,
            ralNumber,
            activeRals,
            indexOffset: startIndex,
            totalMessages: allEntries.length,
            rootAuthorPubkey,
            projectRoot,
            conversationId: this.conversationId ?? undefined,
            getDelegationMessages,
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

    // Event Message Operations

    private static extractTargetedPubkeys(event: NDKEvent): string[] {
        const pTags = event.getMatchingTags("p");
        if (pTags.length === 0) return [];
        const targeted: string[] = [];
        for (const pTag of pTags) {
            const pubkey = pTag[1];
            if (pubkey) targeted.push(pubkey);
        }
        return targeted;
    }

    addEventMessage(event: NDKEvent, isFromAgent: boolean): void {
        if (!event.id) return;
        if (event.kind !== 1) return;
        if (event.tagValue("tool")) return;
        if (this.hasEventId(event.id)) return;

        const targetedPubkeys = ConversationStore.extractTargetedPubkeys(event);
        this.addMessage({
            pubkey: event.pubkey,
            content: event.content,
            messageType: "text",
            eventId: event.id,
            timestamp: event.created_at,
            targetedPubkeys: targetedPubkeys.length > 0 ? targetedPubkeys : undefined,
        });

        if (!isFromAgent) {
            this.state.metadata.last_user_message = event.content;
        }
    }

    // Compression Operations

    /**
     * Load compression log for a conversation.
     * Returns empty array if no compression log exists.
     */
    loadCompressionLog(conversationId: string): CompressionSegment[] {
        if (!this.projectId) {
            return [];
        }

        const conversationsDir = join(this.basePath, this.projectId, "conversations");
        const compressionsDir = join(conversationsDir, "compressions");
        if (!existsSync(compressionsDir)) {
            return [];
        }

        const compressionPath = join(compressionsDir, `${conversationId}.json`);
        if (!existsSync(compressionPath)) {
            return [];
        }

        try {
            const data = readFileSync(compressionPath, "utf-8");
            const log = JSON.parse(data) as CompressionLog;
            return log.segments || [];
        } catch (error) {
            // CRITICAL: Use imported logger, not this.logger (which doesn't exist)
            logger.warn(`Failed to load compression log for ${conversationId}:`, error);
            return [];
        }
    }

    /**
     * Append new compression segments to the log.
     * Creates the compressions directory if needed.
     */
    async appendCompressionSegments(
        conversationId: string,
        segments: CompressionSegment[]
    ): Promise<void> {
        if (!this.projectId) {
            throw new Error("Conversations directory not initialized");
        }

        const conversationsDir = join(this.basePath, this.projectId, "conversations");
        const compressionsDir = join(conversationsDir, "compressions");
        if (!existsSync(compressionsDir)) {
            mkdirSync(compressionsDir, { recursive: true });
        }

        const compressionPath = join(compressionsDir, `${conversationId}.json`);

        // Load existing segments
        const existingSegments = this.loadCompressionLog(conversationId);

        // Append new segments
        const log: CompressionLog = {
            conversationId,
            segments: [...existingSegments, ...segments],
            updatedAt: Date.now(),
        };

        await writeFile(compressionPath, JSON.stringify(log, null, 2), "utf-8");
    }
}

// Register store class with registry to avoid circular imports.
conversationRegistry.setConversationStoreClass(ConversationStore);

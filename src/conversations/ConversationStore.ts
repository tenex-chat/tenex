/**
 * ConversationStore - Single source of truth for conversation state
 *
 * This class manages persistent storage of conversation messages, RAL lifecycle,
 * and message visibility rules. Nostr events hydrate the store, and the store
 * is used to build messages for agent execution.
 *
 * File location: ~/.tenex/projects/{projectId}/conversations/{conversationId}.json
 *
 * Static methods provide the global registry for all conversation stores.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import { trace } from "@opentelemetry/api";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { TodoItem } from "@/services/ral/types";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import { convertToMultimodalContent } from "./utils/multimodal-content";
import { processToolResult, type TruncationContext } from "./utils/tool-result-truncator";

export type MessageType = "text" | "tool-call" | "tool-result";

export interface ConversationEntry {
    pubkey: string;
    ral?: number; // Only for agent messages
    content: string; // Text content (for text messages) or empty for tool messages
    messageType: MessageType;
    toolData?: ToolCallPart[] | ToolResultPart[]; // Only for tool-call and tool-result
    eventId?: string; // If published to Nostr
    timestamp?: number; // Unix timestamp (seconds) - from NDKEvent.created_at or Date.now()/1000
    targetedPubkeys?: string[]; // Agent pubkeys this message is directed to (from p-tags)
    suppressAttribution?: boolean; // Skip [@sender -> @recipient] prefix for system-style messages
}

export interface Injection {
    targetRal: { pubkey: string; ral: number };
    role: "user" | "system";
    content: string;
    queuedAt: number;
    suppressAttribution?: boolean;
}

export interface ConversationMetadata {
    title?: string;
    branch?: string;
    summary?: string;
    requirements?: string;
    plan?: string;
    projectPath?: string;
    last_user_message?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    referencedArticle?: {
        title: string;
        content: string;
        dTag: string;
    };
}

interface RalTracker {
    id: number;
}

export interface ExecutionTime {
    totalSeconds: number;
    currentSessionStart?: number;
    isActive: boolean;
    lastUpdated: number;
}

interface ConversationState {
    activeRal: Record<string, RalTracker[]>;
    nextRalNumber: Record<string, number>;
    injections: Injection[];
    messages: ConversationEntry[];
    metadata: ConversationMetadata;
    agentTodos: Record<string, TodoItem[]>;
    todoNudgedAgents: string[]; // Agents who have been nudged about todo usage
    todoRemindedAgents: string[]; // Agents who have been reminded about incomplete todos
    blockedAgents: string[];
    executionTime: ExecutionTime;
    /** Meta model variant override per agent - when set, uses this variant instead of keyword detection */
    metaModelVariantOverride?: Record<string, string>; // agentPubkey -> variantName
}

export class ConversationStore {
    // ========== STATIC REGISTRY ==========
    // Global registry of all conversation stores
    private static stores: Map<string, ConversationStore> = new Map();
    private static eventCache: Map<string, NDKEvent> = new Map();
    private static basePath: string = join(homedir(), ".tenex", "projects");
    private static projectId: string | null = null;
    private static agentPubkeys: Set<string> = new Set();

    /**
     * Initialize the global conversation store registry.
     * Must be called once at startup before using any stores.
     */
    static initialize(metadataPath: string, agentPubkeys?: Iterable<string>): void {
        // metadataPath points to ~/.tenex/projects/<dTag>
        ConversationStore.basePath = dirname(metadataPath);
        ConversationStore.projectId = basename(metadataPath);

        // Build set of agent pubkeys
        ConversationStore.agentPubkeys = new Set(agentPubkeys ?? []);

        logger.info(`[ConversationStore] Initialized for project ${ConversationStore.projectId}`);
    }

    /**
     * Get or load a conversation store by ID.
     * Loads from disk if not already in memory.
     */
    static getOrLoad(conversationId: string): ConversationStore {
        let store = ConversationStore.stores.get(conversationId);
        if (!store) {
            if (!ConversationStore.projectId) {
                throw new Error("ConversationStore.initialize() must be called before getOrLoad()");
            }
            store = new ConversationStore(ConversationStore.basePath);
            store.load(ConversationStore.projectId, conversationId);
            ConversationStore.stores.set(conversationId, store);
        }
        return store;
    }

    /**
     * Get a conversation store if it exists in memory or on disk.
     * Returns undefined if conversation doesn't exist.
     *
     * This method first checks the current project, then searches across
     * all projects if not found locally (for cross-project conversation access).
     */
    static get(conversationId: string): ConversationStore | undefined {
        const cached = ConversationStore.stores.get(conversationId);
        if (cached) return cached;

        // Try to load from current project first (fast path)
        if (ConversationStore.projectId) {
            const store = new ConversationStore(ConversationStore.basePath);
            try {
                store.load(ConversationStore.projectId, conversationId);
                // Check if it actually has data
                if (store.getAllMessages().length > 0) {
                    ConversationStore.stores.set(conversationId, store);
                    return store;
                }
            } catch {
                // Store doesn't exist in current project
            }
        }

        // Fall back to searching across all projects
        const otherProjectId = ConversationStore.findProjectForConversation(conversationId);
        if (otherProjectId) {
            const store = new ConversationStore(ConversationStore.basePath);
            try {
                store.load(otherProjectId, conversationId);
                if (store.getAllMessages().length > 0) {
                    ConversationStore.stores.set(conversationId, store);
                    logger.debug(`[ConversationStore] Found conversation ${conversationId.substring(0, 8)} in project ${otherProjectId}`);
                    return store;
                }
            } catch {
                // Store doesn't exist
            }
        }

        return undefined;
    }

    /**
     * Find which project contains a conversation by searching across all project directories.
     * Returns the project ID if found, undefined otherwise.
     *
     * This is used for cross-project conversation access when a conversation ID
     * is not found in the current project.
     */
    private static findProjectForConversation(conversationId: string): string | undefined {
        try {
            if (!existsSync(ConversationStore.basePath)) return undefined;

            const projectDirs = readdirSync(ConversationStore.basePath);
            for (const projectDir of projectDirs) {
                // Skip the current project (already checked) and non-directories
                if (projectDir === ConversationStore.projectId) continue;
                if (projectDir === "metadata") continue; // Skip metadata directory

                const conversationFile = join(
                    ConversationStore.basePath,
                    projectDir,
                    "conversations",
                    `${conversationId}.json`
                );

                if (existsSync(conversationFile)) {
                    return projectDir;
                }
            }
        } catch {
            // Error reading directories
        }
        return undefined;
    }

    /**
     * Check if a conversation exists (in memory or on disk).
     */
    static has(conversationId: string): boolean {
        return ConversationStore.get(conversationId) !== undefined;
    }

    /**
     * Create a new conversation from an NDKEvent.
     * Returns existing store if conversation already exists.
     */
    static async create(event: NDKEvent): Promise<ConversationStore> {
        const eventId = event.id;
        if (!eventId) {
            throw new Error("Event must have an ID to create a conversation");
        }

        // Check if already exists
        const existing = ConversationStore.stores.get(eventId);
        if (existing) {
            logger.debug(`Conversation ${eventId.substring(0, 8)} already exists`);
            return existing;
        }

        if (!ConversationStore.projectId) {
            throw new Error("ConversationStore.initialize() must be called before create()");
        }

        // Create new store
        const store = new ConversationStore(ConversationStore.basePath);
        store.load(ConversationStore.projectId, eventId);

        // Add the initial event
        const isFromAgent = ConversationStore.agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        // Cache the event
        ConversationStore.eventCache.set(eventId, event);

        // Set initial title from content preview
        if (event.content) {
            store.setTitle(event.content.substring(0, 50) + (event.content.length > 50 ? "..." : ""));
        }

        await store.save();
        ConversationStore.stores.set(eventId, store);

        logger.info(`Starting conversation ${eventId.substring(0, 8)} - "${event.content?.substring(0, 50)}..."`);

        return store;
    }

    /**
     * Find a conversation by an event ID it contains.
     */
    static findByEventId(eventId: string): ConversationStore | undefined {
        for (const store of ConversationStore.stores.values()) {
            if (store.hasEventId(eventId)) {
                return store;
            }
        }
        return undefined;
    }

    /**
     * Get all loaded conversation stores.
     */
    static getAll(): ConversationStore[] {
        return Array.from(ConversationStore.stores.values());
    }

    /**
     * Cache an NDKEvent for later retrieval.
     */
    static cacheEvent(event: NDKEvent): void {
        if (event.id) {
            ConversationStore.eventCache.set(event.id, event);
        }
    }

    /**
     * Get a cached NDKEvent by ID.
     */
    static getCachedEvent(eventId: string): NDKEvent | undefined {
        return ConversationStore.eventCache.get(eventId);
    }

    /**
     * Add an event to a conversation.
     */
    static async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        const store = ConversationStore.getOrLoad(conversationId);
        const isFromAgent = ConversationStore.agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        // Cache the event
        if (event.id) {
            ConversationStore.eventCache.set(event.id, event);
        }

        await store.save();
    }

    /**
     * Set the title of a conversation.
     */
    static setConversationTitle(conversationId: string, title: string): void {
        const store = ConversationStore.get(conversationId);
        if (store) {
            store.setTitle(title);
        }
    }

    /**
     * Update metadata of a conversation.
     */
    static async updateConversationMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        const store = ConversationStore.get(conversationId);
        if (!store) {
            throw new Error(`Conversation ${conversationId} not found`);
        }
        store.updateMetadata(metadata);
        await store.save();
    }

    /**
     * Archive a conversation (remove from memory).
     */
    static archive(conversationId: string): void {
        const store = ConversationStore.stores.get(conversationId);
        if (store) {
            // Clean up event cache for this conversation's events
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    ConversationStore.eventCache.delete(entry.eventId);
                }
            }
        }
        ConversationStore.stores.delete(conversationId);
    }

    /**
     * Complete a conversation (save and remove from memory).
     */
    static async complete(conversationId: string): Promise<void> {
        const store = ConversationStore.stores.get(conversationId);
        if (store) {
            await store.save();
            // Clean up event cache
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    ConversationStore.eventCache.delete(entry.eventId);
                }
            }
            ConversationStore.stores.delete(conversationId);
        }
    }

    /**
     * Save all loaded stores and clean up.
     */
    static async cleanup(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const store of ConversationStore.stores.values()) {
            promises.push(store.save());
        }
        await Promise.all(promises);
    }

    /**
     * Search conversations by title.
     */
    static search(query: string): ConversationStore[] {
        const results: ConversationStore[] = [];
        const queryLower = query.toLowerCase();
        for (const store of ConversationStore.stores.values()) {
            const title = store.getTitle();
            if (title && title.toLowerCase().includes(queryLower)) {
                results.push(store);
            }
        }
        return results;
    }

    /**
     * Get the current project ID.
     * Returns null if not initialized.
     */
    static getProjectId(): string | null {
        return ConversationStore.projectId;
    }

    /**
     * Get the base path for conversation storage.
     */
    static getBasePath(): string {
        return ConversationStore.basePath;
    }

    /**
     * Get the conversations directory path for the current project.
     * Returns null if not initialized.
     */
    static getConversationsDir(): string | null {
        if (!ConversationStore.projectId) return null;
        return join(ConversationStore.basePath, ConversationStore.projectId, "conversations");
    }

    /**
     * List all conversation IDs from disk for the current project.
     * This scans the file system and returns all conversation IDs without loading full stores.
     */
    static listConversationIdsFromDisk(): string[] {
        const conversationsDir = ConversationStore.getConversationsDir();
        if (!conversationsDir) return [];

        try {
            if (!existsSync(conversationsDir)) return [];

            const files = readdirSync(conversationsDir);
            return files
                .filter(file => file.endsWith(".json"))
                .map(file => file.replace(".json", ""));
        } catch {
            return [];
        }
    }

    /**
     * List all project IDs from disk.
     * Scans the base path (~/.tenex/projects) for subdirectories.
     * Returns a list of project IDs (folder names).
     */
    static listProjectIdsFromDisk(): string[] {
        try {
            if (!existsSync(ConversationStore.basePath)) return [];

            const entries = readdirSync(ConversationStore.basePath);
            return entries.filter(entry => {
                const entryPath = join(ConversationStore.basePath, entry);
                try {
                    return statSync(entryPath).isDirectory();
                } catch {
                    return false;
                }
            });
        } catch {
            return [];
        }
    }

    /**
     * List all conversation IDs from disk for a specific project.
     * Scans ${basePath}/${projectId}/conversations for .json files.
     * Returns a list of conversation IDs (filenames without extension).
     */
    static listConversationIdsFromDiskForProject(projectId: string): string[] {
        const conversationsDir = join(ConversationStore.basePath, projectId, "conversations");

        try {
            if (!existsSync(conversationsDir)) return [];

            const files = readdirSync(conversationsDir);
            return files
                .filter(file => file.endsWith(".json"))
                .map(file => file.replace(".json", ""));
        } catch {
            return [];
        }
    }

    /**
     * Check if a pubkey belongs to an agent.
     */
    static isAgentPubkey(pubkey: string): boolean {
        return ConversationStore.agentPubkeys.has(pubkey);
    }

    /**
     * Reset static state (for testing).
     */
    static reset(): void {
        ConversationStore.stores.clear();
        ConversationStore.eventCache.clear();
        ConversationStore.basePath = join(homedir(), ".tenex", "projects");
        ConversationStore.projectId = null;
        ConversationStore.agentPubkeys.clear();
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
        todoRemindedAgents: [],
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const dir = join(this.basePath, this.projectId!, "conversations");
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
            // Ensure all required fields exist (handle old/corrupt state files)
            this.state = {
                activeRal: loaded.activeRal ?? {},
                nextRalNumber: loaded.nextRalNumber ?? {},
                injections: loaded.injections ?? [],
                messages: loaded.messages ?? [],
                metadata: loaded.metadata ?? {},
                agentTodos: loaded.agentTodos ?? {},
                todoNudgedAgents: loaded.todoNudgedAgents ?? [],
                todoRemindedAgents: loaded.todoRemindedAgents ?? [],
                blockedAgents: loaded.blockedAgents ?? [],
                executionTime: loaded.executionTime ?? { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            };
            // Rebuild eventId set
            this.eventIdSet = new Set(
                this.state.messages
                    .filter((m) => m.eventId)
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    .map((m) => m.eventId!)
            );
            // Rebuild blockedAgents set
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
                todoRemindedAgents: [],
                blockedAgents: [],
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            };
            this.eventIdSet = new Set();
            this.blockedAgentsSet = new Set();
        }
    }

    getId(): string {
        if (!this.conversationId) {
            throw new Error("Must call load() before accessing conversation ID");
        }
        return this.conversationId;
    }

    get id(): string {
        return this.getId();
    }

    // Convenience property accessors for compatibility

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

    /**
     * Get the event ID of the first message (root event).
     * Used for threading/tagging purposes.
     */
    getRootEventId(): string | undefined {
        return this.state.messages[0]?.eventId;
    }

    async save(): Promise<void> {
        this.ensureDirectory();
        const filePath = this.getFilePath();
        await writeFile(filePath, JSON.stringify(this.state, null, 2));
    }

    // RAL Lifecycle

    createRal(agentPubkey: string): number {
        // Get next RAL number
        const nextNum = (this.state.nextRalNumber[agentPubkey] || 0) + 1;
        this.state.nextRalNumber[agentPubkey] = nextNum;

        // Add to active RALs
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }
        this.state.activeRal[agentPubkey].push({ id: nextNum });

        return nextNum;
    }

    /**
     * Register an externally-assigned RAL number as active.
     * Use this when the RAL number is managed externally (e.g., by RALRegistry).
     */
    ensureRalActive(agentPubkey: string, ralNumber: number): void {
        if (!this.state.activeRal[agentPubkey]) {
            this.state.activeRal[agentPubkey] = [];
        }

        // Only add if not already active
        if (!this.isRalActive(agentPubkey, ralNumber)) {
            this.state.activeRal[agentPubkey].push({ id: ralNumber });

            // Update nextRalNumber if this number is higher (createRal adds 1)
            const currentNext = this.state.nextRalNumber[agentPubkey] || 0;
            if (ralNumber >= currentNext) {
                this.state.nextRalNumber[agentPubkey] = ralNumber;
            }
        }
    }

    completeRal(agentPubkey: string, ralNumber: number): void {
        const activeRals = this.state.activeRal[agentPubkey];
        if (activeRals) {
            this.state.activeRal[agentPubkey] = activeRals.filter(
                (r) => r.id !== ralNumber
            );
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

    /**
     * Get all active RALs for all agents in this conversation.
     * Used for reconciliation after daemon restart.
     */
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

    addMessage(entry: ConversationEntry): void {
        this.state.messages.push(entry);
        if (entry.eventId) {
            this.eventIdSet.add(entry.eventId);
        }
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

    /**
     * Get the first user message in the conversation (for meta model keyword detection).
     * Returns the first message from a non-agent pubkey.
     */
    getFirstUserMessage(): (ConversationEntry & { id: number }) | undefined {
        for (let i = 0; i < this.state.messages.length; i++) {
            const msg = this.state.messages[i];
            // Skip agent messages and tool messages
            if (
                msg.messageType === "text" &&
                !ConversationStore.agentPubkeys.has(msg.pubkey)
            ) {
                return { ...msg, id: i };
            }
        }
        return undefined;
    }

    /**
     * Update the content of a message by its index.
     * Used for meta model keyword stripping.
     */
    updateMessageContent(messageIndex: number, newContent: string): void {
        if (messageIndex >= 0 && messageIndex < this.state.messages.length) {
            this.state.messages[messageIndex].content = newContent;
        }
    }

    /**
     * Get the meta model variant override for a specific agent.
     * @param agentPubkey - The agent's pubkey
     * @returns The variant name if set, undefined otherwise
     */
    getMetaModelVariantOverride(agentPubkey: string): string | undefined {
        return this.state.metaModelVariantOverride?.[agentPubkey];
    }

    /**
     * Set a meta model variant override for a specific agent.
     * This variant will be used for subsequent turns instead of keyword detection.
     * @param agentPubkey - The agent's pubkey
     * @param variantName - The variant name to use
     */
    setMetaModelVariantOverride(agentPubkey: string, variantName: string): void {
        if (!this.state.metaModelVariantOverride) {
            this.state.metaModelVariantOverride = {};
        }
        this.state.metaModelVariantOverride[agentPubkey] = variantName;
    }

    /**
     * Clear the meta model variant override for a specific agent.
     * This reverts to keyword-based variant detection.
     * @param agentPubkey - The agent's pubkey
     */
    clearMetaModelVariantOverride(agentPubkey: string): void {
        if (this.state.metaModelVariantOverride) {
            delete this.state.metaModelVariantOverride[agentPubkey];
        }
    }

    /**
     * Check if a tool call with the given toolCallId exists.
     */
    hasToolCall(toolCallId: string): boolean {
        return this.state.messages.some(
            (m) =>
                m.messageType === "tool-call" &&
                (m.toolData as ToolCallPart[] | undefined)?.some(
                    (part) => part.toolCallId === toolCallId
                )
        );
    }

    /**
     * Check if a tool result with the given toolCallId exists.
     */
    hasToolResult(toolCallId: string): boolean {
        return this.state.messages.some(
            (m) =>
                m.messageType === "tool-result" &&
                (m.toolData as ToolResultPart[] | undefined)?.some(
                    (part) => part.toolCallId === toolCallId
                )
        );
    }

    // Injection Operations

    addInjection(injection: Injection): void {
        this.state.injections.push(injection);
    }

    getPendingInjections(agentPubkey: string, ralNumber: number): Injection[] {
        return this.state.injections.filter(
            (i) =>
                i.targetRal.pubkey === agentPubkey &&
                i.targetRal.ral === ralNumber
        );
    }

    consumeInjections(agentPubkey: string, ralNumber: number): Injection[] {
        const toConsume = this.getPendingInjections(agentPubkey, ralNumber);

        // Remove from injections
        this.state.injections = this.state.injections.filter(
            (i) =>
                !(
                    i.targetRal.pubkey === agentPubkey &&
                    i.targetRal.ral === ralNumber
                )
        );

        // Add to messages - injections are text messages with targeting based on role
        for (const injection of toConsume) {
            this.addMessage({
                pubkey: agentPubkey, // Injection appears as coming from the target agent context
                ral: ralNumber,
                content: injection.content,
                messageType: "text",
                // If injection role is "user", it's targeted to this agent
                // If "system", it's a broadcast
                targetedPubkeys: injection.role === "user" ? [agentPubkey] : undefined,
                suppressAttribution: injection.suppressAttribution,
            });
        }

        return toConsume;
    }

    // Message Building

    /**
     * Derive the appropriate role for a message based on viewer perspective.
     *
     * Rules:
     * - assistant: Only for the viewing agent's own messages
     * - user: All other messages (regardless of targeting)
     * - tool: Tool results (fixed)
     *
     * The [@sender -> @recipient] prefix provides attribution context,
     * so role no longer needs to distinguish between targeted and observing.
     */
    private deriveRole(
        entry: ConversationEntry,
        viewingAgentPubkey: string
    ): "user" | "assistant" | "tool" {
        // Tool messages have fixed roles
        if (entry.messageType === "tool-call") return "assistant";
        if (entry.messageType === "tool-result") return "tool";

        // Text messages - assistant for own, user for everything else
        if (entry.pubkey === viewingAgentPubkey) {
            return "assistant"; // Own messages
        }

        return "user"; // All non-self messages
    }

    /**
     * Format content with [@sender -> @recipient] attribution prefix.
     */
    private async formatWithAttribution(
        entry: ConversationEntry,
        content: string
    ): Promise<string> {
        const pubkeyService = getPubkeyService();
        const senderName = await pubkeyService.getName(entry.pubkey);

        // Build recipient names if targeted
        let prefix: string;
        if (entry.targetedPubkeys && entry.targetedPubkeys.length > 0) {
            const recipientNames = await Promise.all(
                entry.targetedPubkeys.map((pk) => pubkeyService.getName(pk))
            );
            prefix = `[@${senderName} -> @${recipientNames.join(", @")}]`;
        } else {
            // Broadcast - no recipient
            prefix = `[@${senderName}]`;
        }

        return `${prefix} ${content}`;
    }

    /**
     * Convert a ConversationEntry to a ModelMessage for the viewing agent.
     *
     * For text messages containing image URLs, the content is converted to
     * multimodal format (TextPart + ImagePart array) for AI SDK compatibility.
     */
    private async entryToMessage(
        entry: ConversationEntry,
        viewingAgentPubkey: string,
        truncationContext?: TruncationContext
    ): Promise<ModelMessage> {
        const role = this.deriveRole(entry, viewingAgentPubkey);

        if (entry.messageType === "tool-call" && entry.toolData) {
            return { role: "assistant", content: entry.toolData as ToolCallPart[] };
        }

        if (entry.messageType === "tool-result" && entry.toolData) {
            // Apply truncation for buried tool results to save context
            const toolData = truncationContext
                ? processToolResult(entry.toolData as ToolResultPart[], truncationContext)
                : (entry.toolData as ToolResultPart[]);
            return { role: "tool", content: toolData };
        }

        // Text message - add attribution prefix
        const formattedContent = entry.suppressAttribution
            ? entry.content
            : await this.formatWithAttribution(entry, entry.content);

        // Convert to multimodal format if content contains image URLs
        // This allows the AI SDK to fetch and process images automatically
        const content = convertToMultimodalContent(formattedContent);

        return { role, content } as ModelMessage;
    }

    private async buildMessagesFromEntries(
        entries: ConversationEntry[],
        agentPubkey: string,
        ralNumber: number,
        activeRals: Set<number>,
        indexOffset: number = 0
    ): Promise<ModelMessage[]> {
        const result: ModelMessage[] = [];
        const delegationCompletionPrefix = "# DELEGATION COMPLETED";
        const latestDelegationCompletionIndexByRal = new Map<number, number>();
        const getDelegationCompletionRal = (entry: ConversationEntry): number | undefined => {
            if (entry.messageType !== "text") return undefined;
            if (typeof entry.ral !== "number") return undefined;
            if (!entry.content.trimStart().startsWith(delegationCompletionPrefix)) return undefined;
            if (!(entry.targetedPubkeys?.includes(agentPubkey) ?? false)) return undefined;
            return entry.ral;
        };

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const ral = getDelegationCompletionRal(entry);
            if (ral !== undefined) {
                latestDelegationCompletionIndexByRal.set(ral, i);
            }
        }

        let prunedDelegationCompletions = 0;
        const totalMessages = this.state.messages.length;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const ral = getDelegationCompletionRal(entry);
            if (ral !== undefined) {
                const latestIndex = latestDelegationCompletionIndexByRal.get(ral);
                if (latestIndex !== undefined && latestIndex !== i) {
                    prunedDelegationCompletions += 1;
                    continue;
                }
            }

            // Create truncation context for tool result processing
            // indexOffset is used when processing a slice of messages (e.g., buildMessagesForRalAfterIndex)
            const truncationContext: TruncationContext = {
                currentIndex: indexOffset + i,
                totalMessages,
                eventId: entry.eventId,
            };

            // User messages (no RAL) - include with derived role
            if (!entry.ral) {
                result.push(await this.entryToMessage(entry, agentPubkey, truncationContext));
                continue;
            }

            // Same agent
            if (entry.pubkey === agentPubkey) {
                if (entry.ral === ralNumber) {
                    // Current RAL - include
                    result.push(await this.entryToMessage(entry, agentPubkey, truncationContext));
                } else if (activeRals.has(entry.ral)) {
                    // Other active RAL - skip to avoid message duplication
                    continue;
                } else {
                    // Completed RAL - include all
                    result.push(await this.entryToMessage(entry, agentPubkey, truncationContext));
                }
            } else {
                // Other agent's message - only include text content
                if (entry.messageType === "text" && entry.content) {
                    result.push(await this.entryToMessage(entry, agentPubkey, truncationContext));
                }
            }
        }

        if (prunedDelegationCompletions > 0) {
            trace.getActiveSpan?.()?.addEvent("conversation.delegation_completion_pruned", {
                "delegation.pruned_count": prunedDelegationCompletions,
                "delegation.kept_count": latestDelegationCompletionIndexByRal.size,
            });
        }

        return result;
    }

    async buildMessagesForRal(
        agentPubkey: string,
        ralNumber: number
    ): Promise<ModelMessage[]> {
        const activeRals = new Set(this.getActiveRals(agentPubkey));
        return this.buildMessagesFromEntries(this.state.messages, agentPubkey, ralNumber, activeRals);
    }

    async buildMessagesForRalAfterIndex(
        agentPubkey: string,
        ralNumber: number,
        afterIndex: number
    ): Promise<ModelMessage[]> {
        const activeRals = new Set(this.getActiveRals(agentPubkey));
        const startIndex = Math.max(afterIndex + 1, 0);

        if (startIndex >= this.state.messages.length) {
            return [];
        }

        const entries = this.state.messages.slice(startIndex);
        // Pass startIndex as offset so truncation context knows the true position
        return this.buildMessagesFromEntries(entries, agentPubkey, ralNumber, activeRals, startIndex);
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

    // Todo Nudge Operations

    hasBeenNudgedAboutTodos(agentPubkey: string): boolean {
        return this.state.todoNudgedAgents.includes(agentPubkey);
    }

    setNudgedAboutTodos(agentPubkey: string): void {
        if (!this.state.todoNudgedAgents.includes(agentPubkey)) {
            this.state.todoNudgedAgents.push(agentPubkey);
        }
    }

    // Todo Reminder Operations (for incomplete todos)

    hasBeenRemindedAboutTodos(agentPubkey: string): boolean {
        return this.state.todoRemindedAgents.includes(agentPubkey);
    }

    setRemindedAboutTodos(agentPubkey: string): void {
        if (!this.state.todoRemindedAgents.includes(agentPubkey)) {
            this.state.todoRemindedAgents.push(agentPubkey);
        }
    }

    // Blocked Agents Operations

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

    /**
     * Extract targeted pubkeys from an event's p-tags.
     * Returns all p-tagged pubkeys (agents and users alike).
     */
    private static extractTargetedPubkeys(event: NDKEvent): string[] {
        const pTags = event.getMatchingTags("p");
        if (pTags.length === 0) return [];

        const targeted: string[] = [];
        for (const pTag of pTags) {
            const pubkey = pTag[1];
            if (pubkey) {
                targeted.push(pubkey);
            }
        }
        return targeted;
    }

    /**
     * Add an NDKEvent as a message entry.
     * Only kind:1 (text) events are stored in conversations.
     * Stores the content and targeting info; role is derived during message building.
     */
    addEventMessage(event: NDKEvent, isFromAgent: boolean): void {
        if (!event.id) return;

        // Only store kind:1 (text) events in conversations
        if (event.kind !== 1) return;

        // Skip tool announcement events (e.g., "Executing: ls -la", "Reading /path/to/file")
        // These are redundant since tool calls/results are stored directly via ToolMessageStorage
        if (event.tagValue("tool")) return;

        // Skip if already added
        if (this.hasEventId(event.id)) return;

        // Extract targeted agent pubkeys from p-tags
        const targetedPubkeys = ConversationStore.extractTargetedPubkeys(event);

        this.addMessage({
            pubkey: event.pubkey,
            content: event.content,
            messageType: "text",
            eventId: event.id,
            timestamp: event.created_at,
            targetedPubkeys: targetedPubkeys.length > 0 ? targetedPubkeys : undefined,
        });

        // Track last user message for metadata
        if (!isFromAgent) {
            this.state.metadata.last_user_message = event.content;
        }
    }
}

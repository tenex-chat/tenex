import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectDTag } from "@/types/project-ids";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { ConversationRecordInput } from "./types";
import type { ConversationStore } from "./ConversationStore";
import {
    getConversationRecordAuthorPrincipalId,
    getConversationRecordAuthorPubkey,
} from "./record-author";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunDatabase = any;

function createBunDatabase(dbPath: string): BunDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath);
}

const CATALOG_DB_FILENAME = "conversation-catalog.db";
const CATALOG_SCHEMA_VERSION = "2";
const CATALOG_META_SCHEMA_VERSION_KEY = "schema_version";
const CATALOG_META_LAST_REBUILD_AT_KEY = "last_rebuild_at";
const CATALOG_META_LAST_RECONCILE_AT_KEY = "last_reconcile_at";

interface ConversationSourceStats {
    mtimeMs: number;
    sizeBytes: number;
}

interface CatalogConversationSnapshot {
    conversationId: string;
    title?: string;
    summary?: string;
    lastUserMessage?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    participants: ConversationCatalogParticipant[];
    delegationIds: string[];
    sourceStats: ConversationSourceStats;
}

export interface ConversationCatalogPreview {
    id: string;
    title?: string;
    summary?: string;
    lastUserMessage?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity: number;
}

export interface ConversationCatalogParticipant {
    participantKey: string;
    linkedPubkey?: string;
    principalId?: string;
    transport?: string;
    displayName?: string;
    username?: string;
    kind?: "agent" | "human" | "system";
    isAgent: boolean;
}

export interface ConversationCatalogProjection {
    title?: string;
    summary?: string;
    lastUserMessage?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    participants: ConversationCatalogParticipant[];
    delegationIds: string[];
}

export interface ConversationCatalogListEntry extends ConversationCatalogPreview {
    participants: ConversationCatalogParticipant[];
    delegationIds: string[];
}

interface ConversationRow {
    conversation_id: string;
    title: string | null;
    summary: string | null;
    last_user_message: string | null;
    status_label: string | null;
    status_current_activity: string | null;
    message_count: number;
    created_at: number | null;
    last_activity: number | null;
}

interface ConversationParticipantRow {
    conversation_id: string;
    participant_key: string;
    linked_pubkey: string | null;
    principal_id: string | null;
    transport: string | null;
    display_name: string | null;
    username: string | null;
    kind: "agent" | "human" | "system" | null;
    is_agent: number;
}

interface ConversationDelegationRow {
    conversation_id: string;
    delegation_conversation_id: string;
}

interface EmbeddingStateRow {
    metadata_hash: string;
    last_indexed_at: number;
    no_content: number;
    content_version: string | null;
    document_ids: string | null;
}

interface ReconcileRow {
    conversation_id: string;
    source_mtime_ms: number;
    source_size_bytes: number;
}

function normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureDirectory(directoryPath: string): void {
    if (!existsSync(directoryPath)) {
        mkdirSync(directoryPath, { recursive: true });
    }
}

function asConversationRecords(raw: unknown): ConversationRecordInput[] {
    return Array.isArray(raw) ? raw as ConversationRecordInput[] : [];
}

function buildInClause(size: number): string {
    return Array.from({ length: size }, () => "?").join(", ");
}

export function buildConversationCatalogProjection(
    rawMetadata: Record<string, unknown> | undefined,
    messages: ConversationRecordInput[],
    agentPubkeys: ReadonlySet<string>
): ConversationCatalogProjection {
    const metadata = rawMetadata ?? {};
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const participants = new Map<string, ConversationCatalogParticipant>();
    const delegationIds = new Set<string>();

    for (const message of messages) {
        const participantKey =
            getConversationRecordAuthorPrincipalId(message)
            ?? getConversationRecordAuthorPubkey(message);
        if (participantKey && !participants.has(participantKey)) {
            const linkedPubkey = getConversationRecordAuthorPubkey(message);
            const kind = message.senderPrincipal?.kind;
            participants.set(participantKey, {
                participantKey,
                linkedPubkey,
                principalId: getConversationRecordAuthorPrincipalId(message),
                transport: message.senderPrincipal?.transport,
                displayName: normalizeOptionalString(message.senderPrincipal?.displayName),
                username: normalizeOptionalString(message.senderPrincipal?.username),
                kind,
                isAgent: kind === "agent" || (!!linkedPubkey && agentPubkeys.has(linkedPubkey)),
            });
        }

        if (
            message.messageType === "delegation-marker"
            && message.delegationMarker?.delegationConversationId
        ) {
            delegationIds.add(message.delegationMarker.delegationConversationId);
        }
    }

    return {
        title: normalizeOptionalString(metadata.title),
        summary: normalizeOptionalString(metadata.summary),
        lastUserMessage:
            normalizeOptionalString(metadata.lastUserMessage)
            ?? normalizeOptionalString(metadata.last_user_message),
        statusLabel: normalizeOptionalString(metadata.statusLabel),
        statusCurrentActivity: normalizeOptionalString(metadata.statusCurrentActivity),
        messageCount: messages.length,
        createdAt: normalizeOptionalNumber(firstMessage?.timestamp),
        lastActivity: normalizeOptionalNumber(lastMessage?.timestamp),
        participants: Array.from(participants.values()),
        delegationIds: Array.from(delegationIds),
    };
}

export class ConversationCatalogService {
    private static readonly instances = new Map<string, ConversationCatalogService>();

    private readonly projectId: ProjectDTag;
    private metadataPath: string;
    private dbPath: string;
    private agentPubkeys = new Set<string>();
    private db: BunDatabase | null = null;
    private initialized = false;

    private constructor(projectId: ProjectDTag, metadataPath: string) {
        this.projectId = projectId;
        this.metadataPath = metadataPath;
        this.dbPath = join(metadataPath, CATALOG_DB_FILENAME);
    }

    static getInstance(
        projectId: ProjectDTag,
        metadataPath: string = config.getProjectMetadataPath(projectId),
        agentPubkeys?: Iterable<string>
    ): ConversationCatalogService {
        const key = `${projectId}:${metadataPath}`;
        let instance = ConversationCatalogService.instances.get(key);
        if (!instance) {
            instance = new ConversationCatalogService(projectId, metadataPath);
            ConversationCatalogService.instances.set(key, instance);
        } else {
            instance.metadataPath = metadataPath;
            instance.dbPath = join(metadataPath, CATALOG_DB_FILENAME);
        }

        if (agentPubkeys) {
            instance.setAgentPubkeys(agentPubkeys);
        }

        return instance;
    }

    static flushAll(): void {
        for (const instance of ConversationCatalogService.instances.values()) {
            instance.flushNow();
        }
    }

    static closeProject(
        projectId: ProjectDTag,
        metadataPath: string = config.getProjectMetadataPath(projectId)
    ): void {
        const key = `${projectId}:${metadataPath}`;
        const instance = ConversationCatalogService.instances.get(key);
        if (!instance) {
            return;
        }

        instance.close();
        ConversationCatalogService.instances.delete(key);
    }

    static resetAll(): void {
        for (const [key, instance] of ConversationCatalogService.instances.entries()) {
            instance.close();
            ConversationCatalogService.instances.delete(key);
        }
    }

    setAgentPubkeys(agentPubkeys: Iterable<string>): void {
        this.agentPubkeys = new Set(agentPubkeys);
    }

    initialize(): void {
        if (this.initialized && this.db) {
            return;
        }

        ensureDirectory(this.metadataPath);

        const dbExisted = existsSync(this.dbPath);

        try {
            this.db = createBunDatabase(this.dbPath);
            this.configureDatabase();
            this.createSchema();

            const version = this.getMetaValue(CATALOG_META_SCHEMA_VERSION_KEY);
            if (!dbExisted || version !== CATALOG_SCHEMA_VERSION) {
                if (dbExisted && version !== null && version !== CATALOG_SCHEMA_VERSION) {
                    logger.info("[ConversationCatalogService] Schema version mismatch, rebuilding catalog", {
                        projectId: this.projectId,
                        found: version,
                        expected: CATALOG_SCHEMA_VERSION,
                    });
                    this.resetDatabase();
                } else {
                    this.setMetaValue(CATALOG_META_SCHEMA_VERSION_KEY, CATALOG_SCHEMA_VERSION);
                    this.rebuildFromDisk();
                }
            }

            this.initialized = true;
        } catch (error) {
            logger.warn("[ConversationCatalogService] Failed to initialize catalog, resetting database", {
                projectId: this.projectId,
                error: error instanceof Error ? error.message : String(error),
            });
            this.resetDatabase();
            this.initialized = true;
        }
    }

    reconcile(): void {
        this.initialize();

        const db = this.ensureDb();
        const rows = db.prepare(
            "SELECT conversation_id, source_mtime_ms, source_size_bytes FROM conversations"
        ).all() as ReconcileRow[];
        const existing = new Map(rows.map((row) => [row.conversation_id, row]));
        const seen = new Set<string>();

        for (const entry of this.listConversationFiles()) {
            seen.add(entry.conversationId);

            const current = existing.get(entry.conversationId);
            if (
                !current
                || current.source_mtime_ms !== entry.sourceStats.mtimeMs
                || current.source_size_bytes !== entry.sourceStats.sizeBytes
            ) {
                this.upsertFromFile(entry.conversationId, entry.filePath, entry.sourceStats);
            }
        }

        const deleteConversation = db.prepare("DELETE FROM conversations WHERE conversation_id = ?");
        const deleteTransaction = db.transaction((conversationIds: string[]) => {
            for (const conversationId of conversationIds) {
                deleteConversation.run(conversationId);
            }
        });

        const deletedConversationIds = rows
            .map((row) => row.conversation_id)
            .filter((conversationId) => !seen.has(conversationId));
        if (deletedConversationIds.length > 0) {
            deleteTransaction(deletedConversationIds);
        }

        this.setMetaValue(CATALOG_META_LAST_RECONCILE_AT_KEY, String(Date.now()));
    }

    rebuildFromDisk(): void {
        this.initializeSchemaOnly();

        const db = this.ensureDb();
        db.exec("DELETE FROM conversation_embedding_state");
        db.exec("DELETE FROM conversation_delegations");
        db.exec("DELETE FROM conversation_participants");
        db.exec("DELETE FROM conversations");

        for (const entry of this.listConversationFiles()) {
            this.upsertFromFile(entry.conversationId, entry.filePath, entry.sourceStats);
        }

        this.setMetaValue(CATALOG_META_SCHEMA_VERSION_KEY, CATALOG_SCHEMA_VERSION);
        this.setMetaValue(CATALOG_META_LAST_REBUILD_AT_KEY, String(Date.now()));
        this.setMetaValue(CATALOG_META_LAST_RECONCILE_AT_KEY, String(Date.now()));
    }

    upsertFromStore(store: ConversationStore): void {
        this.initialize();

        const projectId = store.getProjectId();
        if (projectId !== this.projectId) {
            logger.warn("[ConversationCatalogService] Ignoring store upsert for mismatched project", {
                expectedProjectId: this.projectId,
                actualProjectId: projectId,
                conversationId: store.id,
            });
            return;
        }

        const filePath = this.getConversationFilePath(store.id);
        const sourceStats = existsSync(filePath)
            ? this.readSourceStats(filePath)
            : { mtimeMs: Date.now(), sizeBytes: 0 };

        const snapshot = this.buildSnapshotFromStore(store, sourceStats);
        this.writeSnapshot(snapshot);
    }

    getPreview(conversationId: string): ConversationCatalogPreview | null {
        this.initialize();

        const row = this.ensureDb().prepare(
            `SELECT conversation_id, title, summary, last_user_message, status_label,
                    status_current_activity, message_count, created_at, last_activity
             FROM conversations
             WHERE conversation_id = ?`
        ).get(conversationId) as ConversationRow | undefined;

        if (!row) {
            return null;
        }

        return this.toPreview(row);
    }

    hasParticipant(conversationId: string, participantPubkey: string): boolean {
        this.initialize();

        const result = this.ensureDb().prepare(
            `SELECT 1
             FROM conversation_participants
             WHERE conversation_id = ? AND linked_pubkey = ?
             LIMIT 1`
        ).get(conversationId, participantPubkey) as { 1: number } | undefined;

        return !!result;
    }

    queryRecentForParticipant(args: {
        participantPubkey: string;
        excludeConversationId?: string;
        since: number;
        limit: number;
    }): ConversationCatalogPreview[] {
        this.reconcile();

        const rows = this.ensureDb().prepare(
            `SELECT DISTINCT
                    c.conversation_id,
                    c.title,
                    c.summary,
                    c.last_user_message,
                    c.status_label,
                    c.status_current_activity,
                    c.message_count,
                    c.created_at,
                    c.last_activity
             FROM conversations c
             JOIN conversation_participants p
               ON p.conversation_id = c.conversation_id
             WHERE p.linked_pubkey = ?
               AND COALESCE(c.last_activity, 0) >= ?
               AND (? IS NULL OR c.conversation_id != ?)
             ORDER BY COALESCE(c.last_activity, 0) DESC,
                      COALESCE(c.created_at, 0) DESC,
                      c.conversation_id ASC
             LIMIT ?`
        ).all(
            args.participantPubkey,
            args.since,
            args.excludeConversationId ?? null,
            args.excludeConversationId ?? null,
            args.limit
        ) as ConversationRow[];

        return rows.map((row) => this.toPreview(row));
    }

    listConversations(args: {
        fromTime?: number;
        toTime?: number;
        participantPubkey?: string;
        limit?: number;
    }): ConversationCatalogListEntry[] {
        this.reconcile();

        const rows = this.ensureDb().prepare(
            `SELECT conversation_id, title, summary, last_user_message, status_label,
                    status_current_activity, message_count, created_at, last_activity
             FROM conversations c
             WHERE (? IS NULL OR COALESCE(c.last_activity, 0) >= ?)
               AND (? IS NULL OR COALESCE(c.last_activity, 0) <= ?)
               AND (
                    ? IS NULL OR EXISTS (
                        SELECT 1
                        FROM conversation_participants p
                        WHERE p.conversation_id = c.conversation_id
                          AND p.linked_pubkey = ?
                    )
               )
             ORDER BY COALESCE(c.last_activity, 0) DESC,
                      COALESCE(c.created_at, 0) DESC,
                      c.conversation_id ASC
             LIMIT ?`
        ).all(
            args.fromTime ?? null,
            args.fromTime ?? null,
            args.toTime ?? null,
            args.toTime ?? null,
            args.participantPubkey ?? null,
            args.participantPubkey ?? null,
            args.limit ?? Number.MAX_SAFE_INTEGER
        ) as ConversationRow[];

        if (rows.length === 0) {
            return [];
        }

        const conversationIds = rows.map((row) => row.conversation_id);
        const participantsByConversation = this.loadParticipants(conversationIds);
        const delegationsByConversation = this.loadDelegations(conversationIds);

        return rows.map((row) => ({
            ...this.toPreview(row),
            participants: participantsByConversation.get(row.conversation_id) ?? [],
            delegationIds: delegationsByConversation.get(row.conversation_id) ?? [],
        }));
    }

    getEmbeddingState(conversationId: string): {
        metadataHash: string;
        lastIndexedAt: number;
        noContent: boolean;
        contentVersion: string | null;
        documentIds: string[];
    } | null {
        this.initialize();

        const row = this.ensureDb().prepare(
            `SELECT metadata_hash, last_indexed_at, no_content, content_version, document_ids
             FROM conversation_embedding_state
             WHERE conversation_id = ?`
        ).get(conversationId) as EmbeddingStateRow | undefined;

        if (!row) {
            return null;
        }

        return {
            metadataHash: row.metadata_hash,
            lastIndexedAt: row.last_indexed_at,
            noContent: !!row.no_content,
            contentVersion: row.content_version ?? null,
            documentIds: this.parseEmbeddingDocumentIds(row.document_ids),
        };
    }

    setEmbeddingState(
        conversationId: string,
        state: {
            metadataHash: string;
            lastIndexedAt: number;
            noContent: boolean;
            contentVersion?: string;
            documentIds?: string[];
        }
    ): void {
        this.initialize();

        this.ensureDb().prepare(
            `INSERT INTO conversation_embedding_state (
                conversation_id, metadata_hash, last_indexed_at, no_content, content_version, document_ids
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
                metadata_hash = excluded.metadata_hash,
                last_indexed_at = excluded.last_indexed_at,
                no_content = excluded.no_content,
                content_version = excluded.content_version,
                document_ids = excluded.document_ids`
        ).run(
            conversationId,
            state.metadataHash,
            state.lastIndexedAt,
            state.noContent ? 1 : 0,
            state.contentVersion ?? null,
            JSON.stringify(state.documentIds ?? [])
        );
    }

    clearEmbeddingState(conversationId: string): void {
        this.initialize();
        this.ensureDb().prepare(
            "DELETE FROM conversation_embedding_state WHERE conversation_id = ?"
        ).run(conversationId);
    }

    clearAllEmbeddingState(): void {
        this.initialize();
        this.ensureDb().exec("DELETE FROM conversation_embedding_state");
    }

    getEmbeddingStateCount(): number {
        this.initialize();

        const result = this.ensureDb().prepare(
            "SELECT COUNT(*) as count FROM conversation_embedding_state"
        ).get() as { count: number };
        return result.count;
    }

    flushNow(): void {
        if (!this.db) {
            return;
        }

        try {
            this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        } catch (error) {
            logger.debug("[ConversationCatalogService] WAL checkpoint failed", {
                projectId: this.projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    close(): void {
        this.flushNow();

        if (this.db) {
            this.db.close();
            this.db = null;
        }

        this.initialized = false;
    }

    private ensureDb(): BunDatabase {
        if (!this.db) {
            throw new Error("Conversation catalog database is not initialized");
        }
        return this.db;
    }

    private configureDatabase(): void {
        const db = this.ensureDb();
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec("PRAGMA busy_timeout = 5000");
    }

    private createSchema(): void {
        const db = this.ensureDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS catalog_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                conversation_id TEXT PRIMARY KEY,
                title TEXT,
                summary TEXT,
                last_user_message TEXT,
                status_label TEXT,
                status_current_activity TEXT,
                created_at INTEGER,
                last_activity INTEGER,
                message_count INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source_mtime_ms INTEGER NOT NULL,
                source_size_bytes INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_conversations_last_activity
                ON conversations(last_activity DESC);

            CREATE TABLE IF NOT EXISTS conversation_participants (
                conversation_id TEXT NOT NULL,
                participant_key TEXT NOT NULL,
                linked_pubkey TEXT,
                principal_id TEXT,
                transport TEXT,
                display_name TEXT,
                username TEXT,
                kind TEXT,
                is_agent INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (conversation_id, participant_key),
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(conversation_id)
                    ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_conversation_participants_linked_pubkey
                ON conversation_participants(linked_pubkey);

            CREATE INDEX IF NOT EXISTS idx_conversation_participants_principal_id
                ON conversation_participants(principal_id);

            CREATE TABLE IF NOT EXISTS conversation_delegations (
                conversation_id TEXT NOT NULL,
                delegation_conversation_id TEXT NOT NULL,
                PRIMARY KEY (conversation_id, delegation_conversation_id),
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(conversation_id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS conversation_embedding_state (
                conversation_id TEXT PRIMARY KEY,
                metadata_hash TEXT NOT NULL,
                last_indexed_at INTEGER NOT NULL,
                no_content INTEGER NOT NULL DEFAULT 0,
                content_version TEXT,
                document_ids TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(conversation_id)
                    ON DELETE CASCADE
            );
        `);
        this.ensureEmbeddingStateColumns();
    }

    private ensureEmbeddingStateColumns(): void {
        const db = this.ensureDb();
        const columns = db.prepare("PRAGMA table_info(conversation_embedding_state)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "document_ids")) {
            db.exec("ALTER TABLE conversation_embedding_state ADD COLUMN document_ids TEXT NOT NULL DEFAULT '[]'");
        }
    }

    private parseEmbeddingDocumentIds(value: string | null): string[] {
        if (!value) {
            return [];
        }
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.filter((entry): entry is string => typeof entry === "string");
            }
        } catch {
            return [];
        }
        return [];
    }

    private initializeSchemaOnly(): void {
        if (!this.db) {
            ensureDirectory(this.metadataPath);
            this.db = createBunDatabase(this.dbPath);
            this.configureDatabase();
        }
        this.createSchema();
        this.initialized = true;
    }

    private resetDatabase(): void {
        this.close();

        for (const suffix of ["", "-wal", "-shm"]) {
            const target = `${this.dbPath}${suffix}`;
            if (existsSync(target)) {
                rmSync(target, { force: true });
            }
        }

        this.db = createBunDatabase(this.dbPath);
        this.configureDatabase();
        this.createSchema();
        this.setMetaValue(CATALOG_META_SCHEMA_VERSION_KEY, CATALOG_SCHEMA_VERSION);
        this.rebuildFromDisk();
        this.initialized = true;
    }

    private getMetaValue(key: string): string | null {
        const row = this.ensureDb().prepare(
            "SELECT value FROM catalog_meta WHERE key = ?"
        ).get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    private setMetaValue(key: string, value: string): void {
        this.ensureDb().prepare(
            `INSERT INTO catalog_meta (key, value)
             VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(key, value);
    }

    private listConversationFiles(): Array<{
        conversationId: string;
        filePath: string;
        sourceStats: ConversationSourceStats;
    }> {
        const conversationsDir = join(this.metadataPath, "conversations");
        if (!existsSync(conversationsDir)) {
            return [];
        }

        return readdirSync(conversationsDir)
            .filter((fileName) => fileName.endsWith(".json"))
            .map((fileName) => {
                const filePath = join(conversationsDir, fileName);
                return {
                    conversationId: fileName.replace(/\.json$/u, ""),
                    filePath,
                    sourceStats: this.readSourceStats(filePath),
                };
            });
    }

    private readSourceStats(filePath: string): ConversationSourceStats {
        const stats = statSync(filePath);
        return {
            mtimeMs: Math.floor(stats.mtimeMs),
            sizeBytes: stats.size,
        };
    }

    private getConversationFilePath(conversationId: string): string {
        return join(this.metadataPath, "conversations", `${conversationId}.json`);
    }

    private upsertFromFile(
        conversationId: string,
        filePath: string,
        sourceStats: ConversationSourceStats
    ): void {
        const snapshot = this.buildSnapshotFromDisk(conversationId, filePath, sourceStats);
        if (!snapshot) {
            return;
        }

        this.writeSnapshot(snapshot);
    }

    private buildSnapshotFromDisk(
        conversationId: string,
        filePath: string,
        sourceStats: ConversationSourceStats
    ): CatalogConversationSnapshot | null {
        try {
            const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
                metadata?: Record<string, unknown>;
                messages?: unknown;
            };

            return this.buildSnapshotFromRawState(
                conversationId,
                parsed.metadata,
                asConversationRecords(parsed.messages),
                sourceStats
            );
        } catch (error) {
            logger.warn("[ConversationCatalogService] Failed to parse conversation transcript during reconcile", {
                projectId: this.projectId,
                conversationId,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private buildSnapshotFromStore(
        store: ConversationStore,
        sourceStats: ConversationSourceStats
    ): CatalogConversationSnapshot {
        return this.buildSnapshotFromRawState(
            store.id,
            store.metadata as Record<string, unknown> | undefined,
            store.getAllMessages(),
            sourceStats
        );
    }

    private buildSnapshotFromRawState(
        conversationId: string,
        rawMetadata: Record<string, unknown> | undefined,
        messages: ConversationRecordInput[],
        sourceStats: ConversationSourceStats
    ): CatalogConversationSnapshot {
        const projection = buildConversationCatalogProjection(
            rawMetadata,
            messages,
            this.agentPubkeys
        );

        return {
            conversationId,
            ...projection,
            sourceStats,
        };
    }

    private writeSnapshot(snapshot: CatalogConversationSnapshot): void {
        const db = this.ensureDb();
        const upsertConversation = db.prepare(
            `INSERT INTO conversations (
                conversation_id, title, summary, last_user_message, status_label,
                status_current_activity, created_at, last_activity, message_count,
                updated_at, source_mtime_ms, source_size_bytes
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                last_user_message = excluded.last_user_message,
                status_label = excluded.status_label,
                status_current_activity = excluded.status_current_activity,
                created_at = excluded.created_at,
                last_activity = excluded.last_activity,
                message_count = excluded.message_count,
                updated_at = excluded.updated_at,
                source_mtime_ms = excluded.source_mtime_ms,
                source_size_bytes = excluded.source_size_bytes`
        );
        const deleteParticipants = db.prepare(
            "DELETE FROM conversation_participants WHERE conversation_id = ?"
        );
        const insertParticipant = db.prepare(
            `INSERT INTO conversation_participants (
                conversation_id, participant_key, linked_pubkey, principal_id, transport,
                display_name, username, kind, is_agent
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const deleteDelegations = db.prepare(
            "DELETE FROM conversation_delegations WHERE conversation_id = ?"
        );
        const insertDelegation = db.prepare(
            `INSERT INTO conversation_delegations (
                conversation_id, delegation_conversation_id
             ) VALUES (?, ?)`
        );

        const transaction = db.transaction((row: CatalogConversationSnapshot) => {
            upsertConversation.run(
                row.conversationId,
                row.title ?? null,
                row.summary ?? null,
                row.lastUserMessage ?? null,
                row.statusLabel ?? null,
                row.statusCurrentActivity ?? null,
                row.createdAt ?? null,
                row.lastActivity ?? null,
                row.messageCount,
                Date.now(),
                row.sourceStats.mtimeMs,
                row.sourceStats.sizeBytes
            );

            deleteParticipants.run(row.conversationId);
            for (const participant of row.participants) {
                insertParticipant.run(
                    row.conversationId,
                    participant.participantKey,
                    participant.linkedPubkey ?? null,
                    participant.principalId ?? null,
                    participant.transport ?? null,
                    participant.displayName ?? null,
                    participant.username ?? null,
                    participant.kind ?? null,
                    participant.isAgent ? 1 : 0
                );
            }

            deleteDelegations.run(row.conversationId);
            for (const delegationId of row.delegationIds) {
                insertDelegation.run(row.conversationId, delegationId);
            }
        });

        transaction(snapshot);
    }

    private loadParticipants(conversationIds: string[]): Map<string, ConversationCatalogParticipant[]> {
        if (conversationIds.length === 0) {
            return new Map();
        }

        const rows = this.ensureDb().prepare(
            `SELECT conversation_id, participant_key, linked_pubkey, principal_id, transport,
                    display_name, username, kind, is_agent
             FROM conversation_participants
             WHERE conversation_id IN (${buildInClause(conversationIds.length)})
             ORDER BY rowid ASC`
        ).all(...conversationIds) as ConversationParticipantRow[];

        const grouped = new Map<string, ConversationCatalogParticipant[]>();
        for (const row of rows) {
            const entries = grouped.get(row.conversation_id) ?? [];
            entries.push({
                participantKey: row.participant_key,
                linkedPubkey: row.linked_pubkey ?? undefined,
                principalId: row.principal_id ?? undefined,
                transport: row.transport ?? undefined,
                displayName: row.display_name ?? undefined,
                username: row.username ?? undefined,
                kind: row.kind ?? undefined,
                isAgent: !!row.is_agent,
            });
            grouped.set(row.conversation_id, entries);
        }

        return grouped;
    }

    private loadDelegations(conversationIds: string[]): Map<string, string[]> {
        if (conversationIds.length === 0) {
            return new Map();
        }

        const rows = this.ensureDb().prepare(
            `SELECT conversation_id, delegation_conversation_id
             FROM conversation_delegations
             WHERE conversation_id IN (${buildInClause(conversationIds.length)})
             ORDER BY rowid ASC`
        ).all(...conversationIds) as ConversationDelegationRow[];

        const grouped = new Map<string, string[]>();
        for (const row of rows) {
            const entries = grouped.get(row.conversation_id) ?? [];
            entries.push(row.delegation_conversation_id);
            grouped.set(row.conversation_id, entries);
        }

        return grouped;
    }

    private toPreview(row: ConversationRow): ConversationCatalogPreview {
        return {
            id: row.conversation_id,
            title: row.title ?? undefined,
            summary: row.summary ?? undefined,
            lastUserMessage: row.last_user_message ?? undefined,
            statusLabel: row.status_label ?? undefined,
            statusCurrentActivity: row.status_current_activity ?? undefined,
            messageCount: row.message_count,
            createdAt: row.created_at ?? undefined,
            lastActivity: row.last_activity ?? 0,
        };
    }
}

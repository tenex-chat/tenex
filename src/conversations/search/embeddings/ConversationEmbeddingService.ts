/**
 * ConversationEmbeddingService - Semantic search for conversations
 *
 * This service manages embeddings for conversation transcripts to enable
 * natural language semantic search across conversations.
 *
 * Key features:
 * - Embeds bounded transcript chunks, excluding tool results
 * - Uses existing RAG infrastructure (vector store, embedding providers)
 * - Supports hybrid search (semantic + keyword fallback)
 * - Project isolation: filters are applied DURING vector search (prefilter)
 * - Upsert semantics: re-indexing updates existing documents via bulkUpsert
 */

import { logger } from "@/utils/logger";
import { RAGService, type RAGDocument, type RAGQueryResult } from "@/services/rag/RAGService";
import { buildProjectFilter } from "@/services/search/projectFilter";
import { join } from "node:path";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import type { ProjectDTag } from "@/types/project-ids";
import { renderConversationXml, type ConversationXmlRenderResult } from "@/conversations/formatters/utils/conversation-transcript-formatter";
import { createHash } from "node:crypto";

/** Collection name for conversation embeddings */
const CONVERSATION_COLLECTION = "conversation_embeddings";
const MAX_EMBEDDING_CONTENT_CHARS = 12_000;

/**
 * Document structure for conversation embeddings
 */
export interface ConversationEmbeddingDocument {
    conversationId: string;
    projectId: string;
    title: string;
    summary?: string;
    embeddingContent: string; // Combined text used for embedding
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
}

/**
 * Result from semantic search
 */
export interface SemanticSearchResult {
    conversationId: string;
    projectId?: string;
    title?: string;
    summary?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    relevanceScore: number;
}

/**
 * Discriminated union result from buildDocument.
 * Distinguishes between "no indexable content" and transient errors
 * so the caller can decide whether to permanently mark as indexed
 * or leave for retry.
 */
export type BuildDocumentResult =
    | { kind: "ok"; documents: RAGDocument[] }
    | { kind: "noContent" }
    | { kind: "error"; reason: string };

/**
 * Options for semantic search
 */
export interface SemanticSearchOptions {
    limit?: number;
    minScore?: number;
    projectId?: string; // Filter by project, 'ALL' for all projects
}

/**
 * Service for managing conversation embeddings and semantic search
 */
export class ConversationEmbeddingService {
    private static instance: ConversationEmbeddingService | null = null;
    private ragService: RAGService;
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;

    private constructor() {
        this.ragService = RAGService.getInstance();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ConversationEmbeddingService {
        if (!ConversationEmbeddingService.instance) {
            ConversationEmbeddingService.instance = new ConversationEmbeddingService();
        }
        return ConversationEmbeddingService.instance;
    }

    /**
     * Initialize the service (creates collection if needed)
     * FIX #4: Clear initializationPromise on failure to allow retries
     */
    public async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = this.doInitialize();
        try {
            await this.initializationPromise;
        } catch (error) {
            // Clear promise on failure so subsequent calls can retry
            this.initializationPromise = null;
            throw error;
        }
    }

    private async doInitialize(): Promise<void> {
        try {
            logger.debug("Initializing ConversationEmbeddingService");

            // Check if collection exists
            const collections = await this.ragService.listCollections();
            if (!collections.includes(CONVERSATION_COLLECTION)) {
                // Create the collection
                await this.ragService.createCollection(CONVERSATION_COLLECTION);
                logger.info(`Created conversation embeddings collection: ${CONVERSATION_COLLECTION}`);
            } else {
                const [expectedDimensions, actualDimensions] = await Promise.all([
                    this.ragService.getEmbeddingDimensions(),
                    this.ragService.getCollectionDimensions(CONVERSATION_COLLECTION),
                ]);

                if (actualDimensions !== null && actualDimensions !== expectedDimensions) {
                    logger.warn("Recreating conversation embeddings collection due to vector dimension mismatch", {
                        collectionName: CONVERSATION_COLLECTION,
                        expectedDimensions,
                        actualDimensions,
                        embeddingProvider: await this.ragService.getEmbeddingProviderInfo(),
                    });
                    await this.ragService.deleteCollection(CONVERSATION_COLLECTION);
                    await this.ragService.createCollection(CONVERSATION_COLLECTION);
                    logger.info(`Recreated conversation embeddings collection: ${CONVERSATION_COLLECTION}`);
                }
            }

            this.initialized = true;
            logger.info("ConversationEmbeddingService initialized successfully");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to initialize ConversationEmbeddingService", { error: message });
            throw new Error(`ConversationEmbeddingService initialization failed: ${message}`, { cause: error });
        }
    }

    /**
     * Ensure service is initialized before operations
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initialize();
        }
    }

    /**
     * Render conversation messages to XML (with plain-text fallback) and compute a transcript fingerprint.
     *
     * Uses the shared transcript formatter to produce an XML representation of the
     * full conversation. This enables semantic search over the complete message
     * history rather than just metadata (title, summary).
     *
     * The fingerprint is a SHA-256 hash of the content. It is used by callers
     * (e.g. the indexing job) to detect when a conversation's transcript has changed
     * and needs re-embedding.
     *
     * When XML rendering fails (e.g. missing root event ID), falls back to a
     * plain-text representation built from the raw message content so embeddings
     * are never empty for conversations that have messages.
     *
     * @param conversationId - The conversation ID, passed to the XML renderer as a
     *   fallback root event ID when messages lack explicit eventId fields.
     * @param messages - The full list of messages in the conversation
     * @param fallbackTitle - Optional title for the plain-text fallback content
     * @returns { kind: 'ok'; transcriptChunks: string[]; fingerprint: string } on success,
     *          { kind: 'error' } only when there is truly no content to embed
     */
    private buildEmbeddingContent(
        conversationId: string,
        messages: import("@/conversations/types").ConversationRecordInput[],
        fallbackTitle?: string
    ): { kind: "ok"; transcriptChunks: string[]; fingerprint: string } | { kind: "error" } {
        // Try XML rendering first, passing conversationId so the renderer can
        // resolve the root event ID even when message eventId fields are absent.
        try {
            const transcriptChunks = this.renderTranscriptChunks(conversationId, messages);

            const hash = createHash("sha256");
            for (const chunk of transcriptChunks) {
                hash.update(chunk);
                hash.update("\n");
            }

            return { kind: "ok", transcriptChunks, fingerprint: hash.digest("hex") };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`XML transcript render failed for ${conversationId.substring(0, 8)}, using plain-text fallback: ${message}`);
        }

        // Plain-text fallback: concatenate all message contents so we still get
        // useful embeddings even when the XML renderer cannot produce output.
        const parts: string[] = [];
        if (fallbackTitle) {
            parts.push(fallbackTitle);
        }
        for (const msg of messages) {
            if (msg.messageType === "tool-result") {
                continue;
            }
            if (typeof msg.content === "string" && msg.content.trim()) {
                parts.push(msg.content.trim());
            }
        }

        if (parts.length === 0) {
            logger.debug(`No content to embed for conversation ${conversationId.substring(0, 8)}`);
            return { kind: "error" };
        }

        const plainText = parts.join("\n\n");
        const transcriptChunks = this.splitTextForEmbedding(plainText);
        const hash = createHash("sha256");
        for (const chunk of transcriptChunks) {
            hash.update(chunk);
            hash.update("\n");
        }
        return { kind: "ok", transcriptChunks, fingerprint: hash.digest("hex") };
    }

    private renderTranscriptChunks(
        conversationId: string,
        messages: import("@/conversations/types").ConversationRecordInput[]
    ): string[] {
        const chunks: string[] = [];
        let currentMessages: import("@/conversations/types").ConversationRecordInput[] = [];

        const flushCurrent = (): void => {
            const renderResult: ConversationXmlRenderResult = renderConversationXml(currentMessages, {
                conversationId,
                includeToolCalls: true,
            });
            chunks.push(renderResult.xml);
            currentMessages = [];
        };

        const expandedMessages = messages.flatMap((message) => this.splitOversizedMessage(message));
        if (expandedMessages.length === 0) {
            const renderResult: ConversationXmlRenderResult = renderConversationXml([], {
                conversationId,
                includeToolCalls: true,
            });
            return [renderResult.xml];
        }

        for (const message of expandedMessages) {
            const candidateMessages = [...currentMessages, message];
            const candidate = renderConversationXml(candidateMessages, {
                conversationId,
                includeToolCalls: true,
            }).xml;

            if (candidate.length <= MAX_EMBEDDING_CONTENT_CHARS || currentMessages.length === 0) {
                currentMessages = candidateMessages;
                continue;
            }

            flushCurrent();
            currentMessages = [message];

            const singleMessageChunk = renderConversationXml(currentMessages, {
                conversationId,
                includeToolCalls: true,
            }).xml;
            if (singleMessageChunk.length > MAX_EMBEDDING_CONTENT_CHARS) {
                logger.warn("Conversation transcript chunk exceeds embedding target size", {
                    conversationId: conversationId.substring(0, 8),
                    chunkChars: singleMessageChunk.length,
                    targetChars: MAX_EMBEDDING_CONTENT_CHARS,
                });
            }
        }

        if (currentMessages.length > 0) {
            flushCurrent();
        }

        return chunks;
    }

    private splitOversizedMessage(
        message: import("@/conversations/types").ConversationRecordInput
    ): import("@/conversations/types").ConversationRecordInput[] {
        if (message.messageType !== "text" || message.content.length <= MAX_EMBEDDING_CONTENT_CHARS / 2) {
            return [message];
        }

        return this.splitTextForEmbedding(message.content, Math.floor(MAX_EMBEDDING_CONTENT_CHARS / 2))
            .map((content, index, parts) => ({
                ...message,
                content: parts.length === 1
                    ? content
                    : `${content}\n\n[message part ${index + 1}/${parts.length}]`,
            }));
    }

    private splitTextForEmbedding(
        text: string,
        maxChars: number = MAX_EMBEDDING_CONTENT_CHARS
    ): string[] {
        if (text.length <= maxChars) {
            return [text];
        }

        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > maxChars) {
            const newlineIndex = remaining.lastIndexOf("\n", maxChars);
            const splitAt = newlineIndex > maxChars * 0.5 ? newlineIndex : maxChars;
            chunks.push(remaining.slice(0, splitAt).trim());
            remaining = remaining.slice(splitAt).trim();
        }
        if (remaining.length > 0) {
            chunks.push(remaining);
        }
        return chunks.filter((chunk) => chunk.length > 0);
    }

    /**
     * Build a RAGDocument for a conversation without writing it to the database.
     *
     * Returns a discriminated union:
     * - `{ kind: 'ok', document }` when a document was successfully built
     * - `{ kind: 'noContent' }` when the conversation has no indexable content
     * - `{ kind: 'error', reason }` on transient failures (registry miss, etc.)
     *
     * Used by ConversationIndexingJob to collect documents for batch writing.
     */
    public buildDocument(
        conversationId: string,
        projectId: string,
        store?: ConversationStore
    ): BuildDocumentResult {
        try {
            const catalog = ConversationCatalogService.getInstance(
                projectId as ProjectDTag,
                join(conversationRegistry.basePath, projectId)
            );
            let preview = catalog.getPreview(conversationId);
            if (!preview) {
                catalog.reconcile();
                preview = catalog.getPreview(conversationId);
            }

            const resolvedStore = store ?? conversationRegistry.get(conversationId);
            const messages = resolvedStore?.getAllMessages() ?? [];
            const metadata = resolvedStore?.metadata;
            const title = preview?.title ?? metadata?.title ?? resolvedStore?.title;

            // Build embedding content from full transcript XML (with plain-text fallback)
            const renderResult = this.buildEmbeddingContent(conversationId, messages, title);

            if (renderResult.kind === "error") {
                logger.debug(`No content to embed for conversation ${conversationId.substring(0, 8)}`);
                return { kind: "noContent" };
            }

            const { transcriptChunks, fingerprint } = renderResult;

            return {
                kind: "ok",
                documents: transcriptChunks.map((transcriptChunk, chunkIndex) => ({
                    id: this.getDocumentId(projectId, conversationId, chunkIndex),
                    content: transcriptChunk,
                    metadata: {
                        conversationId,
                        projectId,
                        chunkIndex,
                        totalChunks: transcriptChunks.length,
                        title: title || "",
                        summary: preview?.summary ?? metadata?.summary ?? "",
                        messageCount: preview?.messageCount ?? messages.length,
                        createdAt: preview?.createdAt ?? messages[0]?.timestamp,
                        lastActivity: preview?.lastActivity ?? messages[messages.length - 1]?.timestamp,
                        // Embedding content fingerprint for change detection
                        embeddingContentFingerprint: fingerprint,
                    },
                    timestamp: preview?.lastActivity || messages[messages.length - 1]?.timestamp || Date.now(),
                    source: "conversation",
                })),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to build document for conversation", {
                conversationId: conversationId.substring(0, 8),
                error: message,
            });
            return { kind: "error", reason: message };
        }
    }

    /**
     * Index a single conversation
     * FIX #3: Returns boolean indicating success for accurate counting
     *
     * Note on project validation (FIX #5): Since we iterate conversations using
     * `listConversationIdsFromDiskForProject(projectId)`, the conversation is already
     * guaranteed to exist in that project's directory. The projectId is embedded
     * in the document ID (`conv_${projectId}_${conversationId}`) for query filtering.
     */
    public async indexConversation(
        conversationId: string,
        projectId: string,
        store?: ConversationStore
    ): Promise<boolean> {
        await this.ensureInitialized();

        const result = this.buildDocument(conversationId, projectId, store);

        if (result.kind !== "ok") {
            return false;
        }

        // Atomic bulk upsert through the configured vector store
        await this.ragService.bulkUpsert(CONVERSATION_COLLECTION, result.documents);

        logger.debug(`Indexed conversation ${conversationId.substring(0, 8)} for project ${projectId}`);
        return true;
    }

    /**
     * Get the collection name for conversation embeddings.
     * Exposed for use by ConversationIndexingJob for batch operations.
     */
    public getCollectionName(): string {
        return CONVERSATION_COLLECTION;
    }

    public getDocumentId(projectId: string, conversationId: string, chunkIndex: number): string {
        if (chunkIndex === 0) {
            return `conv_${projectId}_${conversationId}`;
        }
        return `conv_${projectId}_${conversationId}_chunk_${chunkIndex}`;
    }

    /**
     * Index all conversations for a project
     * FIX #3: Only count successful indexings
     */
    public async indexProjectConversations(projectId: ProjectDTag): Promise<number> {
        await this.ensureInitialized();

        let indexed = 0;
        const conversationIds = conversationRegistry.listConversationIdsFromDiskForProject(projectId);

        logger.info(`Indexing ${conversationIds.length} conversations for project ${projectId}`);

        for (const conversationId of conversationIds) {
            const success = await this.indexConversation(conversationId, projectId);
            if (success) {
                indexed++;
            }
        }

        logger.info(`Indexed ${indexed}/${conversationIds.length} conversations for project ${projectId}`);
        return indexed;
    }

    /**
     * Index all conversations across all projects
     */
    public async indexAllConversations(): Promise<number> {
        await this.ensureInitialized();

        let totalIndexed = 0;
        const projectIds = conversationRegistry.listProjectIdsFromDisk();

        logger.info(`Indexing conversations across ${projectIds.length} projects`);

        for (const projectId of projectIds) {
            const indexed = await this.indexProjectConversations(projectId);
            totalIndexed += indexed;
        }

        logger.info(`Total indexed: ${totalIndexed} conversations`);
        return totalIndexed;
    }

    /**
     * Perform semantic search on conversations.
     * Project filter is applied DURING vector search (prefilter),
     * ensuring proper project isolation without leakage from other projects.
     */
    public async semanticSearch(
        query: string,
        options: SemanticSearchOptions = {}
    ): Promise<SemanticSearchResult[]> {
        await this.ensureInitialized();

        const { limit = 20, minScore = 0.3, projectId } = options;

        logger.info("🔍 Semantic search", { query, limit, minScore, projectId });

        const filter = buildProjectFilter(projectId);

        const results = await this.ragService.queryWithFilter(
            CONVERSATION_COLLECTION,
            query,
            limit * 2,
            filter
        );

        const searchResults: SemanticSearchResult[] = results
            .filter((result: RAGQueryResult) => result.score >= minScore)
            .slice(0, limit)
            .map((result: RAGQueryResult) => this.transformResult(result));

        logger.info("✅ Semantic search complete", {
            query,
            found: searchResults.length,
            limit,
            projectFilter: filter || "none",
        });

        return searchResults;
    }

    /**
     * Transform RAG result to SearchResult
     */
    private transformResult(result: RAGQueryResult): SemanticSearchResult {
        const metadata = result.document.metadata || {};

        return {
            conversationId: String(metadata.conversationId || result.document.id || ""),
            projectId: String(metadata.projectId || ""),
            title: String(metadata.title || ""),
            summary: String(metadata.summary || ""),
            messageCount: Number(metadata.messageCount || 0),
            createdAt: metadata.createdAt ? Number(metadata.createdAt) : undefined,
            lastActivity: metadata.lastActivity ? Number(metadata.lastActivity) : undefined,
            relevanceScore: result.score,
        };
    }

    /**
     * Check if the service has any indexed conversations
     */
    public async hasIndexedConversations(): Promise<boolean> {
        await this.ensureInitialized();
        const collections = await this.ragService.listCollections();
        if (!collections.includes(CONVERSATION_COLLECTION)) {
            return false;
        }
        try {
            const stats = await this.ragService.getCollectionStats(CONVERSATION_COLLECTION);
            return stats.totalCount > 0;
        } catch {
            logger.warn("[ConversationEmbeddingService] Could not get collection stats for hasIndexedConversations check");
            return false;
        }
    }

    /**
     * Get embedding provider info
     */
    public async getEmbeddingInfo(): Promise<string> {
        await this.ensureInitialized();
        return this.ragService.getEmbeddingProviderInfo();
    }

    /**
     * Clear all conversation embeddings
     */
    public async clearIndex(): Promise<void> {
        await this.ragService.deleteCollection(CONVERSATION_COLLECTION);
        logger.info("Cleared conversation embeddings index");

        this.initialized = false;
        this.initializationPromise = null;
    }

    /**
     * Reset singleton instance (for testing)
     */
    public static resetInstance(): void {
        if (ConversationEmbeddingService.instance) {
            ConversationEmbeddingService.instance = null;
        }
    }
}

// Export lazy getter to avoid eagerly initializing at module load time
export function getConversationEmbeddingService(): ConversationEmbeddingService {
    return ConversationEmbeddingService.getInstance();
}

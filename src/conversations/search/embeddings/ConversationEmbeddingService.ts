/**
 * ConversationEmbeddingService - Semantic search for conversations
 *
 * This service manages embeddings for conversation summaries to enable
 * natural language semantic search across conversations.
 *
 * Key features:
 * - Embeds conversation summaries (not individual messages - too expensive)
 * - Uses existing RAG infrastructure (LanceDB, embedding providers)
 * - Supports hybrid search (semantic + keyword fallback)
 * - Graceful degradation when embeddings unavailable
 * - Project isolation: filters are applied DURING vector search (prefilter)
 * - Upsert semantics: re-indexing updates existing documents
 */

import { logger } from "@/utils/logger";
import { RAGService, type RAGDocument, type RAGQueryResult } from "@/services/rag/RAGService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { conversationRegistry } from "@/conversations/ConversationRegistry";

/** Collection name for conversation embeddings */
const CONVERSATION_COLLECTION = "conversation_embeddings";

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
            }

            this.initialized = true;
            logger.info("ConversationEmbeddingService initialized successfully");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to initialize ConversationEmbeddingService", { error: message });
            throw new Error(`ConversationEmbeddingService initialization failed: ${message}`);
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
     * Build embedding content from conversation metadata
     * Combines title and summary for richer semantic matching
     */
    private buildEmbeddingContent(
        title?: string,
        summary?: string,
        lastUserMessage?: string
    ): string {
        const parts: string[] = [];

        if (title) {
            parts.push(`Title: ${title}`);
        }

        if (summary) {
            parts.push(`Summary: ${summary}`);
        }

        // Include last user message for additional context
        if (lastUserMessage) {
            // Truncate if too long
            const truncated = lastUserMessage.length > 500
                ? lastUserMessage.substring(0, 500) + "..."
                : lastUserMessage;
            parts.push(`Last message: ${truncated}`);
        }

        return parts.join("\n\n");
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

        try {
            // Load store if not provided
            if (!store) {
                store = conversationRegistry.get(conversationId);
                if (!store) {
                    logger.debug(`Conversation ${conversationId.substring(0, 8)} not found, skipping indexing`);
                    return false;
                }
            }

            const messages = store.getAllMessages();
            const metadata = store.metadata;
            const title = metadata.title ?? store.title;
            const summary = metadata.summary;
            const lastUserMessage = metadata.last_user_message;

            // Build embedding content
            const embeddingContent = this.buildEmbeddingContent(title, summary, lastUserMessage);

            // Skip if no content to embed
            if (!embeddingContent.trim()) {
                logger.debug(`No content to embed for conversation ${conversationId.substring(0, 8)}`);
                return false;
            }

            const firstMessage = messages[0];
            const lastMessage = messages[messages.length - 1];

            const documentId = `conv_${projectId}_${conversationId}`;

            // FIX #2: Delete existing document before inserting (upsert semantics)
            // This prevents duplicate entries when re-indexing
            try {
                await this.ragService.deleteDocumentById(CONVERSATION_COLLECTION, documentId);
                logger.debug(`Deleted existing embedding for ${conversationId.substring(0, 8)}`);
            } catch {
                // Document might not exist - that's fine
            }

            // Create RAG document
            const document: RAGDocument = {
                id: documentId,
                content: embeddingContent,
                metadata: {
                    conversationId,
                    projectId,
                    title: title || "",
                    summary: summary || "",
                    messageCount: messages.length,
                    createdAt: firstMessage?.timestamp,
                    lastActivity: lastMessage?.timestamp,
                },
                timestamp: lastMessage?.timestamp || Date.now(),
                source: "conversation",
            };

            // Add to collection
            await this.ragService.addDocuments(CONVERSATION_COLLECTION, [document]);

            logger.debug(`Indexed conversation ${conversationId.substring(0, 8)} for project ${projectId}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to index conversation", {
                conversationId: conversationId.substring(0, 8),
                error: message,
            });
            // Don't throw - indexing failures shouldn't break the application
            return false;
        }
    }

    /**
     * Index all conversations for a project
     * FIX #3: Only count successful indexings
     */
    public async indexProjectConversations(projectId: string): Promise<number> {
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
     * Build SQL filter for project isolation
     * FIX #1: This filter is applied DURING vector search (prefilter), not after
     */
    private buildProjectFilter(projectId?: string): string | undefined {
        if (!projectId || projectId.toLowerCase() === "all") {
            return undefined;
        }
        // Filter on the metadata JSON string - LanceDB stores metadata as JSON string
        // We need to match the projectId within the serialized JSON
        const escapedProjectId = projectId.replace(/'/g, "''");
        return `metadata LIKE '%"projectId":"${escapedProjectId}"%'`;
    }

    /**
     * Perform semantic search on conversations
     * FIX #1: Project filter is now applied DURING vector search (prefilter),
     * ensuring proper project isolation without leakage from other projects
     */
    public async semanticSearch(
        query: string,
        options: SemanticSearchOptions = {}
    ): Promise<SemanticSearchResult[]> {
        await this.ensureInitialized();

        const { limit = 20, minScore = 0.3, projectId } = options;

        try {
            logger.info("🔍 Semantic search", { query, limit, minScore, projectId });

            // FIX #1: Build SQL filter for project isolation - applied DURING vector search
            const filter = this.buildProjectFilter(projectId);

            // Perform RAG query with prefilter for project isolation
            // Request more results to account for minScore filtering
            const results = await this.ragService.queryWithFilter(
                CONVERSATION_COLLECTION,
                query,
                limit * 2, // Request more to filter by minScore
                filter
            );

            // Transform and filter by minScore only (project filtering already done)
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Semantic search failed", { query, error: message });

            // Return empty results on error - let caller fall back to keyword search
            return [];
        }
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
        try {
            await this.ensureInitialized();
            const collections = await this.ragService.listCollections();
            return collections.includes(CONVERSATION_COLLECTION);
        } catch {
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
        try {
            await this.ragService.deleteCollection(CONVERSATION_COLLECTION);
            logger.info("Cleared conversation embeddings index");
        } catch (error) {
            logger.debug("No index to clear or error clearing", { error });
        }

        // Reset initialization state
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

// Export singleton for convenience
export const conversationEmbeddingService = ConversationEmbeddingService.getInstance();

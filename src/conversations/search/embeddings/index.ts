/**
 * Conversation Embeddings Module
 *
 * Provides semantic search capabilities for conversations using RAG.
 */

export {
    ConversationEmbeddingService,
    getConversationEmbeddingService,
    type ConversationEmbeddingDocument,
    type SemanticSearchResult,
    type SemanticSearchOptions,
} from "./ConversationEmbeddingService";

export {
    ConversationIndexingJob,
    conversationIndexingJob,
} from "./ConversationIndexingJob";

import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import { RAGService } from '@/services/RAGService';
import { 
    executeToolWithErrorHandling,
    type ToolResponse 
} from '@/tools/utils';

const ragListCollectionsSchema = z.object({
    include_stats: z.boolean().optional().default(false).describe(
        'Whether to include statistics for each collection (document count, size, etc.)'
    ),
});

/**
 * Core implementation of listing RAG collections
 */
async function executeListCollections(
    input: z.infer<typeof ragListCollectionsSchema>,
    context: ExecutionContext
): Promise<ToolResponse> {
    const { include_stats = false } = input;
    
    const ragService = RAGService.getInstance();
    const collections = await ragService.listCollections();
    
    // Build response with optional stats note
    const response: ToolResponse = {
        success: true,
        collections_count: collections.length,
        collections: collections
    };
    
    // If stats requested, add a note that it's not yet implemented
    if (include_stats && collections.length > 0) {
        response.note = 'Statistics feature is planned for future release';
    }
    
    return response;
}

/**
 * List all available RAG collections
 */
export function createRAGListCollectionsTool(context: ExecutionContext) {
    return tool({
        description: 'List all available RAG collections in the system',
        inputSchema: ragListCollectionsSchema,
        execute: async (input: z.infer<typeof ragListCollectionsSchema>) => {
            return executeToolWithErrorHandling(
                'rag_list_collections',
                input,
                context,
                executeListCollections
            );
        },
    });
}
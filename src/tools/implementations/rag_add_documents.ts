import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import { RAGService, type RAGDocument } from '@/services/RAGService';
import { 
    executeToolWithErrorHandling,
    resolveAndValidatePath,
    type ToolResponse 
} from '@/tools/utils';
import { readFile } from 'node:fs/promises';

const ragAddDocumentsSchema = z.object({
    collection: z.string().describe(
        'Name of the collection to add documents to'
    ),
    documents: z.array(z.object({
        content: z.string().optional().describe('Text content of the document'),
        file_path: z.string().optional().describe('Path to file to read content from'),
        metadata: z.record(z.any()).optional().describe('Optional metadata for the document'),
        source: z.string().optional().describe('Source identifier for the document'),
        id: z.string().optional().describe('Optional unique identifier for the document'),
    })).describe('Array of documents to add to the collection'),
});

/**
 * Process documents and prepare them for insertion
 */
async function processDocuments(
    documents: z.infer<typeof ragAddDocumentsSchema>['documents'],
    workingDirectory: string
): Promise<RAGDocument[]> {
    const processedDocs: RAGDocument[] = [];
    
    for (const doc of documents) {
        let content = doc.content || '';
        
        // Read from file if file_path is provided
        if (doc.file_path) {
            const fullPath = resolveAndValidatePath(doc.file_path, workingDirectory);
            try {
                content = await readFile(fullPath, 'utf-8');
            } catch (error) {
                if (!doc.content) {
                    throw new Error(`Cannot read file and no content provided: ${doc.file_path}`);
                }
            }
        }
        
        if (!content || content.trim().length === 0) {
            throw new Error('Document must have content or valid file_path');
        }
        
        processedDocs.push({
            id: doc.id,
            content,
            metadata: doc.metadata,
            source: doc.source || (doc.file_path ? `file:${doc.file_path}` : undefined),
            timestamp: Date.now()
        });
    }
    
    return processedDocs;
}

/**
 * Core implementation of adding documents to a RAG collection
 */
async function executeAddDocuments(
    input: z.infer<typeof ragAddDocumentsSchema>,
    context: ExecutionContext
): Promise<ToolResponse> {
    const { collection, documents } = input;
    
    // Process documents
    const processedDocs = await processDocuments(documents, context.workingDirectory);
    
    // Add to collection
    const ragService = RAGService.getInstance();
    await ragService.addDocuments(collection, processedDocs);
    
    return {
        success: true,
        message: `Successfully added ${processedDocs.length} documents to collection '${collection}'`,
        documents_added: processedDocs.length,
        collection: collection
    };
}

/**
 * Add documents to a RAG collection for semantic search
 */
export function createRAGAddDocumentsTool(context: ExecutionContext) {
    return tool({
        description: 'Add documents to a RAG collection. Documents can be provided as text content or file paths. Each document will be automatically embedded for semantic search.',
        inputSchema: ragAddDocumentsSchema,
        execute: async (input: z.infer<typeof ragAddDocumentsSchema>) => {
            return executeToolWithErrorHandling(
                'rag_add_documents',
                input,
                context,
                executeAddDocuments
            );
        },
    });
}
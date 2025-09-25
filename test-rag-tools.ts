#!/usr/bin/env bun

// Test script to verify RAG tools work through the tool registry
import { createRAGCreateCollectionTool } from './src/tools/implementations/rag_create_collection';
import { createRAGAddDocumentsTool } from './src/tools/implementations/rag_add_documents';
import { createRAGQueryTool } from './src/tools/implementations/rag_query';
import { createRAGDeleteCollectionTool } from './src/tools/implementations/rag_delete_collection';
import { createRAGListCollectionsTool } from './src/tools/implementations/rag_list_collections';
import type { ExecutionContext } from './src/agents/execution/types';

// Mock execution context
const mockContext: ExecutionContext = {
    projectId: 'test-project',
    conversationId: 'test-conversation',
    agent: {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Test agent',
        tools: [],
        model: 'gpt-4',
        provider: 'openai',
        systemPrompt: 'Test'
    },
    sendMessage: async (message: string) => {
        console.log('Agent message:', message);
    },
    phase: 'development'
};

async function testRAGTools() {
    console.log('Testing RAG tools through tool registry...\n');
    
    const testCollectionName = 'test_tools_collection_' + Date.now();
    
    try {
        // 1. Create collection
        console.log('1. Creating collection...');
        const createTool = createRAGCreateCollectionTool(mockContext);
        const createResult = await createTool.execute({ name: testCollectionName });
        console.log('   Result:', createResult);
        
        // 2. Add documents
        console.log('\n2. Adding documents...');
        const addTool = createRAGAddDocumentsTool(mockContext);
        const addResult = await addTool.execute({
            collection: testCollectionName,
            documents: [
                {
                    content: 'React is a JavaScript library for building user interfaces.',
                    metadata: { library: 'react', type: 'definition' }
                },
                {
                    content: 'Vue.js is a progressive framework for building user interfaces.',
                    metadata: { framework: 'vue', type: 'definition' }
                },
                {
                    content: 'Angular is a TypeScript-based web application framework.',
                    metadata: { framework: 'angular', type: 'definition' }
                }
            ]
        });
        console.log('   Result:', addResult);
        
        // 3. Query the collection
        console.log('\n3. Querying collection...');
        const queryTool = createRAGQueryTool(mockContext);
        const queryResult = await queryTool.execute({
            collection: testCollectionName,
            query_text: 'What is React?',
            top_k: 2
        });
        console.log('   Result:', queryResult);
        
        // 4. List collections
        console.log('\n4. Listing collections...');
        const listTool = createRAGListCollectionsTool(mockContext);
        const listResult = await listTool.execute({});
        console.log('   Result:', listResult);
        
        // 5. Delete collection
        console.log('\n5. Deleting collection...');
        const deleteTool = createRAGDeleteCollectionTool(mockContext);
        const deleteResult = await deleteTool.execute({ name: testCollectionName, confirm: true });
        console.log('   Result:', deleteResult);
        
        console.log('\n✅ All RAG tools tested successfully!');
        process.exit(0);
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        
        // Try to clean up on error
        try {
            const deleteTool = createRAGDeleteCollectionTool(mockContext);
            await deleteTool.execute({ name: testCollectionName, confirm: true });
        } catch (cleanupError) {
            // Ignore cleanup errors
        }
        
        process.exit(1);
    }
}

// Run the test
testRAGTools();
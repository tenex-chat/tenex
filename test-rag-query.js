#!/usr/bin/env node

// Test script for verifying RAG query functionality
import { RAGService } from './dist/services/rag/RAGService.js';

async function testRAGQuery() {
    console.log('Testing RAG query functionality...\n');
    
    const service = RAGService.getInstance();
    const testCollectionName = 'test_collection_' + Date.now();
    
    try {
        // Step 1: Create a test collection
        console.log('1. Creating collection...');
        const collection = await service.createCollection(testCollectionName);
        console.log(`   ✓ Collection created: ${collection.name}\n`);
        
        // Step 2: Add test documents
        console.log('2. Adding documents...');
        const documents = [
            {
                content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
                metadata: { language: 'typescript', type: 'definition' }
            },
            {
                content: 'React is a JavaScript library for building user interfaces.',
                metadata: { library: 'react', type: 'definition' }
            },
            {
                content: 'Node.js is a JavaScript runtime built on Chrome V8 JavaScript engine.',
                metadata: { runtime: 'nodejs', type: 'definition' }
            }
        ];
        
        await service.addDocuments(testCollectionName, documents);
        console.log(`   ✓ Added ${documents.length} documents\n`);
        
        // Step 3: Query the collection
        console.log('3. Querying collection...');
        const queryText = 'What is TypeScript?';
        const results = await service.query(testCollectionName, queryText, 2);
        
        console.log(`   Query: "${queryText}"`);
        console.log(`   ✓ Found ${results.length} results:\n`);
        
        results.forEach((result, index) => {
            console.log(`   Result ${index + 1}:`);
            console.log(`   - Score: ${result.score.toFixed(4)}`);
            console.log(`   - Content: ${result.document.content.substring(0, 100)}...`);
            console.log(`   - Metadata:`, result.document.metadata);
            console.log();
        });
        
        // Step 4: Clean up
        console.log('4. Cleaning up...');
        await service.deleteCollection(testCollectionName);
        console.log(`   ✓ Collection deleted\n`);
        
        console.log('✅ All tests passed successfully!');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        
        // Try to clean up on error
        try {
            await service.deleteCollection(testCollectionName);
        } catch (cleanupError) {
            // Ignore cleanup errors
        }
        
        process.exit(1);
    } finally {
        await service.close();
    }
}

// Run the test
testRAGQuery();
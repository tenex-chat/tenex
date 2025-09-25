#!/usr/bin/env bun

// Debug test script for RAG query functionality
import { RAGService } from './src/services/rag/RAGService';
import { EmbeddingProviderFactory } from './src/services/rag/EmbeddingProviderFactory';

async function testRAGDebug() {
    console.log('🔍 Testing RAG with debugging...\n');
    
    try {
        // First, test the embedding provider
        console.log('1. Testing embedding provider...');
        const embeddingProvider = await EmbeddingProviderFactory.create();
        console.log(`   Provider model: ${embeddingProvider.getModelId()}`);
        
        const testText = 'This is a test';
        console.log(`   Testing embed("${testText}")...`);
        
        try {
            const embedding = await embeddingProvider.embed(testText);
            console.log(`   ✓ Embedding generated, dimensions: ${embedding.length}`);
            console.log(`   Sample values: [${embedding.slice(0, 3).join(', ')}...]\n`);
        } catch (embedError: any) {
            console.error(`   ❌ Embedding failed: ${embedError.message}`);
            console.log('\n   Note: If using OpenAI, ensure OPENAI_API_KEY is set');
            console.log('   You can switch to local embeddings with: tenex setup embed\n');
            process.exit(1);
        }
        
        // Now test RAG operations
        const service = RAGService.getInstance();
        const testCollectionName = 'debug_collection_' + Date.now();
        
        console.log('2. Creating collection...');
        const collection = await service.createCollection(testCollectionName);
        console.log(`   ✓ Collection created: ${collection.name}`);
        console.log(`   Schema:`, collection.schema);
        
        console.log('\n3. Adding a single document...');
        const testDoc = {
            content: 'TypeScript is a typed superset of JavaScript.',
            metadata: { test: true }
        };
        
        await service.addDocuments(testCollectionName, [testDoc]);
        console.log('   ✓ Document added');
        
        // Wait a moment for indexing
        console.log('\n4. Waiting 2 seconds for indexing...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('\n5. Attempting query...');
        const queryText = 'TypeScript';
        console.log(`   Query: "${queryText}"`);
        
        try {
            const results = await service.query(testCollectionName, queryText, 5);
            console.log(`   ✓ Query succeeded! Found ${results.length} results`);
            
            if (results.length > 0) {
                console.log('\n   First result:');
                console.log('   - Content:', results[0].document.content);
                console.log('   - Score:', results[0].score);
            }
        } catch (queryError: any) {
            console.error(`   ❌ Query failed: ${queryError.message}`);
            console.log('\n   Full error:', queryError);
        }
        
        console.log('\n6. Cleaning up...');
        await service.deleteCollection(testCollectionName);
        console.log('   ✓ Collection deleted');
        
        console.log('\n✅ Debug test completed');
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Run the test
testRAGDebug();
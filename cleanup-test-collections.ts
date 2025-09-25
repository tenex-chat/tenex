#!/usr/bin/env bun

// Script to clean up test collections
import { RAGService } from './src/services/rag/RAGService';

async function cleanupTestCollections() {
    const service = RAGService.getInstance();
    
    try {
        const collections = await service.listCollections();
        console.log(`Found ${collections.length} collections`);
        
        const testCollections = collections.filter(name => 
            name.startsWith('test_') || name === 'test_collection2'
        );
        
        if (testCollections.length === 0) {
            console.log('No test collections to clean up');
            return;
        }
        
        console.log(`\nCleaning up ${testCollections.length} test collections:`);
        for (const collection of testCollections) {
            try {
                await service.deleteCollection(collection);
                console.log(`  ✓ Deleted: ${collection}`);
            } catch (error: any) {
                console.error(`  ✗ Failed to delete ${collection}: ${error.message}`);
            }
        }
        
        console.log('\nCleanup completed');
    } catch (error: any) {
        console.error('Cleanup failed:', error.message);
    } finally {
        await service.close();
    }
}

cleanupTestCollections();
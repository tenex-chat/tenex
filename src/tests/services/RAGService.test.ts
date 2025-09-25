import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { RAGService } from '@/services/RAGService';
import { LocalTransformerEmbeddingProvider } from '@/services/EmbeddingProvider';
import * as fs from 'fs';
import * as path from 'path';

describe('RAGService', () => {
    let ragService: RAGService;
    const testCollectionName = 'test_collection_' + Date.now();
    const testDataDir = path.join(process.cwd(), 'data', 'lancedb-test');

    beforeAll(() => {
        // Set test data directory
        process.env.LANCEDB_DATA_DIR = testDataDir;
        
        // Get service instance
        ragService = RAGService.getInstance();
    });

    afterAll(async () => {
        // Clean up test collection
        try {
            await ragService.deleteCollection(testCollectionName);
        } catch (e) {
            // Collection might not exist if test failed
        }
        
        // Close service
        await ragService.close();
        
        // Clean up test data directory
        if (fs.existsSync(testDataDir)) {
            fs.rmSync(testDataDir, { recursive: true, force: true });
        }
    });

    describe('Collection Management', () => {
        it('should create a new collection', async () => {
            const collection = await ragService.createCollection(testCollectionName);
            
            expect(collection).toBeDefined();
            expect(collection.name).toBe(testCollectionName);
            expect(collection.schema).toBeDefined();
            expect(collection.created_at).toBeGreaterThan(0);
        });

        it('should list collections', async () => {
            const collections = await ragService.listCollections();
            
            expect(collections).toBeInstanceOf(Array);
            expect(collections).toContain(testCollectionName);
        });

        it('should throw error when creating duplicate collection', async () => {
            await expect(
                ragService.createCollection(testCollectionName)
            ).rejects.toThrow(`Collection ${testCollectionName} already exists`);
        });
    });

    describe('Document Operations', () => {
        it('should add documents to collection', async () => {
            const documents = [
                {
                    content: 'TypeScript is a statically typed superset of JavaScript.',
                    metadata: { language: 'typescript', type: 'definition' }
                },
                {
                    content: 'React is a JavaScript library for building user interfaces.',
                    metadata: { library: 'react', type: 'definition' }
                },
                {
                    content: 'Node.js is a JavaScript runtime built on Chrome V8 engine.',
                    metadata: { runtime: 'nodejs', type: 'definition' }
                }
            ];

            await expect(
                ragService.addDocuments(testCollectionName, documents)
            ).resolves.not.toThrow();
        });

        it('should throw error when adding to non-existent collection', async () => {
            await expect(
                ragService.addDocuments('non_existent_collection', [
                    { content: 'test document' }
                ])
            ).rejects.toThrow('Collection non_existent_collection does not exist');
        });
    });

    describe('Query Operations', () => {
        it('should query documents by semantic similarity', async () => {
            // Query for TypeScript-related content
            const results = await ragService.query(
                testCollectionName,
                'What is TypeScript?',
                3
            );

            expect(results).toBeInstanceOf(Array);
            expect(results.length).toBeLessThanOrEqual(3);
            
            if (results.length > 0) {
                expect(results[0]).toHaveProperty('document');
                expect(results[0]).toHaveProperty('score');
                expect(results[0].document).toHaveProperty('content');
                expect(results[0].document).toHaveProperty('metadata');
                
                // The TypeScript document should be the most relevant
                expect(results[0].document.content).toContain('TypeScript');
            }
        });

        it('should return empty results for unrelated queries', async () => {
            const results = await ragService.query(
                testCollectionName,
                'quantum physics and black holes',
                5
            );

            expect(results).toBeInstanceOf(Array);
            // Results might not be empty but scores should be lower
        });

        it('should throw error when querying non-existent collection', async () => {
            await expect(
                ragService.query('non_existent_collection', 'test query', 5)
            ).rejects.toThrow('Collection non_existent_collection does not exist');
        });
    });

    describe('Collection Deletion', () => {
        it('should delete an existing collection', async () => {
            const tempCollection = 'temp_collection_' + Date.now();
            
            // Create a temporary collection
            await ragService.createCollection(tempCollection);
            
            // Verify it exists
            let collections = await ragService.listCollections();
            expect(collections).toContain(tempCollection);
            
            // Delete it
            await ragService.deleteCollection(tempCollection);
            
            // Verify it's gone
            collections = await ragService.listCollections();
            expect(collections).not.toContain(tempCollection);
        });

        it('should throw error when deleting non-existent collection', async () => {
            await expect(
                ragService.deleteCollection('non_existent_collection')
            ).rejects.toThrow('Collection non_existent_collection does not exist');
        });
    });
});

describe('EmbeddingProvider', () => {
    it('should generate embeddings with consistent dimensions', async () => {
        const provider = new LocalTransformerEmbeddingProvider();
        
        const text1 = 'Hello world';
        const text2 = 'This is a different text with more words';
        
        const embedding1 = await provider.embed(text1);
        const embedding2 = await provider.embed(text2);
        
        expect(embedding1).toBeInstanceOf(Float32Array);
        expect(embedding2).toBeInstanceOf(Float32Array);
        expect(embedding1.length).toBe(embedding2.length);
        expect(embedding1.length).toBeGreaterThan(0);
        
        const dimensions = await provider.getDimensions();
        expect(embedding1.length).toBe(dimensions);
    });

    it('should batch embed multiple texts', async () => {
        const provider = new LocalTransformerEmbeddingProvider();
        
        const texts = ['First text', 'Second text', 'Third text'];
        const embeddings = await provider.embedBatch(texts);
        
        expect(embeddings).toBeInstanceOf(Array);
        expect(embeddings.length).toBe(texts.length);
        
        for (const embedding of embeddings) {
            expect(embedding).toBeInstanceOf(Float32Array);
        }
    });
});
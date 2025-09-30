import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RagSubscriptionService, SubscriptionStatus } from '../RagSubscriptionService';
import { RAGService } from '../rag/RAGService';

describe('RagSubscriptionService', () => {
  let service: RagSubscriptionService;
  const testDir = path.join(process.cwd(), '.tenex-test');
  const originalCwd = process.cwd();
  
  beforeEach(async () => {
    // Reset singleton for clean state
    RagSubscriptionService.resetInstance();
    
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    process.chdir(testDir);
    
    // Initialize service
    service = RagSubscriptionService.getInstance();
  });
  
  afterEach(async () => {
    // Cleanup
    process.chdir(originalCwd);
    await fs.rm(testDir, { recursive: true, force: true });
    
    // Reset singleton
    RagSubscriptionService.resetInstance();
  });
  
  describe('createSubscription', () => {
    test('should create a new subscription successfully', async () => {
      // Mock RAG service
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      const subscription = await service.createSubscription(
        'test-sub',
        'agent-pubkey',
        'test-server',
        'test-resource',
        'test-collection',
        'Test subscription'
      );
      
      expect(subscription).toBeDefined();
      expect(subscription.subscriptionId).toBe('test-sub');
      expect(subscription.agentPubkey).toBe('agent-pubkey');
      expect(subscription.mcpServerId).toBe('test-server');
      expect(subscription.resourceUri).toBe('test-resource');
      expect(subscription.ragCollection).toBe('test-collection');
      expect(subscription.description).toBe('Test subscription');
      expect(subscription.status).toBe(SubscriptionStatus.RUNNING);
      expect(subscription.documentsProcessed).toBe(0);
      
      listCollectionsSpy.mockRestore();
    });
    
    test('should reject duplicate subscription IDs', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      await service.createSubscription(
        'duplicate-id',
        'agent-pubkey',
        'test-server',
        'test-resource',
        'test-collection',
        'First subscription'
      );
      
      await expect(
        service.createSubscription(
          'duplicate-id',
          'agent-pubkey',
          'test-server-2',
          'test-resource-2',
          'test-collection-2',
          'Second subscription'
        )
      ).rejects.toThrow("Subscription with ID 'duplicate-id' already exists");
      
      listCollectionsSpy.mockRestore();
    });
    
    test('should reject non-existent RAG collections', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([]);
      
      await service.initialize();
      
      await expect(
        service.createSubscription(
          'test-sub',
          'agent-pubkey',
          'test-server',
          'test-resource',
          'non-existent-collection',
          'Test subscription'
        )
      ).rejects.toThrow("RAG collection 'non-existent-collection' does not exist");
      
      listCollectionsSpy.mockRestore();
    });
  });
  
  describe('listSubscriptions', () => {
    test('should list subscriptions for a specific agent', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      // Create subscriptions for different agents
      await service.createSubscription(
        'sub1',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Subscription 1'
      );
      
      await service.createSubscription(
        'sub2',
        'agent2',
        'server2',
        'resource2',
        'test-collection',
        'Subscription 2'
      );
      
      await service.createSubscription(
        'sub3',
        'agent1',
        'server3',
        'resource3',
        'test-collection',
        'Subscription 3'
      );
      
      // List subscriptions for agent1
      const agent1Subs = await service.listSubscriptions('agent1');
      expect(agent1Subs).toHaveLength(2);
      expect(agent1Subs.map(s => s.subscriptionId)).toEqual(['sub1', 'sub3']);
      
      // List subscriptions for agent2
      const agent2Subs = await service.listSubscriptions('agent2');
      expect(agent2Subs).toHaveLength(1);
      expect(agent2Subs[0].subscriptionId).toBe('sub2');
      
      // List subscriptions for non-existent agent
      const noSubs = await service.listSubscriptions('agent-none');
      expect(noSubs).toHaveLength(0);
      
      listCollectionsSpy.mockRestore();
    });
  });
  
  describe('getSubscription', () => {
    test('should get subscription by ID for correct agent', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      await service.createSubscription(
        'test-sub',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Test subscription'
      );
      
      // Get subscription with correct agent
      const subscription = await service.getSubscription('test-sub', 'agent1');
      expect(subscription).toBeDefined();
      expect(subscription?.subscriptionId).toBe('test-sub');
      
      // Try to get subscription with wrong agent
      const notFound = await service.getSubscription('test-sub', 'agent2');
      expect(notFound).toBeNull();
      
      // Try to get non-existent subscription
      const nonExistent = await service.getSubscription('no-such-sub', 'agent1');
      expect(nonExistent).toBeNull();
      
      listCollectionsSpy.mockRestore();
    });
  });
  
  describe('deleteSubscription', () => {
    test('should delete subscription for correct agent', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      await service.createSubscription(
        'test-sub',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Test subscription'
      );
      
      // Delete with correct agent
      const deleted = await service.deleteSubscription('test-sub', 'agent1');
      expect(deleted).toBe(true);
      
      // Verify subscription is gone
      const subscription = await service.getSubscription('test-sub', 'agent1');
      expect(subscription).toBeNull();
      
      listCollectionsSpy.mockRestore();
    });
    
    test('should not delete subscription for wrong agent', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      await service.createSubscription(
        'test-sub',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Test subscription'
      );
      
      // Try to delete with wrong agent
      const deleted = await service.deleteSubscription('test-sub', 'agent2');
      expect(deleted).toBe(false);
      
      // Verify subscription still exists
      const subscription = await service.getSubscription('test-sub', 'agent1');
      expect(subscription).toBeDefined();
      
      listCollectionsSpy.mockRestore();
    });
  });
  
  describe('getStatistics', () => {
    test('should return correct statistics', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      await service.initialize();
      
      // Create multiple subscriptions
      const sub1 = await service.createSubscription(
        'sub1',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Subscription 1'
      );
      
      const sub2 = await service.createSubscription(
        'sub2',
        'agent1',
        'server2',
        'resource2',
        'test-collection',
        'Subscription 2'
      );
      
      // Manually update subscription states for testing
      sub1.documentsProcessed = 10;
      sub2.documentsProcessed = 5;
      sub2.status = SubscriptionStatus.ERROR;
      
      const stats = service.getStatistics();
      expect(stats.total).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.error).toBe(1);
      expect(stats.stopped).toBe(0);
      expect(stats.totalDocuments).toBe(15);
      
      listCollectionsSpy.mockRestore();
    });
  });
  
  describe('persistence', () => {
    test('should persist subscriptions to disk and reload on initialization', async () => {
      const ragService = RAGService.getInstance();
      const listCollectionsSpy = spyOn(ragService, 'listCollections')
        .mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
      
      // Create first service instance
      await service.initialize();
      
      await service.createSubscription(
        'persistent-sub',
        'agent1',
        'server1',
        'resource1',
        'test-collection',
        'Persistent subscription'
      );
      
      // Create new service instance (simulating restart)
      const newService = new (RagSubscriptionService as any)();
      await newService.initialize();
      
      // Check if subscription was loaded
      const subscription = await newService.getSubscription('persistent-sub', 'agent1');
      expect(subscription).toBeDefined();
      expect(subscription?.subscriptionId).toBe('persistent-sub');
      expect(subscription?.description).toBe('Persistent subscription');
      
      listCollectionsSpy.mockRestore();
    });
  });
});
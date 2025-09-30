import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createRAGSubscriptionCreateTool } from '../rag_subscription_create';
import { createRAGSubscriptionListTool } from '../rag_subscription_list';
import { createRAGSubscriptionGetTool } from '../rag_subscription_get';
import { createRAGSubscriptionDeleteTool } from '../rag_subscription_delete';
import { RagSubscriptionService } from '@/services/RagSubscriptionService';
import { RAGService } from '@/services/rag/RAGService';
import type { ExecutionContext } from '@/agents/execution/types';

describe('RAG Subscription Tools', () => {
  const testDir = path.join(process.cwd(), '.tenex-test');
  const originalCwd = process.cwd();
  
  const mockContext: ExecutionContext = {
    agentIdentity: {
      name: 'test-agent',
      slug: 'test-agent',
      pubkey: 'test-agent-pubkey',
    },
    workingDirectory: testDir,
    executeToolCallback: async () => ({ success: true }),
    isRecursiveCall: false,
  };
  
  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    process.chdir(testDir);
    
    // Mock RAG service
    const ragService = RAGService.getInstance();
    const listSpy = spyOn(ragService, 'listCollections');
    listSpy.mockResolvedValue([{ name: 'test-collection', document_count: 0 }]);
    const addSpy = spyOn(ragService, 'addDocuments');
    addSpy.mockResolvedValue();
  });
  
  afterEach(async () => {
    // Cleanup
    process.chdir(originalCwd);
    await fs.rm(testDir, { recursive: true, force: true });
    mock.restore();
  });
  
  describe('rag_subscription_create', () => {
    test('should create a subscription successfully', async () => {
      const tool = createRAGSubscriptionCreateTool(mockContext);
      
      const result = await tool.execute({
        subscriptionId: 'test-subscription',
        mcpServerId: 'test-mcp-server',
        resourceUri: 'test-resource',
        ragCollection: 'test-collection',
        description: 'Test subscription for unit tests'
      });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully created subscription');
      expect(result.subscription).toBeDefined();
      expect(result.subscription.id).toBe('test-subscription');
      expect(result.subscription.mcpServer).toBe('test-mcp-server');
      expect(result.subscription.resource).toBe('test-resource');
      expect(result.subscription.collection).toBe('test-collection');
      expect(result.subscription.status).toBe('RUNNING');
    });
    
    test('should handle duplicate subscription IDs', async () => {
      const tool = createRAGSubscriptionCreateTool(mockContext);
      
      // Create first subscription
      await tool.execute({
        subscriptionId: 'duplicate-test',
        mcpServerId: 'server1',
        resourceUri: 'resource1',
        ragCollection: 'test-collection',
        description: 'First subscription'
      });
      
      // Try to create duplicate
      const result = await tool.execute({
        subscriptionId: 'duplicate-test',
        mcpServerId: 'server2',
        resourceUri: 'resource2',
        ragCollection: 'test-collection',
        description: 'Duplicate subscription'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("already exists");
    });
    
    test('should handle non-existent RAG collection', async () => {
      const tool = createRAGSubscriptionCreateTool(mockContext);
      
      const result = await tool.execute({
        subscriptionId: 'test-sub',
        mcpServerId: 'test-server',
        resourceUri: 'test-resource',
        ragCollection: 'non-existent-collection',
        description: 'Test subscription'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("does not exist");
    });
  });
  
  describe('rag_subscription_list', () => {
    test('should list subscriptions for the agent', async () => {
      // Create some subscriptions first
      const service = RagSubscriptionService.getInstance();
      await service.initialize();
      
      await service.createSubscription(
        'sub1',
        'test-agent-pubkey',
        'server1',
        'resource1',
        'test-collection',
        'Subscription 1'
      );
      
      await service.createSubscription(
        'sub2',
        'test-agent-pubkey',
        'server2',
        'resource2',
        'test-collection',
        'Subscription 2'
      );
      
      // List subscriptions
      const tool = createRAGSubscriptionListTool(mockContext);
      const result = await tool.execute({});
      
      expect(result.success).toBe(true);
      expect(result.subscriptions).toHaveLength(2);
      expect(result.subscriptions.map(s => s.id)).toContain('sub1');
      expect(result.subscriptions.map(s => s.id)).toContain('sub2');
      expect(result.statistics.total).toBe(2);
      expect(result.statistics.running).toBe(2);
    });
    
    test('should return empty list when no subscriptions exist', async () => {
      const tool = createRAGSubscriptionListTool(mockContext);
      const result = await tool.execute({});
      
      expect(result.success).toBe(true);
      expect(result.subscriptions).toHaveLength(0);
      expect(result.statistics.total).toBe(0);
    });
  });
  
  describe('rag_subscription_get', () => {
    test('should get subscription details', async () => {
      // Create a subscription first
      const service = RagSubscriptionService.getInstance();
      await service.initialize();
      
      await service.createSubscription(
        'test-sub-get',
        'test-agent-pubkey',
        'server1',
        'resource1',
        'test-collection',
        'Test subscription for get'
      );
      
      // Get subscription
      const tool = createRAGSubscriptionGetTool(mockContext);
      const result = await tool.execute({
        subscriptionId: 'test-sub-get'
      });
      
      expect(result.success).toBe(true);
      expect(result.subscription).toBeDefined();
      expect(result.subscription.id).toBe('test-sub-get');
      expect(result.subscription.description).toBe('Test subscription for get');
      expect(result.subscription.configuration.mcpServer).toBe('server1');
      expect(result.subscription.configuration.resource).toBe('resource1');
      expect(result.subscription.metrics.documentsProcessed).toBe(0);
    });
    
    test('should handle non-existent subscription', async () => {
      const tool = createRAGSubscriptionGetTool(mockContext);
      const result = await tool.execute({
        subscriptionId: 'non-existent'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('SUBSCRIPTION_NOT_FOUND');
      expect(result.message).toContain('not found');
    });
  });
  
  describe('rag_subscription_delete', () => {
    test('should delete subscription successfully', async () => {
      // Create a subscription first
      const service = RagSubscriptionService.getInstance();
      await service.initialize();
      
      await service.createSubscription(
        'test-sub-delete',
        'test-agent-pubkey',
        'server1',
        'resource1',
        'test-collection',
        'Test subscription for delete'
      );
      
      // Delete subscription
      const tool = createRAGSubscriptionDeleteTool(mockContext);
      const result = await tool.execute({
        subscriptionId: 'test-sub-delete'
      });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully deleted');
      expect(result.subscriptionId).toBe('test-sub-delete');
      
      // Verify it's deleted
      const getResult = await service.getSubscription('test-sub-delete', 'test-agent-pubkey');
      expect(getResult).toBeNull();
    });
    
    test('should handle non-existent subscription', async () => {
      const tool = createRAGSubscriptionDeleteTool(mockContext);
      const result = await tool.execute({
        subscriptionId: 'non-existent'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('SUBSCRIPTION_NOT_FOUND');
      expect(result.message).toContain('not found');
    });
    
    test('should not delete subscription from another agent', async () => {
      // Create a subscription for a different agent
      const service = RagSubscriptionService.getInstance();
      await service.initialize();
      
      await service.createSubscription(
        'other-agent-sub',
        'other-agent-pubkey',
        'server1',
        'resource1',
        'test-collection',
        'Other agent subscription'
      );
      
      // Try to delete with different agent context
      const tool = createRAGSubscriptionDeleteTool(mockContext);
      const result = await tool.execute({
        subscriptionId: 'other-agent-sub'
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain("don't have permission");
    });
  });
  
  describe('Tool Integration', () => {
    test('should create, list, get, and delete subscription in sequence', async () => {
      const createTool = createRAGSubscriptionCreateTool(mockContext);
      const listTool = createRAGSubscriptionListTool(mockContext);
      const getTool = createRAGSubscriptionGetTool(mockContext);
      const deleteTool = createRAGSubscriptionDeleteTool(mockContext);
      
      // Create
      const createResult = await createTool.execute({
        subscriptionId: 'integration-test',
        mcpServerId: 'test-server',
        resourceUri: 'test-resource',
        ragCollection: 'test-collection',
        description: 'Integration test subscription'
      });
      expect(createResult.success).toBe(true);
      
      // List
      const listResult = await listTool.execute({});
      expect(listResult.success).toBe(true);
      expect(listResult.subscriptions).toHaveLength(1);
      expect(listResult.subscriptions[0].id).toBe('integration-test');
      
      // Get
      const getResult = await getTool.execute({
        subscriptionId: 'integration-test'
      });
      expect(getResult.success).toBe(true);
      expect(getResult.subscription.description).toBe('Integration test subscription');
      
      // Delete
      const deleteResult = await deleteTool.execute({
        subscriptionId: 'integration-test'
      });
      expect(deleteResult.success).toBe(true);
      
      // Verify deletion
      const finalListResult = await listTool.execute({});
      expect(finalListResult.subscriptions).toHaveLength(0);
    });
  });
});
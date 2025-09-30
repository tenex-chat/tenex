import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPManager } from '../MCPManager';
import type { experimental_MCPClient } from 'ai';

// Mock the dependencies
vi.mock('@/services/ConfigService');
vi.mock('@/utils/logger');

describe('MCPManager - Resources Support', () => {
  let mcpManager: MCPManager;

  beforeEach(() => {
    mcpManager = MCPManager.getInstance();
  });

  afterEach(async () => {
    await mcpManager.shutdown();
  });

  describe('includeResources configuration', () => {
    it('should default to not including resources in tools', () => {
      expect((mcpManager as any).includeResourcesInTools).toBe(false);
    });

    it('should allow enabling resources in tools', () => {
      mcpManager.setIncludeResourcesInTools(true);
      expect((mcpManager as any).includeResourcesInTools).toBe(true);
    });

    it('should allow disabling resources in tools', () => {
      mcpManager.setIncludeResourcesInTools(true);
      mcpManager.setIncludeResourcesInTools(false);
      expect((mcpManager as any).includeResourcesInTools).toBe(false);
    });
  });

  describe('listResources', () => {
    it('should throw error for non-existent server', async () => {
      await expect(mcpManager.listResources('non-existent')).rejects.toThrow(
        "MCP server 'non-existent' not found"
      );
    });

    it('should call client.listResources for valid server', async () => {
      // Mock a client entry
      const mockClient = {
        listResources: vi.fn().mockResolvedValue({
          resources: [
            {
              uri: 'file:///test.txt',
              name: 'test-resource',
              description: 'A test resource',
              mimeType: 'text/plain',
            },
          ],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const resources = await mcpManager.listResources('test-server');

      expect(resources).toHaveLength(1);
      expect(resources[0].name).toBe('test-resource');
      expect(mockClient.listResources).toHaveBeenCalled();
    });
  });

  describe('listAllResources', () => {
    it('should return empty map when no servers connected', async () => {
      const result = await mcpManager.listAllResources();
      expect(result.size).toBe(0);
    });

    it('should aggregate resources from all servers', async () => {
      const mockClient1 = {
        listResources: vi.fn().mockResolvedValue({
          resources: [
            { uri: 'file:///test1.txt', name: 'resource1' },
          ],
        }),
      } as unknown as experimental_MCPClient;

      const mockClient2 = {
        listResources: vi.fn().mockResolvedValue({
          resources: [
            { uri: 'file:///test2.txt', name: 'resource2' },
          ],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('server1', { client: mockClient1, serverName: 'server1' });
      (mcpManager as any).clients.set('server2', { client: mockClient2, serverName: 'server2' });

      const result = await mcpManager.listAllResources();

      expect(result.size).toBe(2);
      expect(result.get('server1')).toHaveLength(1);
      expect(result.get('server2')).toHaveLength(1);
    });

    it('should continue with other servers if one fails', async () => {
      const mockClient1 = {
        listResources: vi.fn().mockRejectedValue(new Error('Server error')),
      } as unknown as experimental_MCPClient;

      const mockClient2 = {
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///test2.txt', name: 'resource2' }],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('server1', { client: mockClient1, serverName: 'server1' });
      (mcpManager as any).clients.set('server2', { client: mockClient2, serverName: 'server2' });

      const result = await mcpManager.listAllResources();

      expect(result.size).toBe(1);
      expect(result.get('server2')).toHaveLength(1);
    });
  });

  describe('listResourceTemplates', () => {
    it('should throw error for non-existent server', async () => {
      await expect(mcpManager.listResourceTemplates('non-existent')).rejects.toThrow(
        "MCP server 'non-existent' not found"
      );
    });

    it('should call client.listResourceTemplates for valid server', async () => {
      const mockClient = {
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [
            {
              uriTemplate: 'file:///{path}',
              name: 'file-template',
              description: 'A file template',
              mimeType: 'text/plain',
            },
          ],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const templates = await mcpManager.listResourceTemplates('test-server');

      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('file-template');
      expect(mockClient.listResourceTemplates).toHaveBeenCalled();
    });
  });

  describe('readResource', () => {
    it('should throw error for non-existent server', async () => {
      await expect(
        mcpManager.readResource('non-existent', 'file:///test.txt')
      ).rejects.toThrow("MCP server 'non-existent' not found");
    });

    it('should call client.readResource for valid server', async () => {
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: 'file:///test.txt',
              mimeType: 'text/plain',
              text: 'Test content',
            },
          ],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const result = await mcpManager.readResource('test-server', 'file:///test.txt');

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toHaveProperty('text', 'Test content');
      expect(mockClient.readResource).toHaveBeenCalledWith('file:///test.txt');
    });
  });

  describe('getResourceContext', () => {
    it('should format multiple resources as context string', async () => {
      const mockClient = {
        readResource: vi
          .fn()
          .mockResolvedValueOnce({
            contents: [
              {
                uri: 'file:///test1.txt',
                mimeType: 'text/plain',
                text: 'Content 1',
              },
            ],
          })
          .mockResolvedValueOnce({
            contents: [
              {
                uri: 'file:///test2.txt',
                mimeType: 'text/plain',
                text: 'Content 2',
              },
            ],
          }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const context = await mcpManager.getResourceContext('test-server', [
        'file:///test1.txt',
        'file:///test2.txt',
      ]);

      expect(context).toContain('Resource: file:///test1.txt');
      expect(context).toContain('Content 1');
      expect(context).toContain('Resource: file:///test2.txt');
      expect(context).toContain('Content 2');
      expect(context).toContain('---');
    });

    it('should handle binary content', async () => {
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: 'file:///binary.dat',
              mimeType: 'application/octet-stream',
              blob: 'base64encodeddata',
            },
          ],
        }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const context = await mcpManager.getResourceContext('test-server', [
        'file:///binary.dat',
      ]);

      expect(context).toContain('[Binary content:');
      expect(context).toContain('bytes]');
    });

    it('should continue with other resources if one fails', async () => {
      const mockClient = {
        readResource: vi
          .fn()
          .mockRejectedValueOnce(new Error('Read error'))
          .mockResolvedValueOnce({
            contents: [
              {
                uri: 'file:///test2.txt',
                mimeType: 'text/plain',
                text: 'Content 2',
              },
            ],
          }),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      const context = await mcpManager.getResourceContext('test-server', [
        'file:///test1.txt',
        'file:///test2.txt',
      ]);

      expect(context).toContain('Content 2');
      expect(context).not.toContain('test1.txt');
    });
  });

  describe('refreshTools with resources', () => {
    it('should pass includeResources option to client.tools()', async () => {
      const mockClient = {
        tools: vi.fn().mockResolvedValue({}),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      mcpManager.setIncludeResourcesInTools(true);
      await mcpManager.refreshTools();

      expect(mockClient.tools).toHaveBeenCalledWith({
        includeResources: true,
      });
    });

    it('should pass includeResources: false when disabled', async () => {
      const mockClient = {
        tools: vi.fn().mockResolvedValue({}),
      } as unknown as experimental_MCPClient;

      (mcpManager as any).clients.set('test-server', {
        client: mockClient,
        serverName: 'test-server',
      });

      mcpManager.setIncludeResourcesInTools(false);
      await mcpManager.refreshTools();

      expect(mockClient.tools).toHaveBeenCalledWith({
        includeResources: false,
      });
    });
  });
});

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createUploadBlobTool } from '../implementations/upload_blob';
import { getTool, isValidToolName } from '../registry';
import type { ExecutionContext } from '@/agents/execution/types';
import type { AgentInstance } from '@/agents/types';

describe('upload_blob tool', () => {
  let mockContext: ExecutionContext;
  let mockAgent: Partial<AgentInstance>;

  beforeEach(() => {
    // Create a minimal mock agent
    mockAgent = {
      name: 'test-agent',
      pubkey: 'test-pubkey',
      role: 'test',
      slug: 'test-agent',
      sign: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock execution context
    mockContext = {
      agent: mockAgent as AgentInstance,
      conversationId: 'test-conversation',
      agentPublisher: {} as any,
      conversationCoordinator: {} as any,
      triggeringEvent: {} as any,
    } as ExecutionContext;
  });

  describe('tool registration', () => {
    it('should be registered in the tool registry', () => {
      expect(isValidToolName('upload_blob')).toBe(true);
    });

    it('should be retrievable from the registry', () => {
      const tool = getTool('upload_blob', mockContext);
      expect(tool).toBeDefined();
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');
    });

    it('should create tool with correct description', () => {
      const tool = createUploadBlobTool(mockContext);
      expect(tool.description).toContain('Upload files or base64 blobs to a Blossom server');
    });

    it('should have human-readable content generator', () => {
      const tool = createUploadBlobTool(mockContext);
      expect(tool).toHaveProperty('getHumanReadableContent');
      
      const humanReadable = (tool as any).getHumanReadableContent({
        input: '/path/to/file.jpg',
        description: 'Profile picture'
      });
      expect(humanReadable).toBe('Uploading file: file.jpg - Profile picture');
    });

    it('should handle base64 data in human-readable content', () => {
      const tool = createUploadBlobTool(mockContext);
      
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'data:image/jpeg;base64,/9j/4AAQ...',
        description: 'Avatar image'
      });
      expect(humanReadable).toBe('Uploading blob data - Avatar image');
    });
  });

  describe('tool parameters', () => {
    it('should accept required input parameter', () => {
      const tool = createUploadBlobTool(mockContext);
      const schema = tool.parameters;
      
      expect(schema.shape).toHaveProperty('input');
      expect(schema.shape).toHaveProperty('mimeType');
      expect(schema.shape).toHaveProperty('description');
    });
  });
});
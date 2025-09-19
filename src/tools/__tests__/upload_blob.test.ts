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
      expect(tool.description).toContain('Upload files, URLs, or base64 blobs to a Blossom server');
      expect(tool.description).toContain("IMPORTANT: The parameter is named 'input'");
      expect(tool.description).toContain("not 'url' or 'file'");
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

    it('should handle URL input in human-readable content', () => {
      const tool = createUploadBlobTool(mockContext);
      
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://example.com/image.jpg',
        description: 'Profile picture'
      });
      expect(humanReadable).toBe('Downloading and uploading from example.com - Profile picture');
    });

    it('should handle URL input without description', () => {
      const tool = createUploadBlobTool(mockContext);
      
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://cdn.example.com/media/photo.png'
      });
      expect(humanReadable).toBe('Downloading and uploading from cdn.example.com');
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

  describe('error handling', () => {
    it('should handle undefined input gracefully', () => {
      const tool = createUploadBlobTool(mockContext);
      
      // Test getHumanReadableContent with undefined input
      const humanReadable = (tool as any).getHumanReadableContent({
        input: undefined,
        description: 'Some description'
      });
      expect(humanReadable).toBe('Uploading blob data');
    });
    
    it('should handle completely undefined args', () => {
      const tool = createUploadBlobTool(mockContext);
      
      // Test getHumanReadableContent with undefined args
      const humanReadable = (tool as any).getHumanReadableContent(undefined);
      expect(humanReadable).toBe('Uploading blob data');
    });

    it('should throw error when executing with undefined input', async () => {
      const tool = createUploadBlobTool(mockContext);

      // Test that execute throws when input is undefined
      await expect(tool.execute({ input: undefined } as any)).rejects.toThrow(
        "The 'input' parameter is required. Pass the URL, file path, or base64 data via { input: '...' }. Note: The parameter name is 'input', not 'url' or 'file'."
      );
    });
  });
});
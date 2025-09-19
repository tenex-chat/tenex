import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createUploadBlobTool } from '../implementations/upload_blob';
import type { ExecutionContext } from '@/agents/execution/types';
import type { AgentInstance } from '@/agents/types';

// Mock the fetch global
global.fetch = jest.fn();

describe('upload_blob URL support', () => {
  let mockContext: ExecutionContext;
  let mockAgent: Partial<AgentInstance>;

  beforeEach(() => {
    jest.clearAllMocks();
    
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

  describe('URL detection', () => {
    it('should detect valid HTTP URLs', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'http://example.com/image.jpg'
      });
      expect(humanReadable).toContain('Downloading and uploading from example.com');
    });

    it('should detect valid HTTPS URLs', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://secure.example.com/media/video.mp4'
      });
      expect(humanReadable).toContain('Downloading and uploading from secure.example.com');
    });

    it('should not treat file paths as URLs', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: '/home/user/image.jpg'
      });
      expect(humanReadable).toContain('Uploading file:');
      expect(humanReadable).not.toContain('Downloading');
    });

    it('should not treat relative paths as URLs', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: './images/photo.png'
      });
      expect(humanReadable).toContain('Uploading file:');
      expect(humanReadable).not.toContain('Downloading');
    });

    it('should not treat invalid protocols as URLs', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'ftp://example.com/file.txt'
      });
      expect(humanReadable).toContain('Uploading file:');
      expect(humanReadable).not.toContain('Downloading');
    });
  });

  describe('URL with query parameters', () => {
    it('should handle URLs with query strings', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://api.example.com/image?size=large&format=jpg'
      });
      expect(humanReadable).toContain('Downloading and uploading from api.example.com');
    });

    it('should handle URLs with hash fragments', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://example.com/page#section/image.png'
      });
      expect(humanReadable).toContain('Downloading and uploading from example.com');
    });
  });

  describe('URL edge cases', () => {
    it('should handle URLs with ports', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://example.com:8080/media/file.pdf'
      });
      expect(humanReadable).toContain('Downloading and uploading from example.com');
    });

    it('should handle URLs with authentication (not recommended)', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://user:pass@example.com/secure/image.jpg'
      });
      expect(humanReadable).toContain('Downloading and uploading from example.com');
    });

    it('should handle URLs with special characters', () => {
      const tool = createUploadBlobTool(mockContext);
      const humanReadable = (tool as any).getHumanReadableContent({
        input: 'https://cdn.example.com/images/photo%20with%20spaces.jpg'
      });
      expect(humanReadable).toContain('Downloading and uploading from cdn.example.com');
    });
  });
});
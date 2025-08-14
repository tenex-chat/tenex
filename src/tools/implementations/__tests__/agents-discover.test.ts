import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { discoverAgents } from '../agents-discover';
import { getNDK } from '@/nostr/ndkClient';
import type NDK from '@nostr-dev-kit/ndk';
import type { NDKEvent } from '@nostr-dev-kit/ndk';

jest.mock('@/nostr/ndkClient');

describe('discoverAgents', () => {
  let mockNDK: jest.Mocked<NDK>;
  let mockEvents: NDKEvent[];

  beforeEach(() => {
    mockEvents = [];
    mockNDK = {
      fetchEvents: jest.fn().mockResolvedValue(new Set(mockEvents))
    } as any;
    
    (getNDK as jest.Mock).mockReturnValue(mockNDK);
  });

  it('should discover agent events from Nostr', async () => {
    // Arrange
    const mockAgentEvent = {
      id: 'test-agent-id',
      pubkey: 'test-pubkey',
      kind: 31550,
      content: 'Test agent content',
      tags: [
        ['title', 'Test Agent'],
        ['role', 'Test Role']
      ],
      tagValue: jest.fn((tag: string) => {
        const tagMap: Record<string, string> = {
          title: 'Test Agent',
          role: 'Test Role'
        };
        return tagMap[tag];
      })
    } as any;
    
    mockEvents = [mockAgentEvent];
    mockNDK.fetchEvents.mockResolvedValue(new Set(mockEvents));

    // Act
    const result = await discoverAgents({ limit: 10 });

    // Assert
    expect(mockNDK.fetchEvents).toHaveBeenCalledWith({
      kinds: [31550],
      limit: 10
    });
    
    expect(result).toContain('Test Agent');
    expect(result).toContain('Test Role');
  });

  it('should handle empty results gracefully', async () => {
    // Arrange
    mockNDK.fetchEvents.mockResolvedValue(new Set());

    // Act
    const result = await discoverAgents({ limit: 10 });

    // Assert
    expect(result).toContain('No agents found');
  });

  it('should filter agents by query', async () => {
    // Arrange
    const mockAgentEvent1 = {
      id: 'agent-1',
      pubkey: 'pubkey-1',
      kind: 31550,
      content: 'Developer agent',
      tags: [
        ['title', 'Code Assistant'],
        ['role', 'Developer']
      ],
      tagValue: jest.fn((tag: string) => {
        const tagMap: Record<string, string> = {
          title: 'Code Assistant',
          role: 'Developer'
        };
        return tagMap[tag];
      })
    } as any;

    const mockAgentEvent2 = {
      id: 'agent-2',
      pubkey: 'pubkey-2',
      kind: 31550,
      content: 'Designer agent',
      tags: [
        ['title', 'UI Designer'],
        ['role', 'Designer']
      ],
      tagValue: jest.fn((tag: string) => {
        const tagMap: Record<string, string> = {
          title: 'UI Designer',
          role: 'Designer'
        };
        return tagMap[tag];
      })
    } as any;
    
    mockEvents = [mockAgentEvent1, mockAgentEvent2];
    mockNDK.fetchEvents.mockResolvedValue(new Set(mockEvents));

    // Act
    const result = await discoverAgents({ query: 'developer', limit: 10 });

    // Assert
    expect(result).toContain('Code Assistant');
    expect(result).toContain('Developer');
    expect(result).not.toContain('UI Designer');
  });
});
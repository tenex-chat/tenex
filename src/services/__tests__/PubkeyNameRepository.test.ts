import { beforeEach, describe, expect, it, mock } from "bun:test";
import { PubkeyNameRepository } from "../PubkeyNameRepository";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock the modules
mock.module("@/nostr", () => ({
  getNDK: mock(() => ({
    fetchEvent: mock(async () => null)
  }))
}));

mock.module("@/services", () => ({
  getProjectContext: mock(() => ({})),
  isProjectContextInitialized: mock(() => true)
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  }
}));

// Import after mocking
import { getNDK } from "@/nostr";
import { getProjectContext, isProjectContextInitialized } from "@/services";

describe("PubkeyNameRepository", () => {
  let repository: PubkeyNameRepository;
  let mockNDK: any;
  let mockProjectContext: any;

  beforeEach(() => {
    // Reset singleton
    (PubkeyNameRepository as any).instance = undefined;
    repository = PubkeyNameRepository.getInstance();
    
    // Setup mock NDK
    mockNDK = {
      fetchEvent: mock(async () => null)
    };
    (getNDK as any).mockReturnValue(mockNDK);
    
    // Setup mock project context with agents
    mockProjectContext = {
      pubkey: "project-pubkey",
      agents: new Map<string, AgentInstance>([
        ["code-writer", {
          name: "Code Writer",
          slug: "code-writer",
          pubkey: "agent1-pubkey",
          role: "developer",
          llmConfig: "default",
          tools: [],
          signer: {} as any
        }],
        ["tester", {
          name: "Tester",
          slug: "tester",
          pubkey: "agent2-pubkey",
          role: "tester",
          llmConfig: "default",
          tools: [],
          signer: {} as any
        }]
      ])
    };
    
    (getProjectContext as any).mockReturnValue(mockProjectContext);
    (isProjectContextInitialized as any).mockReturnValue(true);
    
    // Clear any cached data
    repository.clearCache();
  });

  describe("Agent name resolution", () => {
    it("should return agent slug for agent pubkey", async () => {
      const name = await repository.getName("agent1-pubkey");
      expect(name).toBe("code-writer");
    });

    it("should return agent slug synchronously", () => {
      const name = repository.getNameSync("agent2-pubkey");
      expect(name).toBe("tester");
    });

    it("should handle project context not initialized", async () => {
      (isProjectContextInitialized as any).mockReturnValue(false);
      
      const name = await repository.getName("agent1-pubkey");
      expect(name).toBe("User"); // Falls back to default
    });
  });

  describe("User profile fetching", () => {
    it("should fetch and cache user profile from kind:0 event", async () => {
      const mockProfileEvent = {
        id: "profile-event-id",
        content: JSON.stringify({
          name: "Alice",
          display_name: "Alice Smith",
          about: "Nostr user",
          picture: "https://example.com/pic.jpg"
        })
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfileEvent);
      
      const name = await repository.getName("user-pubkey");
      expect(name).toBe("Alice"); // name takes priority
      
      // Verify caching works
      const cachedName = await repository.getName("user-pubkey");
      expect(cachedName).toBe("Alice");
      expect(mockNDK.fetchEvent).toHaveBeenCalledTimes(1); // Not called again
    });

    it("should prioritize name over display_name", async () => {
      const mockProfileEvent = {
        id: "profile-event-id",
        content: JSON.stringify({
          name: "alice",
          display_name: "Alice Smith"
        })
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfileEvent);
      
      const name = await repository.getName("user-pubkey");
      expect(name).toBe("alice");
    });

    it("should fall back to display_name if no name", async () => {
      const mockProfileEvent = {
        id: "profile-event-id",
        content: JSON.stringify({
          display_name: "Alice Display",
          username: "alice123"
        })
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfileEvent);
      
      const name = await repository.getName("user-pubkey");
      expect(name).toBe("Alice Display");
    });

    it("should fall back to username if no name or display_name", async () => {
      const mockProfileEvent = {
        id: "profile-event-id",
        content: JSON.stringify({
          username: "alice123",
          about: "Just a user"
        })
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfileEvent);
      
      const name = await repository.getName("user-pubkey");
      expect(name).toBe("alice123");
    });

    it("should return default name if profile fetch fails", async () => {
      mockNDK.fetchEvent.mockRejectedValueOnce(new Error("Network error"));
      
      const name = await repository.getName("unknown-user-pubkey");
      expect(name).toBe("User");
    });

    it("should return default name if profile is empty", async () => {
      mockNDK.fetchEvent.mockResolvedValueOnce(null);
      
      const name = await repository.getName("user-without-profile");
      expect(name).toBe("User");
    });

    it("should handle malformed profile content", async () => {
      const mockProfileEvent = {
        id: "profile-event-id",
        content: "not-valid-json"
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfileEvent);
      
      const name = await repository.getName("user-with-bad-profile");
      expect(name).toBe("User");
    });
  });

  describe("Cache management", () => {
    it("should refresh user profile on demand", async () => {
      const firstProfile = {
        id: "profile-v1",
        content: JSON.stringify({ name: "Alice" })
      };
      
      const updatedProfile = {
        id: "profile-v2",
        content: JSON.stringify({ name: "Alice Updated" })
      };
      
      mockNDK.fetchEvent
        .mockResolvedValueOnce(firstProfile)
        .mockResolvedValueOnce(updatedProfile);
      
      const name1 = await repository.getName("user-pubkey");
      expect(name1).toBe("Alice");
      
      await repository.refreshUserProfile("user-pubkey");
      
      const name2 = await repository.getName("user-pubkey");
      expect(name2).toBe("Alice Updated");
      
      expect(mockNDK.fetchEvent).toHaveBeenCalledTimes(2);
    });

    it("should clear cache", async () => {
      const mockProfile = {
        id: "profile-id",
        content: JSON.stringify({ name: "Bob" })
      };
      
      mockNDK.fetchEvent.mockResolvedValue(mockProfile);
      
      await repository.getName("user-pubkey");
      expect(mockNDK.fetchEvent).toHaveBeenCalledTimes(1);
      
      repository.clearCache();
      
      await repository.getName("user-pubkey");
      expect(mockNDK.fetchEvent).toHaveBeenCalledTimes(2);
    });

    it("should provide cache statistics", async () => {
      const mockProfile = {
        id: "profile-id",
        content: JSON.stringify({ name: "Charlie" })
      };
      
      mockNDK.fetchEvent.mockResolvedValue(mockProfile);
      
      await repository.getName("user1-pubkey");
      await repository.getName("user2-pubkey");
      
      const stats = repository.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.entries).toContain("user1-pubkey");
      expect(stats.entries).toContain("user2-pubkey");
    });
  });

  describe("getNameSync", () => {
    it("should return agent slug synchronously for agents", () => {
      const name = repository.getNameSync("agent1-pubkey");
      expect(name).toBe("code-writer");
    });

    it("should return cached user name if available", async () => {
      const mockProfile = {
        id: "profile-id",
        content: JSON.stringify({ name: "Dave" })
      };
      
      mockNDK.fetchEvent.mockResolvedValueOnce(mockProfile);
      
      // First fetch to populate cache
      await repository.getName("user-pubkey");
      
      // Now sync should work from cache
      const name = repository.getNameSync("user-pubkey");
      expect(name).toBe("Dave");
    });

    it("should return default name if not cached", () => {
      const name = repository.getNameSync("uncached-user-pubkey");
      expect(name).toBe("User");
    });
  });
});
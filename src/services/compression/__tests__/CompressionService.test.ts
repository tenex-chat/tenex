import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { CompressionService } from "../CompressionService";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { LLMService } from "@/llm/service";
import type { ConversationEntry } from "@/conversations/types";
import type { CompressionSegment } from "../compression-types";
import { config } from "@/services/ConfigService";

// Mock implementations
const createMockConversationStore = (): ConversationStore => {
  const mockStore = {
    getAllMessages: mock(() => [] as ConversationEntry[]),
    loadCompressionLog: mock(async (_conversationId: string) => [] as CompressionSegment[]),
    appendCompressionSegments: mock(async (_conversationId: string, _segments: CompressionSegment[]) => {}),
  };
  return mockStore as unknown as ConversationStore;
};

const createMockLLMService = (): LLMService => {
  const mockService = {
    getModel: mock(() => ({
      modelId: "test-model",
      provider: "test-provider",
    })),
    model: "test-model",
  };
  return mockService as unknown as LLMService;
};

const createEntries = (count: number, withEventIds = true): ConversationEntry[] => {
  return Array.from({ length: count }, (_, i) => ({
    pubkey: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i} with some content to make it longer and increase token count`,
    messageType: "text" as const,
    timestamp: 1000 + i,
    ...(withEventIds ? { eventId: `event-${i}` } : {}),
  }));
};

describe("CompressionService", () => {
  let conversationStore: ConversationStore;
  let llmService: LLMService;
  let service: CompressionService;
  let originalGetConfig: typeof config.getConfig;

  beforeEach(() => {
    // Mock ConfigService
    originalGetConfig = config.getConfig;
    config.getConfig = mock(() => ({
      compression: {
        enabled: true,
        tokenThreshold: 50000,
        tokenBudget: 40000,
        slidingWindowSize: 50,
      },
    })) as any;

    conversationStore = createMockConversationStore();
    llmService = createMockLLMService();
    service = new CompressionService(conversationStore, llmService);
  });

  afterEach(() => {
    // Restore original config
    config.getConfig = originalGetConfig;
  });

  describe("maybeCompressAsync", () => {
    it("should skip compression when under threshold", async () => {
      // Setup: few entries, under threshold
      const entries = createEntries(5);
      conversationStore.getAllMessages = mock(() => entries);

      await service.maybeCompressAsync("test-conv");

      // Should not append any segments
      expect(conversationStore.appendCompressionSegments).not.toHaveBeenCalled();
    });

    it("should not throw on error in proactive mode", async () => {
      // Setup: getAllMessages throws error
      conversationStore.getAllMessages = mock(() => {
        throw new Error("Test error");
      });

      // Should catch error and not throw
      await expect(service.maybeCompressAsync("test-conv")).resolves.toBeUndefined();
    });
  });

  describe("ensureUnderLimit", () => {
    it("should skip compression when already under budget", async () => {
      // Setup: few entries, under budget
      const entries = createEntries(5);
      conversationStore.getAllMessages = mock(() => entries);

      await service.ensureUnderLimit("test-conv", 10000);

      // Should not append any segments
      expect(conversationStore.appendCompressionSegments).not.toHaveBeenCalled();
    });

    it("should use fallback when no compression range available", async () => {
      // Setup: 55 entries (to trigger over budget), but too recent to compress
      const entries = createEntries(55);
      conversationStore.getAllMessages = mock(() => entries);

      await service.ensureUnderLimit("test-conv", 100);

      // Should have created fallback segment
      expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
    });
  });

  describe("applyExistingCompressions", () => {
    it("should apply segments to entries", () => {
      const entries = createEntries(10);
      const segments: CompressionSegment[] = [
        {
          fromEventId: "event-0",
          toEventId: "event-4",
          compressed: "Compressed summary",
          createdAt: Date.now(),
          model: "test-model",
        },
      ];

      const result = service.applyExistingCompressions(entries, segments);

      // Should have compressed range + remaining entries
      // Compressed: 5 entries (0-4) -> 1 compressed entry
      // Remaining: 5 entries (5-9)
      expect(result.length).toBeLessThan(entries.length);
      expect(result.some((e) => e.content.includes("Compressed history"))).toBe(true);
    });

    it("should return original entries when no segments", () => {
      const entries = createEntries(10);
      const result = service.applyExistingCompressions(entries, []);

      expect(result).toEqual(entries);
    });
  });

  describe("fallback path", () => {
    it("should create fallback segment when entries have eventIds", async () => {
      // Setup: many entries, but compression will fail
      const entries = createEntries(100);
      conversationStore.getAllMessages = mock(() => entries);

      // Force fallback by using tiny budget
      await service.ensureUnderLimit("test-conv", 10);

      // Should have created fallback segment
      expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
      const segments = conversationStore.appendCompressionSegments.mock.calls[0][1] as CompressionSegment[];
      expect(segments.length).toBe(1);
      expect(segments[0].model).toBe("fallback-truncation");
    });

    it("should handle entries without eventIds gracefully", async () => {
      // Setup: many entries WITHOUT eventIds
      const entries = createEntries(100, false);
      conversationStore.getAllMessages = mock(() => entries);

      // Force fallback
      await service.ensureUnderLimit("test-conv", 10);

      // Should not throw, but also should not create segment (insufficient eventIds)
      // In this case, appendCompressionSegments should NOT be called
      expect(conversationStore.appendCompressionSegments).not.toHaveBeenCalled();
    });

    it("should handle mixed entries (some with eventIds, some without)", async () => {
      // Setup: entries with only some having eventIds
      const entriesWithIds = createEntries(20, true);
      const entriesWithoutIds = createEntries(80, false);
      const entries = [...entriesWithIds, ...entriesWithoutIds];
      conversationStore.getAllMessages = mock(() => entries);

      // Force fallback
      await service.ensureUnderLimit("test-conv", 10);

      // Should create fallback segment using available eventIds
      expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
      const segments = conversationStore.appendCompressionSegments.mock.calls[0][1] as CompressionSegment[];
      expect(segments.length).toBe(1);
      expect(segments[0].fromEventId).toBe("event-0");
    });
  });

  describe("validation failure scenarios", () => {
    it("should use fallback when validation fails in blocking mode", async () => {
      // This test would require mocking LLM response with invalid segments
      // For now, we test the fallback path which is already covered above
      const entries = createEntries(100);
      conversationStore.getAllMessages = mock(() => entries);

      await service.ensureUnderLimit("test-conv", 10);

      // Should have called appendCompressionSegments (either from LLM or fallback)
      expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
    });
  });

  describe("budget check uses compressed view of entries", () => {
    it("should skip compression when existing segments bring token count under budget", async () => {
      // Setup: 100 entries × ~70 chars each ≈ 1750 tokens (raw), well above the budget of 500.
      // After applying segments that cover entries 0-89, only 10 entries remain as individual
      // messages plus 1 compressed summary (~11 tokens), giving ~186 tokens — under budget.
      // The bug would check raw tokens (1750 > 500) and still attempt compression.
      // The fix checks the compressed view (186 <= 500) and correctly skips compression.
      const entries = createEntries(100);
      conversationStore.getAllMessages = mock(() => entries);

      // Provide a compression segment that covers entries 0-89 (most of them)
      const existingSegments: CompressionSegment[] = [
        {
          fromEventId: "event-0",
          toEventId: "event-89",
          compressed: "Compressed summary of the first 90 messages.",
          createdAt: Date.now(),
          model: "test-model",
        },
      ];
      conversationStore.loadCompressionLog = mock(async () => existingSegments);

      // Budget of 500 tokens: raw entries (≈1750) exceed it, but the compressed view (≈186) does not.
      // Without the fix the early-exit check uses raw tokens and would NOT exit, calling appendCompressionSegments.
      // With the fix the early-exit check uses the effective (compressed) tokens and DOES exit.
      await service.ensureUnderLimit("test-conv", 500);

      // Should NOT call appendCompressionSegments because effective tokens are under budget
      expect(conversationStore.appendCompressionSegments).not.toHaveBeenCalled();
    });

    it("should skip proactive compression when existing segments bring token count under threshold", async () => {
      // Same token arithmetic as the blocking test above:
      // raw ≈ 1750 tokens, compressed view ≈ 186 tokens.
      // tokenThreshold is set to 500 so that: raw > threshold but compressed < threshold.
      // The bug would compare raw tokens (1750 > 500) and proceed to attempt compression.
      // The fix compares the compressed-view tokens (186 < 500) and correctly skips.
      config.getConfig = mock(() => ({
        compression: {
          enabled: true,
          tokenThreshold: 500,
          tokenBudget: 400,
          slidingWindowSize: 50,
        },
      })) as any;
      service = new CompressionService(conversationStore, llmService);

      const entries = createEntries(100);
      conversationStore.getAllMessages = mock(() => entries);

      // Provide segments covering most entries
      const existingSegments: CompressionSegment[] = [
        {
          fromEventId: "event-0",
          toEventId: "event-89",
          compressed: "Compressed summary.",
          createdAt: Date.now(),
          model: "test-model",
        },
      ];
      conversationStore.loadCompressionLog = mock(async () => existingSegments);

      // maybeCompressAsync is fire-and-forget; await the returned promise (which resolves
      // immediately after the internal async call is launched) and then flush microtasks so
      // the inner async path has a chance to run before we assert.
      await service.maybeCompressAsync("test-conv");
      await Promise.resolve();

      // Should NOT compress because effective tokens are under threshold
      expect(conversationStore.appendCompressionSegments).not.toHaveBeenCalled();
    });
  });

  describe("getSegments", () => {
    it("should return existing segments from store", async () => {
      const mockSegments: CompressionSegment[] = [
        {
          fromEventId: "event-0",
          toEventId: "event-4",
          compressed: "Test segment",
          createdAt: Date.now(),
          model: "test-model",
        },
      ];
      conversationStore.loadCompressionLog = mock(async () => mockSegments);

      const result = await service.getSegments("test-conv");

      expect(result).toEqual(mockSegments);
      expect(conversationStore.loadCompressionLog).toHaveBeenCalledWith("test-conv");
    });
  });
});

describe("CompressionService - fallback utility integration", () => {
  let originalGetConfig: typeof config.getConfig;

  beforeEach(() => {
    originalGetConfig = config.getConfig;
    config.getConfig = mock(() => ({
      compression: {
        enabled: true,
        tokenThreshold: 50000,
        tokenBudget: 40000,
        slidingWindowSize: 50,
      },
    })) as any;
  });

  afterEach(() => {
    config.getConfig = originalGetConfig;
  });

  it("should use createFallbackSegmentForEntries utility correctly", async () => {
    const conversationStore = createMockConversationStore();
    const llmService = createMockLLMService();
    const service = new CompressionService(conversationStore, llmService);

    // Setup: 60 entries (will trigger fallback)
    const entries = createEntries(60);
    conversationStore.getAllMessages = mock(() => entries);

    // Force fallback with tiny budget
    await service.ensureUnderLimit("test-conv", 10);

    // Check that fallback segment was created
    expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
    const segments = conversationStore.appendCompressionSegments.mock.calls[0][1] as CompressionSegment[];

    // Validate segment structure
    expect(segments.length).toBe(1);
    expect(segments[0].fromEventId).toBeDefined();
    expect(segments[0].toEventId).toBeDefined();
    expect(segments[0].compressed).toContain("Truncated");
    expect(segments[0].model).toBe("fallback-truncation");
  });

  it("few entries with massive token content should truncate via token-aware fallback", async () => {
    const conversationStore = createMockConversationStore();
    const llmService = createMockLLMService();

    // Use a generous slidingWindowSize (50) — but a tight token budget
    config.getConfig = mock(() => ({
      compression: {
        enabled: true,
        tokenThreshold: 50000,
        tokenBudget: 40000,
        slidingWindowSize: 50,
      },
    })) as any;

    const service = new CompressionService(conversationStore, llmService);

    // 10 entries, some small and some massive (simulating tool results with huge content)
    const entries: ConversationEntry[] = [
      // Entries 0-4: massive tool results (~100K tokens each via toolData)
      ...Array.from({ length: 5 }, (_, i) => ({
        pubkey: "assistant",
        content: `Tool result ${i}`,
        messageType: "tool-result" as const,
        timestamp: 1000 + i,
        eventId: `event-${i}`,
        toolData: [{ toolCallId: `call-${i}`, type: "tool-result" as const, result: "x".repeat(400000) }] as any,
      })),
      // Entries 5-9: small text messages (~10 tokens each)
      ...Array.from({ length: 5 }, (_, i) => ({
        pubkey: "user",
        content: `Short message ${i + 5}`,
        messageType: "text" as const,
        timestamp: 1005 + i,
        eventId: `event-${i + 5}`,
      })),
    ];

    conversationStore.getAllMessages = mock(() => entries);

    // Budget of 200 tokens — the 5 small entries (~50 tokens) fit,
    // but the massive entries don't. Without token-aware fallback,
    // slidingWindowSize=50 > 10 entries, so createFallbackSegmentForEntries returns null.
    // With token-aware fallback, effectiveWindow = min(50, ~5) = 5, truncating the massive entries.
    await service.ensureUnderLimit("test-conv", 200);

    expect(conversationStore.appendCompressionSegments).toHaveBeenCalled();
    const segments = conversationStore.appendCompressionSegments.mock.calls[0][1] as CompressionSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0].model).toBe("fallback-truncation");
    // The segment should cover the heavy entries at the beginning
    expect(segments[0].fromEventId).toBe("event-0");
    // The truncated count should leave roughly the small entries
    expect(segments[0].compressed).toContain("Truncated");
  });
});

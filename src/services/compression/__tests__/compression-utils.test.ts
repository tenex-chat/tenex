import { describe, it, expect } from "bun:test";
import type { ConversationEntry } from "@/conversations/types";
import type { CompiledMessage } from "@/agents/execution/MessageCompiler";
import type { CompressionSegment } from "../compression-types";
import {
  estimateTokens,
  estimateTokensFromEntries,
  selectCandidateRange,
  selectCandidateRangeFromEntries,
  validateSegments,
  validateSegmentsForEntries,
  applySegments,
  applySegmentsToEntries,
  truncateSlidingWindow,
  truncateSlidingWindowEntries,
} from "../compression-utils";

describe("estimateTokens", () => {
  it("should estimate tokens for simple string messages", () => {
    const messages: CompiledMessage[] = [
      { role: "user", content: "Hello world" }, // 11 chars
      { role: "assistant", content: "Hi there" }, // 8 chars
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBe(5); // (11 + 8) / 4 = 4.75, rounded up to 5
  });

  it("should handle complex message content", () => {
    const messages: CompiledMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("should return 0 for empty messages", () => {
    const messages: CompiledMessage[] = [];
    const tokens = estimateTokens(messages);
    expect(tokens).toBe(0);
  });
});

describe("estimateTokensFromEntries", () => {
  it("should estimate tokens for entries", () => {
    const entries: ConversationEntry[] = [
      {
        pubkey: "user1",
        content: "Hello world",
        messageType: "text",
        timestamp: 1000,
      },
      {
        pubkey: "user2",
        content: "Hi there",
        messageType: "text",
        timestamp: 1001,
      },
    ];
    const tokens = estimateTokensFromEntries(entries);
    expect(tokens).toBe(5); // (11 + 8) / 4 = 4.75, rounded up to 5
  });
});

describe("selectCandidateRange", () => {
  const createMessages = (count: number): CompiledMessage[] => {
    return Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      eventId: `event-${i}`,
    }));
  };

  it("should return null for too few messages", () => {
    const messages = createMessages(5);
    const range = selectCandidateRange(messages, null);
    expect(range).toBeNull();
  });

  it("should select middle range for sufficient messages", () => {
    const messages = createMessages(50);
    const range = selectCandidateRange(messages, null);
    expect(range).not.toBeNull();
    expect(range!.startIndex).toBe(0);
    expect(range!.endIndex).toBe(40); // 50 - (50 * 0.2) = 40
  });

  it("should skip already compressed range", () => {
    const messages = createMessages(100);
    const lastSegment: CompressionSegment = {
      fromEventId: "event-0",
      toEventId: "event-30",
      compressed: "Summary",
      createdAt: Date.now(),
      model: "test-model",
    };
    const range = selectCandidateRange(messages, lastSegment);
    expect(range).not.toBeNull();
    expect(range!.startIndex).toBe(31); // After event-30
  });

  it("should return null if range is too small after last segment", () => {
    const messages = createMessages(20);
    const lastSegment: CompressionSegment = {
      fromEventId: "event-0",
      toEventId: "event-14",
      compressed: "Summary",
      createdAt: Date.now(),
      model: "test-model",
    };
    const range = selectCandidateRange(messages, lastSegment);
    // endIndex would be 16 (20 - 4), startIndex would be 15
    // Range of 15-16 is only 1 message, which is < 5
    expect(range).toBeNull();
  });
});

describe("selectCandidateRangeFromEntries", () => {
  const createEntries = (count: number): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: "user1",
      content: `Entry ${i}`,
      messageType: "text",
      timestamp: 1000 + i,
      eventId: `event-${i}`,
    }));
  };

  it("should select middle range for sufficient entries", () => {
    const entries = createEntries(50);
    const range = selectCandidateRangeFromEntries(entries, null);
    expect(range).not.toBeNull();
    expect(range!.startIndex).toBe(0);
    expect(range!.endIndex).toBe(40);
  });
});

describe("validateSegments", () => {
  const createMessages = (count: number): CompiledMessage[] => {
    return Array.from({ length: count }, (_, i) => ({
      role: "user",
      content: `Message ${i}`,
      eventId: `event-${i}`,
    }));
  };

  it("should validate valid segments", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-4",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-5",
        toEventId: "event-9",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegments(segments, messages, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(true);
  });

  it("should reject segments with missing event IDs", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-missing",
        toEventId: "event-4",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegments(segments, messages, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found in range");
  });

  it("should reject segments with reversed order", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-5",
        toEventId: "event-2",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegments(segments, messages, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(false);
    // Now catches range boundary issue first
    expect(result.error).toContain("must start at range beginning");
  });

  it("should allow segments with gaps", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-2",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-5", // Gap from event-3 to event-4 is now allowed
        toEventId: "event-9",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegments(segments, messages, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(true);
  });

  it("should reject segments with overlaps", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-5",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-4", // Overlaps with previous segment
        toEventId: "event-9",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegments(segments, messages, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Overlap between segment");
  });

  it("should reject empty segments array", () => {
    const messages = createMessages(10);
    const result = validateSegments([], messages, { startIndex: 0, endIndex: 10 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No segments provided");
  });
});

describe("validateSegmentsForEntries", () => {
  const createEntries = (count: number): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: "user1",
      content: `Entry ${i}`,
      messageType: "text",
      timestamp: 1000 + i,
      eventId: `event-${i}`,
    }));
  };

  it("should validate valid segments for entries", () => {
    const entries = createEntries(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-4",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-5",
        toEventId: "event-9",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = validateSegmentsForEntries(segments, entries, {
      startIndex: 0,
      endIndex: 10,
    });
    expect(result.valid).toBe(true);
  });
});

describe("applySegments", () => {
  const createMessages = (count: number): CompiledMessage[] => {
    return Array.from({ length: count }, (_, i) => ({
      role: "user",
      content: `Message ${i}`,
      eventId: `event-${i}`,
    }));
  };

  it("should apply single segment", () => {
    const messages = createMessages(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-2",
        toEventId: "event-5",
        compressed: "Compressed summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = applySegments(messages, segments);

    expect(result.length).toBe(7); // 0,1, compressed, 6,7,8,9
    expect(result[0].content).toBe("Message 0");
    expect(result[1].content).toBe("Message 1");
    expect(result[2].role).toBe("system");
    expect(result[2].content).toContain("Compressed summary");
    expect(result[3].content).toBe("Message 6");
  });

  it("should apply multiple segments", () => {
    const messages = createMessages(20);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-2",
        toEventId: "event-5",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-10",
        toEventId: "event-15",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = applySegments(messages, segments);

    // Should have: 0,1, compressed1, 6-9, compressed2, 16-19
    expect(result.length).toBe(12);
    expect(result[2].role).toBe("system");
    expect(result[2].content).toContain("Summary 1");
  });

  it("should return original messages if no segments", () => {
    const messages = createMessages(5);
    const result = applySegments(messages, []);
    expect(result).toEqual(messages);
  });

  it("should skip segments that don't match", () => {
    const messages = createMessages(5);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-missing",
        toEventId: "event-99",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = applySegments(messages, segments);
    expect(result).toEqual(messages); // Unchanged
  });
});

describe("applySegmentsToEntries", () => {
  const createEntries = (count: number): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: "user1",
      content: `Entry ${i}`,
      messageType: "text",
      timestamp: 1000 + i,
      eventId: `event-${i}`,
    }));
  };

  it("should apply segment to entries", () => {
    const entries = createEntries(10);
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-2",
        toEventId: "event-5",
        compressed: "Compressed summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];
    const result = applySegmentsToEntries(entries, segments);

    expect(result.length).toBe(7);
    expect(result[2].pubkey).toBe("system");
    expect(result[2].content).toContain("Compressed summary");
  });
});

describe("truncateSlidingWindow", () => {
  const createMessages = (count: number): CompiledMessage[] => {
    return Array.from({ length: count }, (_, i) => ({
      role: "user",
      content: `Message ${i}`,
      eventId: `event-${i}`,
    }));
  };

  it("should truncate to window size", () => {
    const messages = createMessages(100);
    const result = truncateSlidingWindow(messages, 10, 123456);

    expect(result.length).toBe(11); // 10 + truncation message
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("last 10 messages");
    expect(result[0].eventId).toBe("truncated-123456");
    expect(result[1].content).toBe("Message 90");
    expect(result[10].content).toBe("Message 99");
  });

  it("should not truncate if already under window size", () => {
    const messages = createMessages(5);
    const result = truncateSlidingWindow(messages, 10, 123456);
    expect(result).toEqual(messages);
  });

  it("should use provided timestamp for determinism", () => {
    const messages = createMessages(100);
    const result1 = truncateSlidingWindow(messages, 10, 111111);
    const result2 = truncateSlidingWindow(messages, 10, 222222);

    expect(result1[0].eventId).toBe("truncated-111111");
    expect(result2[0].eventId).toBe("truncated-222222");
  });
});

describe("truncateSlidingWindowEntries", () => {
  const createEntries = (count: number): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: "user1",
      content: `Entry ${i}`,
      messageType: "text",
      timestamp: 1000 + i,
      eventId: `event-${i}`,
    }));
  };

  it("should truncate entries to window size", () => {
    const entries = createEntries(100);
    const result = truncateSlidingWindowEntries(entries, 10, 123456000);

    expect(result.length).toBe(11);
    expect(result[0].pubkey).toBe("system");
    expect(result[0].content).toContain("last 10 messages");
    expect(result[0].timestamp).toBe(123456); // Converted from ms to seconds
  });
});

describe("Compression Schema", () => {
  it("should validate compression segment input", async () => {
    const { CompressionSegmentsSchema } = await import("../compression-schema");

    const validInput = [
      {
        fromEventId: "event1",
        toEventId: "event2",
        compressed: "Summary text",
      },
    ];

    const result = CompressionSegmentsSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("should reject invalid compression segment input", async () => {
    const { CompressionSegmentsSchema } = await import("../compression-schema");

    const invalidInput = [
      {
        fromEventId: "event1",
        toEventId: "", // Empty toEventId
        compressed: "Summary text",
      },
    ];

    const result = CompressionSegmentsSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it("should reject empty compressed content", async () => {
    const { CompressionSegmentsSchema } = await import("../compression-schema");

    const invalidInput = [
      {
        fromEventId: "event1",
        toEventId: "event2",
        compressed: "", // Empty compressed
      },
    ];

    const result = CompressionSegmentsSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});

describe("Compression Configuration", () => {
  it("should have valid default configuration structure", () => {
    const defaultConfig = {
      enabled: true,
      tokenThreshold: 50000,
      tokenBudget: 40000,
      slidingWindowSize: 50,
    };

    expect(defaultConfig.enabled).toBe(true);
    expect(defaultConfig.tokenThreshold).toBeGreaterThan(defaultConfig.tokenBudget);
    expect(defaultConfig.slidingWindowSize).toBeGreaterThan(0);
  });
});

describe("createFallbackSegmentForEntries", async () => {
  const { createFallbackSegmentForEntries } = await import("../compression-utils");

  const createEntries = (count: number, withEventIds = true): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      messageType: "text" as const,
      timestamp: 1000 + i,
      ...(withEventIds ? { eventId: `event-${i}` } : {}),
    }));
  };

  it("should create fallback segment for entries with eventIds", () => {
    const entries = createEntries(100);
    const windowSize = 50;

    const segment = createFallbackSegmentForEntries(entries, windowSize);

    expect(segment).not.toBeNull();
    expect(segment!.fromEventId).toBe("event-0");
    expect(segment!.model).toBe("fallback-truncation");
    expect(segment!.compressed).toContain("Truncated 50 earlier messages");
  });

  it("should return null when entries <= windowSize", () => {
    const entries = createEntries(50);
    const windowSize = 50;

    const segment = createFallbackSegmentForEntries(entries, windowSize);

    expect(segment).toBeNull();
  });

  it("should return null when insufficient eventIds", () => {
    const entries = createEntries(100, false); // No eventIds

    const segment = createFallbackSegmentForEntries(entries, 50);

    expect(segment).toBeNull();
  });

  it("should handle mixed entries (some with eventIds)", () => {
    const entriesWithIds = createEntries(30, true);
    const entriesWithoutIds = createEntries(70, false);
    const entries = [...entriesWithIds, ...entriesWithoutIds];

    const segment = createFallbackSegmentForEntries(entries, 50);

    expect(segment).not.toBeNull();
    expect(segment!.fromEventId).toBe("event-0");
    // Should use last entry with eventId before truncation point
  });

  it("should find correct toEventId within truncate range", () => {
    const entries = createEntries(100);
    const windowSize = 50;

    const segment = createFallbackSegmentForEntries(entries, windowSize);

    expect(segment).not.toBeNull();
    // toEventId should be at or before index 49 (truncateCount - 1)
    const toIndex = parseInt(segment!.toEventId.split("-")[1]);
    expect(toIndex).toBeLessThan(50);
  });
});

describe("validateSegmentsForEntries - enhanced", async () => {
  const { validateSegmentsForEntries } = await import("../compression-utils");

  const createEntries = (count: number): ConversationEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      pubkey: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      messageType: "text" as const,
      timestamp: 1000 + i,
      eventId: `event-${i}`,
    }));
  };

  it("should reject segments that don't start at range beginning", () => {
    const entries = createEntries(20);
    const range = { startIndex: 0, endIndex: 10 };
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-2", // Should be event-0
        toEventId: "event-9",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];

    const result = validateSegmentsForEntries(segments, entries, range);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("must start at range beginning");
  });

  it("should reject segments that don't end at range end", () => {
    const entries = createEntries(20);
    const range = { startIndex: 0, endIndex: 10 };
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-7", // Should be event-9
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];

    const result = validateSegmentsForEntries(segments, entries, range);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("must end at range end");
  });

  it("should accept segments that cover entire range", () => {
    const entries = createEntries(20);
    const range = { startIndex: 0, endIndex: 10 };
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-9",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];

    const result = validateSegmentsForEntries(segments, entries, range);

    expect(result.valid).toBe(true);
  });

  it("should accept multiple segments that cover entire range", () => {
    const entries = createEntries(20);
    const range = { startIndex: 0, endIndex: 10 };
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-4",
        compressed: "Summary 1",
        createdAt: Date.now(),
        model: "test",
      },
      {
        fromEventId: "event-5",
        toEventId: "event-9",
        compressed: "Summary 2",
        createdAt: Date.now(),
        model: "test",
      },
    ];

    const result = validateSegmentsForEntries(segments, entries, range);

    expect(result.valid).toBe(true);
  });

  it("should reject when no entries with eventIds in range", () => {
    const entries: ConversationEntry[] = Array.from({ length: 20 }, (_, i) => ({
      pubkey: "user",
      content: `Message ${i}`,
      messageType: "text" as const,
      timestamp: 1000 + i,
      // No eventIds
    }));
    const range = { startIndex: 0, endIndex: 10 };
    const segments: CompressionSegment[] = [
      {
        fromEventId: "event-0",
        toEventId: "event-9",
        compressed: "Summary",
        createdAt: Date.now(),
        model: "test",
      },
    ];

    const result = validateSegmentsForEntries(segments, entries, range);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("No entries with eventIds in range");
  });
});

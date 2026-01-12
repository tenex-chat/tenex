import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { AskConfig } from "@/nostr/AgentPublisher";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "@/nostr/AgentEventEncoder";

/**
 * Mock interface for NDKEvent used in tests.
 */
interface MockTriggeringEvent {
  id: string;
  tags: string[][];
  pubkey?: string;
}

/**
 * Mock interface for root event.
 */
interface MockRootEvent {
  id: string;
}

// Minimal mocks
mock.module("@/nostr/ndkClient", () => ({
  getNDK: mock(() => ({})),
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

mock.module("@/services/projects", () => ({
  getProjectContext: mock(() => ({
    project: {
      tagReference: mock(() => ["a", "31933:testpubkey:test-project"]),
      pubkey: "testpubkey",
    },
    projectTag: "31933:testpubkey:test-project",
  })),
  isProjectContextInitialized: mock(() => true),
}));

const mockContext = {
  getValue: () => undefined,
  setValue: () => mockContext,
  deleteValue: () => mockContext,
};

mock.module("@opentelemetry/api", () => ({
  ROOT_CONTEXT: mockContext,
  context: {
    active: mock(() => mockContext),
    with: mock((_ctx: unknown, fn: () => unknown) => fn()),
  },
  propagation: {
    inject: mock(),
  },
  trace: {
    getTracer: mock(() => ({
      startActiveSpan: mock((_name: string, fn: (span: unknown) => unknown) =>
        fn({ setAttributes: mock(), setStatus: mock(), end: mock() })
      ),
    })),
    getActiveSpan: mock(() => null),
    setSpan: mock(() => mockContext),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  TraceFlags: {
    NONE: 0,
    SAMPLED: 1,
  },
}));

mock.module("@/telemetry/LLMSpanRegistry", () => ({
  getLLMSpanId: mock(() => null),
}));

describe("Ask Tool - Multi-question support", () => {
  let mockPublish: ReturnType<typeof mock>;
  let capturedEvents: NDKEvent[] = [];
  let mockAgentInstance: AgentInstance;
  let publisher: AgentPublisher;

  beforeEach(() => {
    capturedEvents = [];

    mockPublish = mock(() => Promise.resolve(new Set()));

    spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
      capturedEvents.push(this);
      return mockPublish();
    });

    mockAgentInstance = {
      slug: "test-agent",
      pubkey: "test-agent-pubkey",
      sign: mock((_event: NDKEvent) => Promise.resolve()),
      projectTag: "31933:testpubkey:test-project",
    } as unknown as AgentInstance;

    publisher = new AgentPublisher(mockAgentInstance);
  });

  afterEach(() => {
    capturedEvents = [];
  });

  function createTestContext(overrides?: Partial<EventContext>): EventContext {
    const triggeringEvent: MockTriggeringEvent = {
      id: "triggering-event-id",
      tags: [],
      pubkey: "triggering-pubkey",
    };
    const rootEvent: MockRootEvent = { id: "root-event-id" };

    return {
      conversationId: "parent-conversation-id",
      triggeringEvent: triggeringEvent as unknown as NDKEvent,
      rootEvent,
      ralNumber: 1,
      ...overrides,
    };
  }

  describe("New multi-question AskConfig format", () => {
    it("should create event with title tag", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "I want to understand your preferences with regards to color palette.",
        title: "Understanding your taste",
        questions: [
          {
            type: "question",
            title: "Subtler or bright?",
            question: "Do you prefer subtler colors?",
            suggestions: ["Subtle is nice", "Bright colors"],
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for title tag
      const titleTag = event.tags.find((tag) => tag[0] === "title");
      expect(titleTag).toBeDefined();
      expect(titleTag?.[1]).toBe("Understanding your taste");
    });

    it("should create event with single question tag", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "Setting up testing framework.",
        title: "Testing Setup",
        questions: [
          {
            type: "question",
            title: "Framework",
            question: "What testing framework should I use?",
            suggestions: ["Vitest (Recommended)", "Jest", "Mocha"],
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for question tag
      const questionTag = event.tags.find((tag) => tag[0] === "question");
      expect(questionTag).toBeDefined();
      expect(questionTag).toEqual([
        "question",
        "Framework",
        "What testing framework should I use?",
        "Vitest (Recommended)",
        "Jest",
        "Mocha",
      ]);
    });

    it("should create event with multiselect tag", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "Need to understand mode preferences.",
        title: "Display Preferences",
        questions: [
          {
            type: "multiselect",
            title: "Dark mode?",
            question: "Do you need support for dark mode?",
            options: ["Dark mode", "Light mode"],
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for multiselect tag
      const multiselectTag = event.tags.find((tag) => tag[0] === "multiselect");
      expect(multiselectTag).toBeDefined();
      expect(multiselectTag).toEqual([
        "multiselect",
        "Dark mode?",
        "Do you need support for dark mode?",
        "Dark mode",
        "Light mode",
      ]);
    });

    it("should create event with multiple mixed question types", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "I want to understand your preferences with regards to color palette.",
        title: "Understanding your taste",
        questions: [
          {
            type: "question",
            title: "Subtler or bright?",
            question: "Do you prefer subtler colors?",
            suggestions: ["Subtle is nice", "Sometimes bright", "Only bright", "Make it orange"],
          },
          {
            type: "multiselect",
            title: "Dark mode?",
            question: "Do you need support for dark mode?",
            options: ["Dark mode", "Light mode"],
          },
          {
            type: "multiselect",
            title: "Borders?",
            question: "Do you like rounded borders?",
            options: ["Rounded", "Sharp", "Mixed"],
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check content is the context
      expect(event.content).toBe("I want to understand your preferences with regards to color palette.");

      // Check for title
      const titleTag = event.tags.find((tag) => tag[0] === "title");
      expect(titleTag?.[1]).toBe("Understanding your taste");

      // Check for question tags
      const questionTags = event.tags.filter((tag) => tag[0] === "question");
      expect(questionTags.length).toBe(1);
      expect(questionTags[0]).toEqual([
        "question",
        "Subtler or bright?",
        "Do you prefer subtler colors?",
        "Subtle is nice",
        "Sometimes bright",
        "Only bright",
        "Make it orange",
      ]);

      // Check for multiselect tags
      const multiselectTags = event.tags.filter((tag) => tag[0] === "multiselect");
      expect(multiselectTags.length).toBe(2);
      expect(multiselectTags[0]).toEqual([
        "multiselect",
        "Dark mode?",
        "Do you need support for dark mode?",
        "Dark mode",
        "Light mode",
      ]);
      expect(multiselectTags[1]).toEqual([
        "multiselect",
        "Borders?",
        "Do you like rounded borders?",
        "Rounded",
        "Sharp",
        "Mixed",
      ]);
    });

    it("should create event with question without suggestions (open-ended)", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "I need to understand your optimization priorities.",
        title: "Optimization Priorities",
        questions: [
          {
            type: "question",
            title: "Focus Area",
            question: "Which area should I prioritize for optimization?",
            // No suggestions - open-ended
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for question tag without suggestions
      const questionTag = event.tags.find((tag) => tag[0] === "question");
      expect(questionTag).toBeDefined();
      expect(questionTag).toEqual([
        "question",
        "Focus Area",
        "Which area should I prioritize for optimization?",
      ]);
    });

    it("should still include delegation tag", async () => {
      const context = createTestContext({
        conversationId: "parent-conversation-id-789",
      });

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "Need input on architecture.",
        title: "Architecture Decision",
        questions: [
          {
            type: "question",
            title: "Pattern",
            question: "Which pattern?",
            suggestions: ["Option A", "Option B"],
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for delegation tag
      const delegationTag = event.tags.find((tag) => tag[0] === "delegation");
      expect(delegationTag).toBeDefined();
      expect(delegationTag?.[1]).toBe("parent-conversation-id-789");
    });

    it("should include ask marker tag", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "recipient-pubkey",
        context: "Quick question.",
        title: "Question",
        questions: [
          {
            type: "question",
            title: "Choice",
            question: "Which one?",
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for ask marker
      const askTag = event.tags.find((tag) => tag[0] === "ask");
      expect(askTag).toBeDefined();
      expect(askTag?.[1]).toBe("true");
    });

    it("should include p-tag for recipient", async () => {
      const context = createTestContext();

      const config: AskConfig = {
        recipient: "specific-recipient-pubkey",
        context: "Question context.",
        title: "Title",
        questions: [
          {
            type: "question",
            title: "Q",
            question: "Question?",
          },
        ],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check for p-tag
      const pTag = event.tags.find((tag) => tag[0] === "p");
      expect(pTag).toBeDefined();
      expect(pTag?.[1]).toBe("specific-recipient-pubkey");
    });
  });

  describe("Backward compatibility with legacy format", () => {
    it("should still support legacy tldr/context/suggestions format", async () => {
      const context = createTestContext();

      // Legacy format (no questions array, uses tldr/context/suggestions)
      const config: AskConfig = {
        recipient: "recipient-pubkey",
        tldr: "Quick question",
        context: "Full context here",
        suggestions: ["Yes", "No"],
      };

      await publisher.ask(config, context);

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];

      // Check content format for legacy
      expect(event.content).toContain("Quick question");
      expect(event.content).toContain("Full context here");

      // Check for tldr tag (legacy)
      const tldrTag = event.tags.find((tag) => tag[0] === "tldr");
      expect(tldrTag).toBeDefined();
      expect(tldrTag?.[1]).toBe("Quick question");

      // Check for suggestion tags (legacy)
      const suggestionTags = event.tags.filter((tag) => tag[0] === "suggestion");
      expect(suggestionTags.length).toBe(2);
    });
  });
});

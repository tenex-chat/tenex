import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentEventEncoder } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { AskConfig } from "@/nostr/types";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "@/nostr/types";
import * as ndkClientModule from "@/nostr/ndkClient";
import * as traceContextModule from "@/nostr/trace-context";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

describe("Ask Tool - Multi-question support", () => {
  let capturedEvents: NDKEvent[] = [];
  let mockAgentInstance: AgentInstance;
  let publisher: AgentPublisher;
  let safePublishSpy: ReturnType<typeof spyOn>;
  let addStandardTagsSpy: ReturnType<typeof spyOn>;
  let injectTraceContextSpy: ReturnType<typeof spyOn>;
  let getNDKSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    capturedEvents = [];
    getNDKSpy = spyOn(ndkClientModule, "getNDK").mockReturnValue({} as never);
    addStandardTagsSpy = spyOn(AgentEventEncoder.prototype, "addStandardTags").mockImplementation(
      () => undefined
    );
    injectTraceContextSpy = spyOn(traceContextModule, "injectTraceContext").mockImplementation(
      () => undefined
    );

    mockAgentInstance = {
      slug: "test-agent",
      pubkey: "test-agent-pubkey",
      sign: mock((_event: NDKEvent) => Promise.resolve()),
      projectTag: "31933:testpubkey:test-project",
    } as unknown as AgentInstance;

    publisher = new AgentPublisher(mockAgentInstance);
    safePublishSpy = spyOn(publisher as any, "safePublish").mockImplementation(async (event: NDKEvent) => {
      capturedEvents.push(event);
    });
  });

  afterEach(() => {
    capturedEvents = [];
    getNDKSpy?.mockRestore();
    addStandardTagsSpy?.mockRestore();
    injectTraceContextSpy?.mockRestore();
    safePublishSpy?.mockRestore();
    mock.restore();
  });

  function createTestContext(overrides?: Partial<EventContext>): EventContext {
    const triggeringEnvelope = createMockInboundEnvelope({
      principal: {
        id: "triggering-pubkey",
        transport: "nostr",
        linkedPubkey: "triggering-pubkey",
        kind: "human",
      },
      message: {
        id: "triggering-event-id",
        transport: "nostr",
        nativeId: "triggering-event-id",
      },
    });

    return {
      conversationId: "parent-conversation-id",
      triggeringEnvelope,
      rootEvent: { id: "root-event-id" },
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

});

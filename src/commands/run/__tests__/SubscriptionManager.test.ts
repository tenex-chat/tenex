import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { EventHandler } from "@/event-handler";
import { EVENT_KINDS } from "@/llm/types";
import { SubscriptionManager } from "../SubscriptionManager";

// Mock NDK types
const mockStop = mock(() => {});
const mockStart = mock(() => {});
const mockSubscription = {
  stop: mockStop,
  start: mockStart,
  on: mock((_event: string, _handler: Function) => {}),
};

const mockSubscribe = mock(() => mockSubscription);
const mockFetchOne = mock(async () => null);

const mockNDK = {
  subscribe: mockSubscribe,
  fetchOne: mockFetchOne,
};

const mockGetNDK = mock(() => mockNDK);
mock.module("@/nostr/ndkClient", () => ({
  getNDK: mockGetNDK,
}));

// Mock project context
const mockProjectContext = {
  project: {
    id: "test-project",
    naddr: "naddr1test",
    pubkey: "project-pubkey",
  },
  signer: { id: "test-signer" },
  agents: new Map([
    ["agent1", { pubkey: "agent1-pubkey", name: "Agent 1" }],
    ["agent2", { pubkey: "agent2-pubkey", name: "Agent 2" }],
  ]),
};

const mockGetProjectContext = mock(() => mockProjectContext);
mock.module("@/services", () => ({
  getProjectContext: mockGetProjectContext,
}));

// Mock event tracking
const mockLoadProcessedEvents = mock(async () => {});
const mockAddProcessedEvent = mock(() => {});
const mockHasProcessedEvent = mock(() => false);
const mockFlushProcessedEvents = mock(async () => {});
const mockClearProcessedEvents = mock(() => {});

mock.module("@/commands/run/processedEventTracking", () => ({
  loadProcessedEvents: mockLoadProcessedEvents,
  addProcessedEvent: mockAddProcessedEvent,
  hasProcessedEvent: mockHasProcessedEvent,
  flushProcessedEvents: mockFlushProcessedEvents,
  clearProcessedEvents: mockClearProcessedEvents,
}));

// Mock NDKAgentLesson
const mockNDKAgentLesson = {
  from: mock((_event: any) => ({
    timestamp: new Date(),
    text: "Test lesson",
    projectNaddr: "naddr1test",
    agentPubkey: "agent1-pubkey",
  })),
};

mock.module("@/events/NDKAgentLesson", () => ({
  NDKAgentLesson: mockNDKAgentLesson,
}));

// Mock filterAndRelaySetFromBech32
mock.module("@nostr-dev-kit/ndk", () => ({
  filterAndRelaySetFromBech32: mock(() => ({
    filter: { "#a": ["test-project"] },
    relaySet: null,
  })),
}));

describe("SubscriptionManager", () => {
  let subscriptionManager: SubscriptionManager;
  let mockEventHandler: EventHandler;

  beforeEach(() => {
    // Create mock event handler
    mockEventHandler = {
      handleTextNoteEvent: mock(async () => {}),
      handleUnknownEvent: mock(async () => {}),
    } as any as EventHandler;

    subscriptionManager = new SubscriptionManager(mockEventHandler, "/test/project");

    // Clear all mocks
    mockSubscribe.mockClear();
    mockStop.mockClear();
    mockStart.mockClear();
    mockLoadProcessedEvents.mockClear();
    mockFetchOne.mockClear();
  });

  afterEach(() => {
    // Cleanup subscriptions
    subscriptionManager.stop();
  });

  describe("start", () => {
    it("should load processed events on start", async () => {
      await subscriptionManager.start();
      expect(mockLoadProcessedEvents).toHaveBeenCalledWith("/test/project");
    });

    it("should create subscriptions for project updates", async () => {
      await subscriptionManager.start();

      // Should create subscription for project updates
      const projectUpdateCall = mockSubscribe.mock.calls.find((call) =>
        call[0].kinds?.includes(EVENT_KINDS.PROJECT_UPDATE)
      );
      expect(projectUpdateCall).toBeDefined();
    });

    it("should create subscriptions for agent lessons", async () => {
      await subscriptionManager.start();

      // Should create subscription for agent lessons
      const lessonCall = mockSubscribe.mock.calls.find((call) =>
        call[0].kinds?.includes(EVENT_KINDS.LESSON)
      );
      expect(lessonCall).toBeDefined();
    });

    it("should create subscriptions for project events", async () => {
      await subscriptionManager.start();

      // Should create subscription for text notes
      const textNoteCall = mockSubscribe.mock.calls.find((call) =>
        call[0].kinds?.includes(EVENT_KINDS.TEXT_NOTE)
      );
      expect(textNoteCall).toBeDefined();
    });

    it("should start all subscriptions", async () => {
      await subscriptionManager.start();

      // Each subscription should be started
      expect(mockStart.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("stop", () => {
    it("should stop all subscriptions", async () => {
      await subscriptionManager.start();
      const initialStopCalls = mockStop.mock.calls.length;

      subscriptionManager.stop();

      // Should have stopped all subscriptions
      expect(mockStop.mock.calls.length).toBeGreaterThan(initialStopCalls);
    });

    it("should flush processed events", async () => {
      await subscriptionManager.start();
      await subscriptionManager.stop();

      expect(mockFlushProcessedEvents).toHaveBeenCalledWith("/test/project");
    });

    it("should handle multiple stop calls gracefully", async () => {
      await subscriptionManager.start();

      expect(() => {
        subscriptionManager.stop();
        subscriptionManager.stop();
      }).not.toThrow();
    });
  });

  describe("event handling", () => {
    it("should handle project update events", async () => {
      await subscriptionManager.start();

      // Find the project update subscription
      const projectUpdateSub = mockSubscribe.mock.calls.find((call) =>
        call[0].kinds?.includes(EVENT_KINDS.PROJECT_UPDATE)
      );

      expect(projectUpdateSub).toBeDefined();

      // Simulate receiving a project update event
      const eventHandler = mockSubscription.on.mock.calls.find((call) => call[0] === "event")?.[1];

      if (eventHandler) {
        const mockEvent = {
          id: "event1",
          kind: EVENT_KINDS.PROJECT_UPDATE,
          content: "Updated project",
        };

        await eventHandler(mockEvent);

        // Should mark event as processed
        expect(mockAddProcessedEvent).toHaveBeenCalledWith("event1");
      }
    });

    it("should skip already processed events", async () => {
      mockHasProcessedEvent.mockReturnValueOnce(true);

      await subscriptionManager.start();

      // Find event handler
      const eventHandler = mockSubscription.on.mock.calls.find((call) => call[0] === "event")?.[1];

      if (eventHandler) {
        const mockEvent = {
          id: "event1",
          kind: EVENT_KINDS.TEXT_NOTE,
          content: "Test message",
        };

        await eventHandler(mockEvent);

        // Should not process the event
        expect(mockEventHandler.handleTextNoteEvent).not.toHaveBeenCalled();
      }
    });

    it("should handle text note events", async () => {
      await subscriptionManager.start();

      // Find the text note subscription handler
      const eventHandler = mockSubscription.on.mock.calls.find((call) => call[0] === "event")?.[1];

      if (eventHandler) {
        const mockEvent = {
          id: "event2",
          kind: EVENT_KINDS.TEXT_NOTE,
          content: "Test message",
          pubkey: "user-pubkey",
        };

        await eventHandler(mockEvent);

        // Should process the text note
        expect(mockEventHandler.handleTextNoteEvent).toHaveBeenCalledWith(mockEvent);
        expect(mockAddProcessedEvent).toHaveBeenCalledWith("event2");
      }
    });

    it("should handle unknown event kinds", async () => {
      await subscriptionManager.start();

      // Find event handler
      const eventHandler = mockSubscription.on.mock.calls.find((call) => call[0] === "event")?.[1];

      if (eventHandler) {
        const mockEvent = {
          id: "event3",
          kind: 99999, // Unknown kind
          content: "Unknown event",
        };

        await eventHandler(mockEvent);

        // Should call unknown event handler
        expect(mockEventHandler.handleUnknownEvent).toHaveBeenCalledWith(mockEvent);
      }
    });
  });

  describe("error handling", () => {
    it("should handle subscription errors gracefully", async () => {
      mockSubscribe.mockImplementationOnce(() => {
        throw new Error("Subscription failed");
      });

      // Should not throw
      await expect(subscriptionManager.start()).resolves.not.toThrow();
    });

    it("should handle event processing errors", async () => {
      mockEventHandler.handleTextNoteEvent = mock(async () => {
        throw new Error("Processing failed");
      });

      await subscriptionManager.start();

      const eventHandler = mockSubscription.on.mock.calls.find((call) => call[0] === "event")?.[1];

      if (eventHandler) {
        const mockEvent = {
          id: "event4",
          kind: EVENT_KINDS.TEXT_NOTE,
          content: "Test",
        };

        // Should not throw
        await expect(eventHandler(mockEvent)).resolves.not.toThrow();
      }
    });
  });
});

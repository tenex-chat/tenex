import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NDKKind } from "@/nostr/kinds";
import { StatusPublisher } from "../StatusPublisher";


// Mock dependencies
const mockPublish = mock(async () => {});
const mockSign = mock(async () => {});
const mockNDKEvent = mock((_ndk: unknown) => ({
  kind: undefined as number | undefined,
  content: "",
  tags: [] as Array<string[]>,
  tag: mock((_project: unknown) => {}),
  sign: mockSign,
  publish: mockPublish,
}));

mock.module("@nostr-dev-kit/ndk", () => ({
  NDKEvent: mockNDKEvent,
}));

const mockGetNDK = mock(() => ({}));
mock.module("@/nostr/ndkClient", () => ({
  getNDK: mockGetNDK,
}));

const mockProjectContext = {
  project: { id: "test-project" },
  signer: { id: "test-signer" },
  agents: new Map([
    ["agent1", { pubkey: "pubkey1", name: "Agent 1" }],
    ["agent2", { pubkey: "pubkey2", name: "Agent 2" }],
  ]),
};

const mockGetProjectContext = mock(() => mockProjectContext);
const mockIsProjectContextInitialized = mock(() => true);

mock.module("@/services", () => ({
  getProjectContext: mockGetProjectContext,
  isProjectContextInitialized: mockIsProjectContextInitialized,
  configService: {
    loadConfig: mock(async () => ({
      llms: {
        configurations: {
          config1: { model: "gpt-4", provider: "openai" },
          config2: { model: "claude-3", provider: "anthropic" },
        },
        defaults: {
          agent1: "config1",
          agent2: "config2",
        },
      },
    })),
  },
}));

describe("StatusPublisher", () => {
  let publisher: StatusPublisher;

  beforeEach(() => {
    publisher = new StatusPublisher();
    // Clear all mock calls
    mockPublish.mockClear();
    mockSign.mockClear();
    mockNDKEvent.mockClear();
  });

  afterEach(() => {
    // Clean up any intervals
    publisher.stopPublishing();
  });

  describe("startPublishing", () => {
    it("should publish an initial status event", async () => {
      await publisher.startPublishing("/test/project");

      // Verify NDKEvent was created and configured
      expect(mockNDKEvent).toHaveBeenCalledTimes(1);
      expect(mockSign).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("should set up interval for periodic publishing", async () => {
      // Use fake timers for deterministic testing
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let intervalCallback: Function | null = null;
      const intervalId = 123;

      globalThis.setInterval = ((callback: Function, _ms: number) => {
        intervalCallback = callback;
        return intervalId;
      }) as any;

      globalThis.clearInterval = ((id: number) => {
        if (id === intervalId) {
          intervalCallback = null;
        }
      }) as any;

      try {
        await publisher.startPublishing("/test/project");

        // Initial call
        expect(mockPublish).toHaveBeenCalledTimes(1);

        // Verify interval was set up
        expect(intervalCallback).toBeTruthy();

        // Manually trigger the interval callback
        if (intervalCallback) {
          await intervalCallback();
          expect(mockPublish).toHaveBeenCalledTimes(2);
        }

        publisher.stopPublishing();

        // Verify interval was cleared
        expect(intervalCallback).toBeNull();
      } finally {
        // Restore original timer functions
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });
  });

  describe("stopPublishing", () => {
    it("should clear the interval when called", async () => {
      // Use fake timers for deterministic testing
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let intervalCallback: Function | null = null;
      const intervalId = 456;

      globalThis.setInterval = ((callback: Function, _ms: number) => {
        intervalCallback = callback;
        return intervalId;
      }) as any;

      globalThis.clearInterval = ((id: number) => {
        if (id === intervalId) {
          intervalCallback = null;
        }
      }) as any;

      try {
        await publisher.startPublishing("/test/project");

        // Initial call
        expect(mockPublish).toHaveBeenCalledTimes(1);
        expect(intervalCallback).toBeTruthy();

        publisher.stopPublishing();

        // Verify interval was cleared
        expect(intervalCallback).toBeNull();

        // Even if we tried to call it, nothing should happen
        // since the interval was cleared
        expect(mockPublish).toHaveBeenCalledTimes(1);
      } finally {
        // Restore original timer functions
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });

    it("should handle being called multiple times", () => {
      expect(() => {
        publisher.stopPublishing();
        publisher.stopPublishing();
      }).not.toThrow();
    });
  });

  describe("publishStatusEvent", () => {
    it("should include agent pubkeys in tags", async () => {
      await publisher.startPublishing("/test/project");

      const eventInstance = mockNDKEvent.mock.results[0].value;

      // Check that agent tags were added
      const agentTags = eventInstance.tags.filter((tag: string[]) => tag[0] === "agent");
      expect(agentTags).toHaveLength(2);
      expect(agentTags).toContainEqual(["agent", "pubkey1", "agent1"]);
      expect(agentTags).toContainEqual(["agent", "pubkey2", "agent2"]);
    });

    it("should include model configurations in tags", async () => {
      await publisher.startPublishing("/test/project");

      const eventInstance = mockNDKEvent.mock.results[0].value;

      // Check that model tags were added in new format: ["model", "model-slug", ...agent-slugs]
      const modelTags = eventInstance.tags.filter((tag: string[]) => tag[0] === "model");
      expect(modelTags.length).toBeGreaterThan(0);

      // Should have model tags with agents that use them
      expect(modelTags).toContainEqual(["model", "gpt-4", "agent1"]);
      expect(modelTags).toContainEqual(["model", "claude-3", "agent2"]);
    });

    it("should set correct event kind", async () => {
      await publisher.startPublishing("/test/project");

      const eventInstance = mockNDKEvent.mock.results[0].value;
      expect(eventInstance.kind).toBe(NDKKind.TenexProjectStatus);
    });

    it("should handle errors gracefully", async () => {
      // Make publish throw an error
      mockPublish.mockImplementationOnce(async () => {
        throw new Error("Publishing failed");
      });

      // Should not throw - startPublishing doesn't throw, it logs errors
      await publisher.startPublishing("/test/project");

      // Verify it tried to publish but handled the error
      expect(mockPublish).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should continue publishing even if project context is not initialized", async () => {
      mockIsProjectContextInitialized.mockReturnValueOnce(false);

      // Should not throw - just logs warning
      await publisher.startPublishing("/test/project");
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("should handle missing LLM configuration gracefully", async () => {
      const { configService } = await import("@/services");
      configService.loadConfig = mock(async () => ({ llms: undefined }));

      // Should not throw - handles undefined config gracefully
      await publisher.startPublishing("/test/project");
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });
});

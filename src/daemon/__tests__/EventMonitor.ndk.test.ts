/**
 * EventMonitor tests using NDK test utilities
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { 
  TENEXTestFixture,
  withTestEnvironment,
  RelayMock,
  getTestUserWithSigner 
} from "@/test-utils/ndk-test-helpers";
import { EventMonitor } from "../EventMonitor";
import type { IProcessManager } from "../ProcessManager";
import type { IProjectManager } from "../ProjectManager";
import { NDKKind } from "@nostr-dev-kit/ndk";
import { EVENT_KINDS } from "@/llm/types";

// Mock nostr-tools at module level
mock.module("nostr-tools", () => ({
  nip19: {
    naddrEncode: () => "naddr1test123",
  },
}));

// Extend EventMonitor to expose private method for testing
class TestableEventMonitor extends EventMonitor {
  public async testHandleEvent(event: any): Promise<void> {
    return (this as any).handleEvent(event);
  }
}

describe("EventMonitor with NDK utilities", () => {
  let eventMonitor: TestableEventMonitor;
  let mockProjectManager: IProjectManager;
  let mockProcessManager: IProcessManager;

  beforeEach(() => {
    // Create mock implementations
    mockProjectManager = {
      ensureProjectExists: mock(() => Promise.resolve("/test/project/path")),
      getProjectPath: mock(() => "/test/project/path"),
      updateProject: mock(() => Promise.resolve()),
    };

    mockProcessManager = {
      spawnProjectRun: mock(() => Promise.resolve()),
      isProjectRunning: mock(() => Promise.resolve(false)),
      stopProject: mock(() => Promise.resolve()),
      stopAll: mock(() => Promise.resolve()),
    };

    eventMonitor = new TestableEventMonitor(mockProjectManager, mockProcessManager);
  });

  afterEach(() => {
    mock.restore();
  });

  describe("event monitoring with real subscriptions", () => {
    it("should monitor and handle events from whitelisted users", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup whitelisted users
        const alice = await fixture.getUser("alice");
        const bob = await fixture.getUser("bob");
        const whitelistedPubkeys = [alice.pubkey, bob.pubkey];

        // Mock getNDK to return fixture NDK
        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        // Create mock relay
        const relay = fixture.createMockRelay("wss://monitor.relay");
        await relay.connect();

        // Start monitoring
        await eventMonitor.start(whitelistedPubkeys);

        // Create events from whitelisted users
        const aliceEvent = await fixture.eventFactory.createSignedTextNote(
          "Message from Alice",
          "alice"
        );
        aliceEvent.tags.push(["a", "31933:project-pubkey:test-project"]);

        const bobEvent = await fixture.eventFactory.createSignedTextNote(
          "Message from Bob",
          "bob"
        );
        bobEvent.tags.push(["a", "31933:project-pubkey:test-project"]);

        // Simulate receiving events
        await relay.simulateEvent(aliceEvent);
        await relay.simulateEvent(bobEvent);

        // Wait for event processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify project manager was called for both events
        expect(mockProjectManager.ensureProjectExists).toHaveBeenCalledTimes(2);
        expect(mockProcessManager.spawnProjectRun).toHaveBeenCalledTimes(2);
      });
    });

    it("should ignore events from non-whitelisted users", async () => {
      await withTestEnvironment(async (fixture) => {
        const alice = await fixture.getUser("alice");
        const whitelistedPubkeys = [alice.pubkey];

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://filter.relay");
        await relay.connect();

        await eventMonitor.start(whitelistedPubkeys);

        // Create event from non-whitelisted user
        const eveEvent = await fixture.eventFactory.createSignedTextNote(
          "Message from Eve (not whitelisted)",
          "eve"
        );
        eveEvent.tags.push(["a", "31933:project-pubkey:test-project"]);

        // Simulate receiving event
        await relay.simulateEvent(eveEvent);

        // Wait for potential processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify project manager was NOT called
        expect(mockProjectManager.ensureProjectExists).not.toHaveBeenCalled();
        expect(mockProcessManager.spawnProjectRun).not.toHaveBeenCalled();
      });
    });

    it("should handle task events properly", async () => {
      await withTestEnvironment(async (fixture) => {
        const alice = await fixture.getUser("alice");
        const whitelistedPubkeys = [alice.pubkey];

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://task.relay");
        await relay.connect();

        await eventMonitor.start(whitelistedPubkeys);

        // Create task event
        const taskEvent = await fixture.eventFactory.createSignedTextNote(
          "Complete this task",
          "alice",
          EVENT_KINDS.TASK
        );
        taskEvent.tags.push(
          ["a", "31933:project-pubkey:test-project"],
          ["d", "task-001"],
          ["title", "Important Task"]
        );

        // Simulate receiving task
        await relay.simulateEvent(taskEvent);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify task was processed
        expect(mockProjectManager.ensureProjectExists).toHaveBeenCalled();
        expect(mockProcessManager.spawnProjectRun).toHaveBeenCalled();
      });
    });

    it("should handle relay disconnections gracefully", async () => {
      await withTestEnvironment(async (fixture) => {
        const alice = await fixture.getUser("alice");
        const whitelistedPubkeys = [alice.pubkey];

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        // Create unstable relay
        const unstableRelay = fixture.createMockRelay("wss://unstable.relay", {
          simulateDisconnect: true,
          disconnectAfter: 500
        });

        await eventMonitor.start(whitelistedPubkeys);

        // Create event before disconnect
        const event = await fixture.eventFactory.createSignedTextNote(
          "Message before disconnect",
          "alice"
        );
        event.tags.push(["a", "31933:project-pubkey:test-project"]);

        // Publish before disconnect
        await unstableRelay.publish(event);
        await unstableRelay.simulateEvent(event);

        // Wait for disconnect
        await new Promise(resolve => setTimeout(resolve, 600));

        // Relay should be disconnected
        expect(unstableRelay.status).toBe(1); // DISCONNECTED

        // EventMonitor should still be running
        expect(eventMonitor.isRunning()).toBe(true);
      });
    });

    it("should handle EOSE correctly", async () => {
      await withTestEnvironment(async (fixture) => {
        const alice = await fixture.getUser("alice");
        const bob = await fixture.getUser("bob");
        const whitelistedPubkeys = [alice.pubkey, bob.pubkey];

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://eose.relay");
        await relay.connect();

        // Store subscription ID when created
        let subId: string | undefined;
        const originalSubscribe = relay.subscribe.bind(relay);
        relay.subscribe = function(subscription: any, filters: any) {
          subId = subscription.subId || "test-sub";
          return originalSubscribe(subscription, filters);
        };

        await eventMonitor.start(whitelistedPubkeys);

        // Create batch of events
        const events = await Promise.all([
          fixture.eventFactory.createSignedTextNote("Message 1", "alice"),
          fixture.eventFactory.createSignedTextNote("Message 2", "bob"),
          fixture.eventFactory.createSignedTextNote("Message 3", "alice"),
        ]);

        // Add project tags
        events.forEach(event => {
          event.tags.push(["a", "31933:project-pubkey:test-project"]);
        });

        // Simulate receiving all events
        for (const event of events) {
          await relay.simulateEvent(event, subId);
        }

        // Simulate EOSE
        if (subId) {
          relay.simulateEOSE(subId);
        }

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // All events should have been processed
        expect(mockProjectManager.ensureProjectExists).toHaveBeenCalledTimes(3);
        expect(mockProcessManager.spawnProjectRun).toHaveBeenCalledTimes(3);
      });
    });

    it("should handle concurrent events from multiple users", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup multiple users
        const users = await Promise.all([
          fixture.getUser("alice"),
          fixture.getUser("bob"),
          fixture.getUser("carol"),
          fixture.getUser("dave"),
        ]);
        const whitelistedPubkeys = users.map(u => u.pubkey);

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://concurrent.relay");
        await relay.connect();

        await eventMonitor.start(whitelistedPubkeys);

        // Create conversation thread
        const conversation = await fixture.createConversationThread(
          { author: "alice", content: "Starting a group discussion" },
          [
            { author: "bob", content: "I'll help with that" },
            { author: "carol", content: "Count me in" },
            { author: "dave", content: "Let's begin" },
          ]
        );

        // Add project tags to all events
        conversation.forEach(event => {
          event.tags.push(["a", "31933:project-pubkey:test-project"]);
        });

        // Simulate receiving all events concurrently
        await Promise.all(
          conversation.map(event => relay.simulateEvent(event))
        );

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 200));

        // All events should have been processed
        expect(mockProjectManager.ensureProjectExists).toHaveBeenCalledTimes(4);
        expect(mockProcessManager.spawnProjectRun).toHaveBeenCalledTimes(4);
      });
    });
  });

  describe("stop functionality", () => {
    it("should stop monitoring when requested", async () => {
      await withTestEnvironment(async (fixture) => {
        const alice = await fixture.getUser("alice");
        const whitelistedPubkeys = [alice.pubkey];

        mock.module("@/nostr/ndkClient", () => ({
          getNDK: () => fixture.ndk,
        }));

        const relay = fixture.createMockRelay("wss://stop.relay");
        await relay.connect();

        // Start monitoring
        await eventMonitor.start(whitelistedPubkeys);
        expect(eventMonitor.isRunning()).toBe(true);

        // Stop monitoring
        eventMonitor.stop();
        expect(eventMonitor.isRunning()).toBe(false);

        // Create event after stopping
        const event = await fixture.eventFactory.createSignedTextNote(
          "Message after stop",
          "alice"
        );
        event.tags.push(["a", "31933:project-pubkey:test-project"]);

        // Simulate receiving event
        await relay.simulateEvent(event);

        // Wait for potential processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Event should NOT have been processed
        expect(mockProjectManager.ensureProjectExists).not.toHaveBeenCalled();
      });
    });
  });
});
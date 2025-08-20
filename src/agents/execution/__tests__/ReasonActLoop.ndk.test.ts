/**
 * Comprehensive test demonstrating NDK test utilities
 * for ReasonActLoop agent execution
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
  TENEXTestFixture,
  withTestEnvironment,
  RelayMock,
  type TestUserName
} from "@/test-utils/ndk-test-helpers";
import { ReasonActLoop } from "../ReasonActLoop";
import type { AgentInstance } from "@/agents/types";
import { NDKKind } from "@nostr-dev-kit/ndk";

describe("ReasonActLoop with NDK Test Utilities", () => {
  describe("Agent Communication", () => {
    it("should handle multi-agent conversation threads", async () => {
      await withTestEnvironment(async (fixture, timeControl) => {
        // Create a conversation between user and multiple agents
        const conversation = await fixture.createConversationThread(
          { author: "alice", content: "I need help analyzing this data" },
          [
            { author: "bob", content: "I can help with statistical analysis", isAgent: true },
            { author: "carol", content: "I'll handle the visualization", isAgent: true },
            { author: "alice", content: "Great! Let's start with basic stats" },
            { author: "bob", content: "Running analysis now...", isAgent: true }
          ]
        );

        expect(conversation).toHaveLength(5);
        expect(conversation[0].pubkey).toBe(await fixture.getUser("alice").then(u => u.pubkey));
        expect(conversation[1].tags).toContainEqual(expect.arrayContaining(["e", conversation[0].id]));
        expect(conversation[4].content).toBe("Running analysis now...");
      });
    });

    it("should properly sign and verify agent events", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create an agent event with proper signing
        const agentEvent = await fixture.createAgentEvent(
          "alice",
          "Processing request",
          8000,
          [
            ["status", "processing"],
            ["confidence", "0.95"],
            ["model", "gpt-4"]
          ]
        );

        expect(agentEvent.sig).toBeDefined();
        expect(agentEvent.pubkey).toBe(await fixture.getUser("alice").then(u => u.pubkey));
        expect(agentEvent.tagValue("status")).toBe("processing");
        expect(agentEvent.tagValue("confidence")).toBe("0.95");
      });
    });
  });

  describe("Relay Interactions", () => {
    let fixture: TENEXTestFixture;
    let mockRelay: RelayMock;

    beforeEach(() => {
      fixture = new TENEXTestFixture();
      mockRelay = fixture.createMockRelay("wss://test.relay", {
        autoConnect: true,
        connectionDelay: 100
      });
    });

    afterEach(() => {
      fixture.cleanup();
    });

    it("should handle relay disconnections gracefully", async () => {
      // Create relay with simulated disconnect
      const unstableRelay = fixture.createMockRelay("wss://unstable.relay", {
        simulateDisconnect: true,
        disconnectAfter: 500,
        autoConnect: true
      });

      // Create and publish an event
      const event = await fixture.eventFactory.createSignedTextNote(
        "Test message",
        "dave"
      );

      // Simulate publishing
      const published = await unstableRelay.publish(event);
      expect(published).toBe(true);

      // Wait for disconnect
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(unstableRelay.status).toBe(1); // NDKRelayStatus.DISCONNECTED

      // Verify message was logged before disconnect
      expect(unstableRelay.messageLog).toContainEqual(
        expect.objectContaining({
          direction: "out",
          message: expect.stringContaining("EVENT")
        })
      );
    });

    it("should track relay event validation", async () => {
      const event = await fixture.eventFactory.createSignedTextNote(
        "Validated event",
        "eve"
      );

      // Simulate receiving and validating event
      mockRelay.addValidatedEvent();
      await mockRelay.simulateEvent(event);
      
      expect(mockRelay.validatedEvents).toBe(1);
      expect(mockRelay.nonValidatedEvents).toBe(0);

      // Simulate non-validated event
      mockRelay.addNonValidatedEvent();
      expect(mockRelay.nonValidatedEvents).toBe(1);
    });

    it("should handle subscription lifecycle", async () => {
      // Setup subscription
      fixture.setupSigner("alice");
      
      // Ensure relay is connected first
      await mockRelay.connect();
      
      // Create mock subscription
      const subscription = {
        subId: "test-sub-123",
        eventReceived: (event: any, relay: any) => {
          // Handle event
        },
        eoseReceived: (relay: any) => {
          // Handle EOSE
        }
      } as any;

      // Subscribe with filters
      const filters = [
        { kinds: [NDKKind.Text], authors: [await fixture.getUser("alice").then(u => u.pubkey)] }
      ];
      
      mockRelay.subscribe(subscription, filters);

      // Verify REQ message was sent
      const reqMessage = mockRelay.messageLog.find(
        log => log.direction === "out" && log.message.includes("REQ")
      );
      expect(reqMessage).toBeDefined();
      expect(reqMessage?.message).toContain("test-sub-123");

      // Simulate EOSE
      mockRelay.simulateEOSE("test-sub-123");
      
      // Verify EOSE was received
      const eoseMessage = mockRelay.messageLog.find(
        log => log.direction === "in" && log.message.includes("EOSE")
      );
      expect(eoseMessage).toBeDefined();
    });
  });

  describe("Complex Agent Scenarios", () => {
    it("should handle agent delegation chain", async () => {
      await withTestEnvironment(async (fixture, timeControl) => {
        // Create initial task
        const taskEvent = await fixture.eventFactory.createSignedTextNote(
          "Analyze and summarize this document",
          "alice",
          7000 // Task kind
        );
        taskEvent.tags.push(["d", "task-001"]);

        // Agent Bob accepts the task
        const acceptanceEvent = await fixture.createAgentEvent(
          "bob",
          "Task accepted. Delegating parsing to specialized agent.",
          8001,
          [
            ["e", taskEvent.id || "", "", "accepting"],
            ["status", "delegation"],
            ["delegated-to", await fixture.getUser("carol").then(u => u.pubkey)]
          ]
        );

        // Agent Carol performs the delegated work
        const workEvent = await fixture.createAgentEvent(
          "carol",
          "Document parsed. 1500 words, 3 sections identified.",
          8001,
          [
            ["e", acceptanceEvent.id || "", "", "reply"],
            ["status", "completed"],
            ["metrics", JSON.stringify({ words: 1500, sections: 3 })]
          ]
        );

        // Agent Bob completes the main task
        const completionEvent = await fixture.createAgentEvent(
          "bob",
          "Summary: The document discusses...",
          8002,
          [
            ["e", taskEvent.id || "", "", "completed"],
            ["summary", "Document successfully analyzed"],
            ["execution-time", "3500"]
          ]
        );

        // Simulate relay interactions
        const relay = fixture.getMockRelay();
        await fixture.simulateRelayInteraction(taskEvent);
        await fixture.simulateRelayInteraction(acceptanceEvent);
        await fixture.simulateRelayInteraction(workEvent);
        await fixture.simulateRelayInteraction(completionEvent);

        // Verify the delegation chain
        expect(acceptanceEvent.tagValue("status")).toBe("delegation");
        expect(workEvent.tagValue("status")).toBe("completed");
        expect(completionEvent.tags).toContainEqual(
          expect.arrayContaining(["e", taskEvent.id, "", "completed"])
        );

        // Verify all events were published
        expect(relay.messageLog.filter(log => log.direction === "out")).toHaveLength(4);
      });
    });

    it("should handle time-sensitive agent operations", async () => {
      await withTestEnvironment(async (fixture, timeControl) => {
        let currentTime = Date.now();
        
        // Create time-sensitive task
        const urgentTask = await fixture.eventFactory.createSignedTextNote(
          "URGENT: Process this within 5 seconds",
          "alice",
          7000
        );
        urgentTask.tags.push(
          ["deadline", String(currentTime + 5000)],
          ["priority", "high"]
        );

        // Advance time by 2 seconds
        timeControl.advance(2000);
        
        // Agent responds within deadline
        const response = await fixture.createAgentEvent(
          "bob",
          "Processing urgent request",
          8001,
          [
            ["e", urgentTask.id || "", "", "processing"],
            ["timestamp", String(currentTime + 2000)]
          ]
        );

        // Advance time past deadline
        timeControl.advance(4000);
        
        // Agent completes after deadline
        const lateCompletion = await fixture.createAgentEvent(
          "bob",
          "Task completed (late)",
          8002,
          [
            ["e", urgentTask.id || "", "", "completed"],
            ["timestamp", String(currentTime + 6000)],
            ["deadline-missed", "true"]
          ]
        );

        expect(response.tagValue("timestamp")).toBe(String(currentTime + 2000));
        expect(lateCompletion.tagValue("deadline-missed")).toBe("true");
      });
    });
  });

  describe("Error Scenarios", () => {
    it("should handle relay publish failures", async () => {
      await withTestEnvironment(async (fixture) => {
        const failingRelay = fixture.createMockRelay("wss://failing.relay", {
          failNextPublish: true
        });

        const event = await fixture.eventFactory.createSignedTextNote(
          "This will fail to publish",
          "alice"
        );

        const result = await failingRelay.publish(event);
        expect(result).toBe(false);

        // Second publish should succeed (flag is reset)
        const secondEvent = await fixture.eventFactory.createSignedTextNote(
          "This should publish",
          "bob"
        );
        const secondResult = await failingRelay.publish(secondEvent);
        expect(secondResult).toBe(true);
      });
    });

    it("should handle connection delays", async () => {
      await withTestEnvironment(async (fixture) => {
        const slowRelay = fixture.createMockRelay("wss://slow.relay", {
          connectionDelay: 500,
          autoConnect: false
        });

        expect(slowRelay.status).toBe(1); // DISCONNECTED

        const connectPromise = slowRelay.connect();
        expect(slowRelay.status).toBe(0); // CONNECTING

        await connectPromise;
        expect(slowRelay.status).toBe(3); // CONNECTED
      });
    });
  });
});
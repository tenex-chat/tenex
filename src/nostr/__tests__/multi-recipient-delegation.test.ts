import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent, NDKSigner } from "@nostr-dev-kit/ndk";
import { AgentEventEncoder } from "../AgentEventEncoder";
import { AgentPublisher } from "../AgentPublisher";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";

// Mock NDK
mock.module("../ndkClient", () => ({
  getNDK: () => ({
    // Mock NDK instance
  }),
}));

// Mock logger
mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  },
}));

describe("Multi-Recipient Delegation", () => {
  let encoder: AgentEventEncoder;
  let publisher: AgentPublisher;
  let mockAgent: AgentInstance;
  let mockConversationCoordinator: ConversationCoordinator;
  let mockSigner: NDKSigner;

  beforeEach(async () => {
    // Initialize registry
    await DelegationRegistry.initialize();
    
    // Create mock signer
    mockSigner = {
      sign: mock(async (event: NDKEvent) => {
        event.id = `event-${Math.random().toString(36).substring(7)}`;
        event.sig = "mock-signature";
        return event.sig;
      }),
      pubkey: mock(() => "delegating-agent-pubkey"),
    } as any;
    
    // Create mock agent
    mockAgent = {
      name: "Test Agent",
      slug: "test-agent",
      pubkey: "delegating-agent-pubkey",
      signer: mockSigner,
      conversationId: "conv-123",
    } as any;

    // Create mock conversation coordinator
    mockConversationCoordinator = {
      getConversation: mock(() => ({
        id: "conv-123",
        history: [],
        phase: "execute",
      })),
    } as any;

    // Create instances
    encoder = new AgentEventEncoder(mockAgent);
    publisher = new AgentPublisher(mockAgent, mockConversationCoordinator);
  });

  describe("Event Creation", () => {
    it("should create a single event with multiple p-tags", () => {
      const intent = {
        type: "delegation" as const,
        recipients: ["recipient1-pubkey", "recipient2-pubkey", "recipient3-pubkey"],
        request: "Analyze this code and provide feedback",
        phase: "execute",
      };

      const mockTriggeringEvent = {
        id: "trigger-event",
        kind: 1111,
        pubkey: "user-pubkey",
        tagValue: (tag: string) => tag === "e" ? "root-event" : undefined,
        tags: [],
      } as any;

      const mockRootEvent = {
        id: "root-event",
        kind: 11,
        pubkey: "user-pubkey",
        tags: [],
      } as any;

      const context = {
        triggeringEvent: mockTriggeringEvent,
        rootEvent: mockRootEvent,
        conversationId: "conv-123",
      };

      const events = encoder.encodeDelegation(intent, context);

      // Should create only one event
      expect(events.length).toBe(1);

      const event = events[0];
      
      // Check that all recipients are p-tagged
      const pTags = event.tags.filter(tag => tag[0] === "p");
      expect(pTags.length).toBe(3);
      expect(pTags).toEqual([
        ["p", "recipient1-pubkey"],
        ["p", "recipient2-pubkey"],
        ["p", "recipient3-pubkey"],
      ]);

      
      // Check tool tag
      const toolTag = event.tags.find(tag => tag[0] === "tool");
      expect(toolTag).toEqual(["tool", "delegate"]);
    });

    it("should handle single recipient delegation", () => {
      const intent = {
        type: "delegation" as const,
        recipients: ["single-recipient-pubkey"],
        request: "Do this one thing",
        phase: "execute",
      };

      const mockTriggeringEvent = {
        id: "trigger-event",
        kind: 1111,
        pubkey: "user-pubkey",
        tagValue: (tag: string) => tag === "e" ? "root-event" : undefined,
        tags: [],
      } as any;

      const mockRootEvent = {
        id: "root-event",
        kind: 11,
        pubkey: "user-pubkey",
        tags: [],
      } as any;

      const context = {
        triggeringEvent: mockTriggeringEvent,
        rootEvent: mockRootEvent,
        conversationId: "conv-123",
      };

      const events = encoder.encodeDelegation(intent, context);

      expect(events.length).toBe(1);
      
      const event = events[0];
      // Should have single p-tag
      const pTags = event.tags.filter(tag => tag[0] === "p");
      expect(pTags.length).toBe(1);
      expect(pTags[0]).toEqual(["p", "single-recipient-pubkey"]);
    });
  });

  describe("Registry Tracking", () => {
    it("should track each recipient with the same delegation event ID", async () => {
      const intent = {
        type: "delegation" as const,
        recipients: ["recipient1-pubkey", "recipient2-pubkey"],
        request: "Multi-recipient task",
      };

      const mockTriggeringEvent = {
        id: "trigger-event",
        kind: 1111,
        pubkey: "user-pubkey",
        tagValue: (tag: string) => tag === "e" ? "root-event" : undefined,
        tags: [],
      } as any;

      const mockRootEvent = {
        id: "root-event",
        kind: 11,
        pubkey: "user-pubkey",
        tags: [],
      } as any;

      const context = {
        triggeringEvent: mockTriggeringEvent,
        rootEvent: mockRootEvent,
        conversationId: "conv-123",
      };

      // Mock event publish
      const mockPublish = mock(() => Promise.resolve());
      mock.module("@nostr-dev-kit/ndk", () => ({
        NDKEvent: class MockNDKEvent {
          id = `event-${Math.random().toString(36).substring(7)}`;
          kind = 1111;
          content = "";
          tags: string[][] = [];
          
          tag(tagArray: string[]) {
            this.tags.push(tagArray);
          }
          
          sign = mock(async function(this: any, signer: NDKSigner) {
            this.sig = "mock-sig";
            return this.sig;
          });
          
          publish = mockPublish;
          
          tagValue(tagName: string) {
            const tag = this.tags.find(t => t[0] === tagName);
            return tag ? tag[1] : undefined;
          }
        },
      }));

      const result = await publisher.delegate(intent, context);
      
      // Should have a batch ID
      expect(result.batchId).toBeDefined();
      
      // Registry should be tracking delegations with same event ID
      const registry = DelegationRegistry.getInstance();
      
      // Both recipients should have delegation records with the same event ID
      const mainEventId = result.events[0].id;
      const task1 = registry.findDelegationByEventAndResponder(mainEventId, "recipient1-pubkey");
      const task2 = registry.findDelegationByEventAndResponder(mainEventId, "recipient2-pubkey");
      
      expect(task1).toBeDefined();
      expect(task2).toBeDefined();
      expect(task1?.assignedTo.pubkey).toBe("recipient1-pubkey");
      expect(task2?.assignedTo.pubkey).toBe("recipient2-pubkey");
      expect(task1?.delegationEventId).toBe(mainEventId);
      expect(task2?.delegationEventId).toBe(mainEventId);
    });
  });

  describe("Completion Handling", () => {
    it("should correctly identify which recipient completed", async () => {
      const registry = DelegationRegistry.getInstance();
      
      // Create a mock delegation with same event ID for multiple recipients
      const eventId = "delegation-event-123";
      const recipients = ["agent1-pubkey", "agent2-pubkey"];
      
      // Register the batch with same event ID for all recipients
      const batchId = await registry.registerDelegation({
        delegationEventId: eventId,
        recipients: recipients.map(pubkey => ({
          pubkey: pubkey,
          request: "Test delegation",
          phase: "execute",
        })),
        delegatingAgent: mockAgent,
        rootConversationId: "conv-123",
        originalRequest: "Test delegation",
      });
      
      // Now test that we can find the right delegation by event ID and responder
      const delegation1 = registry.findDelegationByEventAndResponder(eventId, "agent1-pubkey");
      const delegation2 = registry.findDelegationByEventAndResponder(eventId, "agent2-pubkey");
      
      expect(delegation1).toBeDefined();
      expect(delegation2).toBeDefined();
      expect(delegation1?.assignedTo.pubkey).toBe("agent1-pubkey");
      expect(delegation2?.assignedTo.pubkey).toBe("agent2-pubkey");
      
      // Both should be part of the same batch
      expect(delegation1?.delegationBatchId).toBe(batchId);
      expect(delegation2?.delegationBatchId).toBe(batchId);
    });
  });
});
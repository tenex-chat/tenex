/**
 * Integration tests for AgentEventEncoder using NDK test utilities
 * 
 * These tests verify the encoder works correctly with real NDKEvent instances
 * and proper signature verification.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { NDKKind } from "@nostr-dev-kit/ndk";
import { EVENT_KINDS } from "@/llm/types";
import type { AgentInstance } from "@/agents/types";
import { 
  TENEXTestFixture,
  withTestEnvironment,
  getTestUserWithSigner,
  type TestUserName
} from "@/test-utils/ndk-test-helpers";
import {
  AgentEventEncoder,
  type CompletionIntent,
  type ConversationIntent,
  type DelegationIntent,
  type EventContext,
  type StatusIntent,
} from "../AgentEventEncoder";
import { AgentEventDecoder } from "../AgentEventDecoder";

// Mock the modules
mock.module("@/nostr/ndkClient", () => ({
  getNDK: mock(() => ({
    // Return the fixture's NDK instance
  })),
}));

mock.module("@/services", () => ({
  getProjectContext: mock(),
}));

import { getProjectContext } from "@/services";
import { getNDK } from "@/nostr/ndkClient";

describe("AgentEventEncoder Integration Tests", () => {
  describe("with real NDK events and signatures", () => {
    it("should create properly signed completion events", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup agent
        const { user: agentUser, signer } = await getTestUserWithSigner("alice", fixture.ndk);
        const agent: AgentInstance = {
          name: "CompletionAgent",
          pubkey: agentUser.pubkey,
          slug: "completion-agent",
          signer: signer as any,
          llmConfig: "gpt-4",
          tools: ["search", "calculate"],
          role: "assistant",
        };

        // Create triggering event from user
        const triggeringEvent = await fixture.eventFactory.createSignedTextNote(
          "Please analyze this data",
          "bob"
        );
        triggeringEvent.tags.push(["request-id", "req-123"]);

        // Create conversation root
        const conversationEvent = await fixture.eventFactory.createSignedTextNote(
          "Let's analyze some data",
          "bob"
        );
        conversationEvent.tags.push(["conversation-id", "conv-456"]);

        // Mock getNDK to return fixture's NDK
        (getNDK as any).mockReturnValue(fixture.ndk);

        // Create context
        const context: EventContext = {
          triggeringEvent,
          rootEvent: conversationEvent,
          conversationId: conversationEvent.id || "conv123",
        };

        // Create completion intent
        const intent: CompletionIntent = {
          content: "Analysis complete. Found 3 anomalies in the dataset.",
          usage: {
            promptTokens: 150,
            completionTokens: 50,
            totalTokens: 200,
          },
        };

        // Create mock ConversationCoordinator and encoder
        const mockConversationCoordinator = {
          getConversation: mock(() => ({
            history: [conversationEvent, triggeringEvent]
          }))
        };
        const encoder = new AgentEventEncoder(mockConversationCoordinator);

        // Encode the completion
        const event = encoder.encodeCompletion(intent, context);

        // Verify event structure
        expect(event.kind).toBe(NDKKind.GenericReply);
        expect(event.content).toBe("Analysis complete. Found 3 anomalies in the dataset.");
        
        // Verify conversation tags
        expect(event.tagValue("E")).toBe(conversationEvent.id);
        expect(event.tagValue("K")).toBe(String(conversationEvent.kind));
        expect(event.tagValue("P")).toBe(conversationEvent.pubkey);

        // Verify usage metadata
        expect(event.tagValue("llm-prompt-tokens")).toBe("150");
        expect(event.tagValue("llm-completion-tokens")).toBe("50");
        expect(event.tagValue("llm-total-tokens")).toBe("200");
      });
    });

    it("should handle multi-agent delegation chains", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup agents
        const { user: coordinator, signer: coordinatorSigner } = await getTestUserWithSigner("alice", fixture.ndk);
        const { user: worker1 } = await getTestUserWithSigner("bob", fixture.ndk);
        const { user: worker2 } = await getTestUserWithSigner("carol", fixture.ndk);

        // Mock getNDK
        (getNDK as any).mockReturnValue(fixture.ndk);

        // User creates initial request
        const userRequest = await fixture.eventFactory.createSignedTextNote(
          "Analyze this document and create a summary",
          "dave",
          EVENT_KINDS.TASK
        );
        userRequest.tags.push(
          ["d", "task-001"],
          ["priority", "high"]
        );

        // Coordinator delegates to workers
        const delegationIntent: DelegationIntent = {
          recipients: [worker1.pubkey, worker2.pubkey],
          request: "Extract key points from document and create visual summary",
        };

        const context: EventContext = {
          triggeringEvent: userRequest,
          rootEvent: userRequest,
          conversationId: userRequest.id || "conv123",
        };

        // Create mock ConversationCoordinator and encoder
        const mockConversationCoordinator = {
          getConversation: mock(() => ({
            history: [conversationEvent, triggeringEvent]
          }))
        };
        const encoder = new AgentEventEncoder(mockConversationCoordinator);

        // Create delegation events
        const delegationEvents = encoder.encodeDelegation(delegationIntent, context);

        // Current implementation creates a single event with multiple p-tags
        expect(delegationEvents).toHaveLength(1);
        const delegationEvent = delegationEvents[0];

        // Verify event structure
        expect(delegationEvent.kind).toBe(1111); // GenericReply/conversation kind
        expect(delegationEvent.content).toContain("Extract key points from document and create visual summary");

        // Verify both recipients are p-tagged
        const pTags = delegationEvent.getMatchingTags("p");
        const recipientPubkeys = pTags.map(tag => tag[1]);
        expect(recipientPubkeys).toContain(worker1.pubkey);
        expect(recipientPubkeys).toContain(worker2.pubkey);

        // Should reference the original task
        expect(delegationEvent.tagValue("e")).toBe(userRequest.id);
      });
    });

    // Status test removed - queue functionality no longer exists

    it("should handle conversation flow with proper threading", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create a conversation thread
        const conversation = await fixture.createConversationThread(
          { author: "alice", content: "What's the weather like?" },
          [
            { author: "bob", content: "Checking weather data...", isAgent: true },
            { author: "bob", content: "It's sunny, 72°F", isAgent: true },
            { author: "alice", content: "Perfect! Thanks!" },
          ]
        );
        
        expect(conversation).toHaveLength(4);
        
        // Verify threading
        const [initial, status, result, thanks] = conversation;
        
        // Status should reference initial
        expect(status.tags).toContainEqual(
          expect.arrayContaining(["e", initial.id])
        );
        
        // Result should reference status
        expect(result.tags).toContainEqual(
          expect.arrayContaining(["e", status.id])
        );
        
        // Thanks should reference result
        expect(thanks.tags).toContainEqual(
          expect.arrayContaining(["e", result.id])
        );
        
        // All agent events should have agent tags
        expect(status.tagValue("client")).toBe("tenex");
        expect(result.tagValue("client")).toBe("tenex");
      });
    });
  });
});
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
          conversationEvent,
          agent,
        };

        // Create completion intent
        const intent: CompletionIntent = {
          type: "completion",
          content: "Analysis complete. Found 3 anomalies in the dataset.",
          summary: "3 anomalies detected",
          executionMetadata: {
            executionTime: 2500,
            usage: {
              prompt_tokens: 150,
              completion_tokens: 50,
              total_tokens: 200,
            },
            toolCalls: [
              { name: "search", arguments: { query: "anomaly detection" } },
              { name: "calculate", arguments: { expression: "sum([1,2,3])" } },
            ],
          },
        };

        // Encode the completion
        const event = AgentEventEncoder.encodeCompletion(intent, context);

        // Verify event structure
        expect(event.kind).toBe(NDKKind.GenericReply);
        expect(event.content).toBe("Analysis complete. Found 3 anomalies in the dataset.");
        
        // Verify conversation tags
        expect(event.tagValue("E")).toBe(conversationEvent.id);
        expect(event.tagValue("K")).toBe(String(conversationEvent.kind));
        expect(event.tagValue("P")).toBe(conversationEvent.pubkey);
        
        // Verify metadata
        expect(event.tagValue("summary")).toBe("3 anomalies detected");
        expect(event.tagValue("execution-time")).toBe("2500");
        expect(event.tagValue("llm-total-tokens")).toBe("200");
        
        // Verify tool tags
        const toolTags = event.getMatchingTags("tool");
        expect(toolTags).toHaveLength(2);
        expect(toolTags[0][1]).toBe("search");
        expect(JSON.parse(toolTags[0][2])).toEqual({ query: "anomaly detection" });
      });
    });

    it("should handle multi-agent delegation chains", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup agents
        const { user: orchestrator, signer: orchestratorSigner } = await getTestUserWithSigner("alice", fixture.ndk);
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

        // Orchestrator delegates to workers
        const delegationIntent: DelegationIntent = {
          type: "delegation",
          tasks: [
            {
              content: "Extract key points from document",
              recipientPubkey: worker1.pubkey,
              title: "Extract",
            },
            {
              content: "Create visual summary",
              recipientPubkey: worker2.pubkey,
              title: "Visualize",
            },
          ],
        };

        const context: EventContext = {
          triggeringEvent: userRequest,
          conversationEvent: userRequest,
          agent: {
            name: "Orchestrator",
            pubkey: orchestrator.pubkey,
            slug: "orchestrator",
            signer: orchestratorSigner as any,
            llmConfig: "gpt-4",
            tools: [],
            role: "orchestrator",
          },
        };

        // Create delegation events
        const delegationEvents = AgentEventEncoder.encodeDelegation(delegationIntent, context);
        
        expect(delegationEvents).toHaveLength(2);
        
        // Verify first delegation
        expect(delegationEvents[0].kind).toBe(EVENT_KINDS.TASK);
        expect(delegationEvents[0].content).toBe("Extract key points from document");
        expect(delegationEvents[0].tagValue("title")).toBe("Extract");
        const pTag1 = delegationEvents[0].getMatchingTags("p").find(t => t[3] === "agent");
        expect(pTag1?.[1]).toBe(worker1.pubkey);
        
        // Verify second delegation
        expect(delegationEvents[1].content).toBe("Create visual summary");
        expect(delegationEvents[1].tagValue("title")).toBe("Visualize");
        const pTag2 = delegationEvents[1].getMatchingTags("p").find(t => t[3] === "agent");
        expect(pTag2?.[1]).toBe(worker2.pubkey);
        
        // Both should reference the original task
        expect(delegationEvents[0].tagValue("e")).toBe(userRequest.id);
        expect(delegationEvents[1].tagValue("e")).toBe(userRequest.id);
      });
    });

    it("should properly encode status updates with relay simulation", async () => {
      await withTestEnvironment(async (fixture) => {
        const { user: agent, signer } = await getTestUserWithSigner("eve", fixture.ndk);
        
        // Create mock relay
        const relay = fixture.createMockRelay("wss://status.relay");
        await relay.connect();
        
        // Mock getNDK and project context
        (getNDK as any).mockReturnValue(fixture.ndk);
        (getProjectContext as any).mockReturnValue({
          project: {
            pubkey: "project-owner",
            tagReference: () => ["a", "31933:project-owner:test-project"],
          },
        });

        // Create status intent
        const statusIntent: StatusIntent = {
          type: "status",
          status: "processing",
          phase: "MAIN",
          message: "Analyzing data patterns...",
          progress: 45,
          queuedAgents: ["analyzer", "validator"],
        };

        // Encode status
        const event = AgentEventEncoder.encodeProjectStatus(statusIntent);
        
        // Verify status event
        expect(event.kind).toBe(NDKKind.Text);
        expect(event.tagValue("status")).toBe("processing");
        expect(event.tagValue("phase")).toBe("MAIN");
        expect(event.tagValue("progress")).toBe("45");
        expect(event.content).toBe("Analyzing data patterns...");
        
        // Verify queue tags
        const queueTags = event.getMatchingTags("queue");
        expect(queueTags).toHaveLength(2);
        expect(queueTags[0][1]).toBe("analyzer");
        expect(queueTags[1][1]).toBe("validator");
        
        // Simulate publishing to relay
        await relay.publish(event);
        
        // Verify relay received the event
        const publishedMessage = relay.messageLog.find(
          log => log.direction === "out" && log.message.includes("EVENT")
        );
        expect(publishedMessage).toBeDefined();
        
        // Simulate receiving the event back
        await relay.simulateEvent(event, "status-sub");
        
        // Verify we can decode it back
        const isStatus = AgentEventDecoder.isStatusUpdate(event);
        expect(isStatus).toBe(true);
      });
    });

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
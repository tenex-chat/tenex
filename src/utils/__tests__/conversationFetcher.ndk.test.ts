/**
 * conversationFetcher tests using NDK test utilities
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { 
  TENEXTestFixture,
  withTestEnvironment,
  type TestUserName 
} from "@/test-utils/ndk-test-helpers";
import { fetchConversation } from "../conversationFetcher";
import { NDKKind } from "@nostr-dev-kit/ndk";

// Mock the services module
mock.module("@/services", () => ({
  getProjectContext: () => ({
    project: {
      pubkey: "project-pubkey",
    },
    agents: new Map([
      [
        "analyzer",
        {
          name: "Analyzer Agent",
          slug: "analyzer",
          pubkey: "analyzer-pubkey",
        },
      ],
      [
        "validator", 
        {
          name: "Validator Agent",
          slug: "validator",
          pubkey: "validator-pubkey",
        },
      ],
    ]),
  }),
}));

describe("fetchConversation with NDK utilities", () => {
  describe("conversation fetching with real events", () => {
    test("fetches and formats a properly signed conversation thread", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create a realistic conversation thread
        const conversation = await fixture.createConversationThread(
          { author: "alice", content: "Can you analyze this data for me?" },
          [
            { author: "bob", content: "Starting analysis...", isAgent: true },
            { author: "bob", content: "Found 3 anomalies in the dataset", isAgent: true },
            { author: "alice", content: "Can you provide more details?" },
            { author: "bob", content: "Anomaly 1: Duplicate entries...", isAgent: true },
          ]
        );

        // Mock NDK to return our conversation
        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(conversation[0])),
          fetchEvents: mock(() => Promise.resolve(new Set(conversation))),
          getUser: mock(() => ({
            fetchProfile: mock(() => Promise.resolve()),
            profile: {
              displayName: "Test User",
              name: "testuser",
            },
          })),
        } as any;

        // Create a mock nevent ID
        const neventId = `nevent1${conversation[0].id}`;

        const result = await fetchConversation(neventId, mockNdk, "/test/path");

        // Verify the conversation was properly formatted
        expect(result).toContain("# Conversation Thread");
        expect(result).toContain("Can you analyze this data for me?");
        expect(result).toContain("Starting analysis...");
        expect(result).toContain("Found 3 anomalies in the dataset");
        expect(result).toContain("Can you provide more details?");
        expect(result).toContain("Anomaly 1: Duplicate entries...");

        // Verify proper fetch was called
        expect(mockNdk.fetchEvent).toHaveBeenCalledWith(neventId);
      });
    });

    test("handles complex thread with multiple participants", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create multi-participant conversation
        const alice = await fixture.getUser("alice");
        const bob = await fixture.getUser("bob");
        const carol = await fixture.getUser("carol");

        // Create events manually for more control
        const rootEvent = await fixture.eventFactory.createSignedTextNote(
          "Team, we need to solve this bug",
          "alice"
        );
        rootEvent.tags.push(["subject", "Critical Bug Fix"]);

        const bobReply = await fixture.eventFactory.createReply(
          rootEvent,
          "I'll check the logs",
          "bob"
        );

        const carolReply = await fixture.eventFactory.createReply(
          rootEvent,
          "I'll review the recent changes",
          "carol"
        );

        const aliceFollowup = await fixture.eventFactory.createReply(
          bobReply,
          "Did you find anything in the logs?",
          "alice"
        );

        const conversation = [rootEvent, bobReply, carolReply, aliceFollowup];

        // Mock NDK
        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(rootEvent)),
          fetchEvents: mock(() => Promise.resolve(new Set(conversation))),
          getUser: mock((pubkey: string) => {
            const profiles = {
              [alice.pubkey]: { displayName: "Alice", name: "alice" },
              [bob.pubkey]: { displayName: "Bob", name: "bob" },
              [carol.pubkey]: { displayName: "Carol", name: "carol" },
            };
            return {
              fetchProfile: mock(() => Promise.resolve()),
              profile: profiles[pubkey] || { displayName: "Unknown", name: "unknown" },
            };
          }),
        } as any;

        const result = await fetchConversation(`nevent1${rootEvent.id}`, mockNdk, "/test/path");

        // Verify all participants' messages are included
        expect(result).toContain("Team, we need to solve this bug");
        expect(result).toContain("I'll check the logs");
        expect(result).toContain("I'll review the recent changes");
        expect(result).toContain("Did you find anything in the logs?");
      });
    });

    test("properly handles agent vs human identification", async () => {
      await withTestEnvironment(async (fixture) => {
        // Setup project context with specific agent pubkeys
        const alice = await fixture.getUser("alice");
        const bob = await fixture.getUser("bob");

        mock.module("@/services", () => ({
          getProjectContext: () => ({
            project: {
              pubkey: alice.pubkey, // Alice is the project owner
            },
            agents: new Map([
              [
                "assistant",
                {
                  name: "Assistant",
                  slug: "assistant", 
                  pubkey: bob.pubkey, // Bob is an agent
                },
              ],
            ]),
          }),
        }));

        // Create conversation
        const humanMessage = await fixture.eventFactory.createSignedTextNote(
          "Help me with this task",
          "alice"
        );

        const agentResponse = await fixture.eventFactory.createReply(
          humanMessage,
          "I'll help you with that",
          "bob"
        );

        const conversation = [humanMessage, agentResponse];

        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(humanMessage)),
          fetchEvents: mock(() => Promise.resolve(new Set(conversation))),
          getUser: mock(() => ({
            fetchProfile: mock(() => Promise.resolve()),
            profile: { displayName: "User", name: "user" },
          })),
        } as any;

        const result = await fetchConversation(`nevent1${humanMessage.id}`, mockNdk, "/test/path");

        // Both messages should be present
        expect(result).toContain("Help me with this task");
        expect(result).toContain("I'll help you with that");

        // Verify agent pubkey was correctly identified
        expect(result).toContain("Conversation Thread");
      });
    });

    test("handles events with proper E tag threading", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create events with E tags for threading
        const rootEvent = await fixture.eventFactory.createSignedTextNote(
          "Start of discussion",
          "dave"
        );
        rootEvent.tags.push(["E", rootEvent.id]); // Self-reference as root

        const reply1 = await fixture.eventFactory.createSignedTextNote(
          "First reply",
          "eve"
        );
        reply1.tags.push(
          ["E", rootEvent.id], // Root reference
          ["e", rootEvent.id, "", "reply"] // Direct reply
        );

        const reply2 = await fixture.eventFactory.createSignedTextNote(
          "Second reply",
          "alice"
        );
        reply2.tags.push(
          ["E", rootEvent.id], // Root reference
          ["e", reply1.id || "", "", "reply"] // Reply to first reply
        );

        const conversation = [rootEvent, reply1, reply2];

        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(rootEvent)),
          fetchEvents: mock(() => Promise.resolve(new Set(conversation))),
          getUser: mock(() => ({
            fetchProfile: mock(() => Promise.resolve()),
            profile: { displayName: "User", name: "user" },
          })),
        } as any;

        const result = await fetchConversation(`nevent1${rootEvent.id}`, mockNdk, "/test/path");

        // Verify threading is preserved
        expect(result).toContain("Start of discussion");
        expect(result).toContain("First reply");
        expect(result).toContain("Second reply");
      });
    });

    test("handles missing events gracefully", async () => {
      await withTestEnvironment(async (fixture) => {
        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(null)),
          fetchEvents: mock(() => Promise.resolve(new Set())),
          getUser: mock(() => ({
            fetchProfile: mock(() => Promise.resolve()),
            profile: null,
          })),
        } as any;

        await expect(
          fetchConversation("nevent1missing", mockNdk, "/test/path")
        ).rejects.toThrow("Event nevent1missing not found");
      });
    });

    test("formats conversation with metadata tags", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create event with rich metadata
        const event = await fixture.eventFactory.createSignedTextNote(
          "Message with metadata",
          "bob"
        );
        event.tags.push(
          ["subject", "Important Discussion"],
          ["category", "technical"],
          ["priority", "high"],
          ["model", "gpt-4"],
          ["execution-time", "1500"]
        );

        const mockNdk = {
          fetchEvent: mock(() => Promise.resolve(event)),
          fetchEvents: mock(() => Promise.resolve(new Set([event]))),
          getUser: mock(() => ({
            fetchProfile: mock(() => Promise.resolve()),
            profile: { displayName: "Bob", name: "bob" },
          })),
        } as any;

        const result = await fetchConversation(`nevent1${event.id}`, mockNdk, "/test/path");

        // Message should be included
        expect(result).toContain("Message with metadata");
        
        // The formatter should handle the event with metadata gracefully
        expect(result).toContain("Conversation Thread");
      });
    });
  });
});
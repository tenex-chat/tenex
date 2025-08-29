/**
 * FileSystemAdapter tests using NDK test utilities
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { 
  TENEXTestFixture,
  withTestEnvironment 
} from "@/test-utils/ndk-test-helpers";
import { FileSystemAdapter } from "../FileSystemAdapter";
import { PHASES } from "../../phases";
import type { Conversation } from "../../types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("FileSystemAdapter with NDK utilities", () => {
  let adapter: FileSystemAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = `/tmp/test-conversations-${Date.now()}`;
    await fs.mkdir(testDir, { recursive: true });
    adapter = new FileSystemAdapter(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("conversation persistence with real events", () => {
    it("should save and load conversation with properly signed events", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create a realistic conversation
        const conversation = await fixture.createConversationThread(
          { author: "alice", content: "Let's discuss the new feature" },
          [
            { author: "bob", content: "I have some ideas", isAgent: true },
            { author: "alice", content: "Great, let's hear them" },
            { author: "bob", content: "We could implement...", isAgent: true },
          ]
        );

        const conv: Conversation = {
          id: "test-conv-1",
          title: "Feature Discussion",
          phase: PHASES.CHAT,
          history: conversation,
          agentStates: new Map([
            ["bob", { lastActive: Date.now(), messagesCount: 2 }],
          ]),
          phaseStartedAt: Date.now(),
          metadata: {
            participants: ["alice", "bob"],
            tags: ["feature", "discussion"],
          },
          phaseTransitions: [
            { from: PHASES.INIT, to: PHASES.CHAT, timestamp: Date.now() },
          ],
          executionTime: {
            totalSeconds: 45,
            isActive: false,
            lastUpdated: Date.now(),
          },
        };

        // Save conversation
        await adapter.save(conv);

        // Load it back
        const loaded = await adapter.load("test-conv-1");

        expect(loaded).toBeDefined();
        expect(loaded?.id).toBe("test-conv-1");
        expect(loaded?.title).toBe("Feature Discussion");
        expect(loaded?.history).toHaveLength(4);
        
        // Verify events maintain their properties
        expect(loaded?.history[0].content).toBe("Let's discuss the new feature");
        expect(loaded?.history[0].sig).toBeDefined();
        expect(loaded?.history[0].pubkey).toBe(
          await fixture.getUser("alice").then(u => u.pubkey)
        );
      });
    });

    it("should handle conversation with complex event relationships", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create events with various relationships
        const rootEvent = await fixture.eventFactory.createSignedTextNote(
          "Project planning session",
          "carol"
        );
        rootEvent.tags.push(
          ["d", "planning-session"],
          ["subject", "Q4 Planning"],
        );

        const delegation = await fixture.createAgentEvent(
          "dave",
          "I'll handle the technical planning",
          8001,
          [
            ["e", rootEvent.id || "", "", "reply"],
            ["delegation", "technical-planning"],
          ]
        );

        const completion = await fixture.createAgentEvent(
          "eve",
          "Marketing plan complete",
          8002,
          [
            ["e", rootEvent.id || "", "", "reply"],
            ["status", "complete"],
          ]
        );

        const conv: Conversation = {
          id: "complex-conv",
          title: "Q4 Planning",
          phase: PHASES.MAIN,
          history: [rootEvent, delegation, completion],
          agentStates: new Map([
            ["dave", { role: "technical-lead" }],
            ["eve", { role: "marketing-lead" }],
          ]),
          phaseStartedAt: Date.now(),
          metadata: {
            type: "planning",
            quarter: "Q4",
          },
          phaseTransitions: [],
          executionTime: {
            totalSeconds: 120,
            isActive: true,
            lastUpdated: Date.now(),
          },
        };

        await adapter.save(conv);
        const loaded = await adapter.load("complex-conv");

        expect(loaded).toBeDefined();
        expect(loaded?.history).toHaveLength(3);
        
        // Verify delegation event
        const loadedDelegation = loaded?.history[1];
        expect(loadedDelegation?.tags).toContainEqual(
          expect.arrayContaining(["delegation", "technical-planning"])
        );
        
        // Verify completion event
        const loadedCompletion = loaded?.history[2];
        expect(loadedCompletion?.tags).toContainEqual(
          expect.arrayContaining(["status", "complete"])
        );
      });
    });

    it("should preserve agent states across save/load", async () => {
      await withTestEnvironment(async (fixture) => {
        const event = await fixture.eventFactory.createSignedTextNote(
          "Test message",
          "alice"
        );

        const agentStates = new Map([
          ["analyzer", {
            lastActive: Date.now(),
            messagesCount: 5,
            tokensUsed: 1500,
            tools: ["search", "calculate"],
            metadata: { model: "gpt-4", temperature: 0.7 },
          }],
          ["validator", {
            lastActive: Date.now() - 1000,
            messagesCount: 3,
            tokensUsed: 800,
            status: "idle",
          }],
        ]);

        const conv: Conversation = {
          id: "state-test",
          title: "Agent State Test",
          phase: PHASES.CHAT,
          history: [event],
          agentStates,
          phaseStartedAt: Date.now(),
          metadata: {},
          phaseTransitions: [],
          executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now(),
          },
        };

        await adapter.save(conv);
        const loaded = await adapter.load("state-test");

        expect(loaded?.agentStates.size).toBe(2);
        expect(loaded?.agentStates.get("analyzer")).toMatchObject({
          messagesCount: 5,
          tokensUsed: 1500,
          tools: ["search", "calculate"],
        });
        expect(loaded?.agentStates.get("validator")).toMatchObject({
          messagesCount: 3,
          status: "idle",
        });
      });
    });

    it("should handle conversation updates", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create initial conversation
        const initialEvent = await fixture.eventFactory.createSignedTextNote(
          "Initial message",
          "bob"
        );

        const conv: Conversation = {
          id: "update-test",
          title: "Update Test",
          phase: PHASES.INIT,
          history: [initialEvent],
          agentStates: new Map(),
          phaseStartedAt: Date.now(),
          metadata: { version: 1 },
          phaseTransitions: [],
          executionTime: {
            totalSeconds: 10,
            isActive: false,
            lastUpdated: Date.now(),
          },
        };

        await adapter.save(conv);

        // Update conversation
        const newEvent = await fixture.eventFactory.createSignedTextNote(
          "Additional message",
          "carol"
        );

        conv.history.push(newEvent);
        conv.phase = PHASES.CHAT;
        conv.metadata.version = 2;
        conv.executionTime.totalSeconds = 25;

        await adapter.save(conv);

        // Load updated conversation
        const loaded = await adapter.load("update-test");

        expect(loaded?.history).toHaveLength(2);
        expect(loaded?.phase).toBe(PHASES.CHAT);
        expect(loaded?.metadata.version).toBe(2);
        expect(loaded?.executionTime.totalSeconds).toBe(25);
      });
    });

    it("should list all conversations", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create multiple conversations
        const conversations: Conversation[] = [];

        for (let i = 0; i < 3; i++) {
          const event = await fixture.eventFactory.createSignedTextNote(
            `Message ${i}`,
            i % 2 === 0 ? "alice" : "bob"
          );

          conversations.push({
            id: `conv-${i}`,
            title: `Conversation ${i}`,
            phase: PHASES.CHAT,
            history: [event],
            agentStates: new Map(),
            phaseStartedAt: Date.now() - i * 1000,
            metadata: { index: i },
            phaseTransitions: [],
            executionTime: {
              totalSeconds: i * 10,
              isActive: false,
              lastUpdated: Date.now(),
            },
          });
        }

        // Save all conversations
        for (const conv of conversations) {
          await adapter.save(conv);
        }

        // List conversations
        const ids = await adapter.list();

        expect(ids).toHaveLength(3);
        expect(ids).toContain("conv-0");
        expect(ids).toContain("conv-1");
        expect(ids).toContain("conv-2");
      });
    });

    it("should handle deletion", async () => {
      await withTestEnvironment(async (fixture) => {
        const event = await fixture.eventFactory.createSignedTextNote(
          "To be deleted",
          "dave"
        );

        const conv: Conversation = {
          id: "delete-test",
          title: "Delete Test",
          phase: PHASES.CHAT,
          history: [event],
          agentStates: new Map(),
          phaseStartedAt: Date.now(),
          metadata: {},
          phaseTransitions: [],
          executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now(),
          },
        };

        await adapter.save(conv);
        expect(await adapter.exists("delete-test")).toBe(true);

        await adapter.delete("delete-test");
        expect(await adapter.exists("delete-test")).toBe(false);

        const loaded = await adapter.load("delete-test");
        expect(loaded).toBeNull();
      });
    });

    it("should handle conversations with large event histories", async () => {
      await withTestEnvironment(async (fixture) => {
        // Create a large conversation thread
        const events = [];
        
        for (let i = 0; i < 50; i++) {
          const author = ["alice", "bob", "carol", "dave", "eve"][i % 5] as any;
          const event = await fixture.eventFactory.createSignedTextNote(
            `Message number ${i}: This is a longer message to simulate real conversation content...`,
            author
          );
          events.push(event);
        }

        const conv: Conversation = {
          id: "large-conv",
          title: "Large Conversation",
          phase: PHASES.MAIN,
          history: events,
          agentStates: new Map([
            ["agent1", { messagesCount: 25 }],
            ["agent2", { messagesCount: 25 }],
          ]),
          phaseStartedAt: Date.now(),
          metadata: {
            totalMessages: 50,
            startTime: Date.now() - 3600000,
          },
          phaseTransitions: [
            { from: PHASES.INIT, to: PHASES.CHAT, timestamp: Date.now() - 3000000 },
            { from: PHASES.CHAT, to: PHASES.MAIN, timestamp: Date.now() - 1800000 },
          ],
          executionTime: {
            totalSeconds: 3600,
            isActive: false,
            lastUpdated: Date.now(),
          },
        };

        await adapter.save(conv);
        const loaded = await adapter.load("large-conv");

        expect(loaded).toBeDefined();
        expect(loaded?.history).toHaveLength(50);
        expect(loaded?.metadata.totalMessages).toBe(50);
        
        // Verify first and last messages
        expect(loaded?.history[0].content).toContain("Message number 0");
        expect(loaded?.history[49].content).toContain("Message number 49");
      });
    });
  });
});
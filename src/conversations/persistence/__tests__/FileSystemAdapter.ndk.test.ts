/**
 * FileSystemAdapter tests using NDK test utilities
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { 
  TENEXTestFixture,
  withTestEnvironment 
} from "@/test-utils/ndk-test-helpers";
import { FileSystemAdapter } from "../FileSystemAdapter";
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
          phase: "CHAT",
          history: conversation,
          agentStates: new Map([
            ["bob", { lastActive: Date.now(), messagesCount: 2 }],
          ]),
          phaseStartedAt: Date.now(),
          metadata: {
            participants: ["alice", "bob"],
            tags: ["feature", "discussion"],
          },
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
          phase: "MAIN",
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
          phase: "CHAT",
          history: [event],
          agentStates,
          phaseStartedAt: Date.now(),
          metadata: {},
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
          phase: "INIT",
          history: [initialEvent],
          agentStates: new Map(),
          phaseStartedAt: Date.now(),
          metadata: { version: 1 },
            agentStates: new Map(),
            phaseStartedAt: Date.now() - i * 1000,
            metadata: { index: i },
          agentStates: new Map(),
          phaseStartedAt: Date.now(),
          metadata: {},
            ["agent2", { messagesCount: 25 }],
          ]),
          phaseStartedAt: Date.now(),
          metadata: {
            totalMessages: 50,
            startTime: Date.now() - 3600000,
          },
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
/**
 * TDD tests for ConversationStore
 *
 * ConversationStore is the single source of truth for conversation state.
 * It handles:
 * - Persistent storage of messages
 * - RAL lifecycle management
 * - Message visibility rules
 * - Injection queue
 * - Nostr event hydration
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolCallPart, ToolResultPart } from "ai";
import { NDKKind } from "@nostr-dev-kit/ndk";
import * as pubkeyServiceModule from "@/services/PubkeyService";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import {
    ConversationStore,
    type ConversationRecordInput,
    type Injection,
} from "../ConversationStore";

// Mock PubkeyService for attribution tests
const mockPubkeyNames: Record<string, string> = {
    "transparent-pk": "transparent",
    "agent1-pk": "agent1",
    "agent2-pk": "agent2",
    "pablo-pk": "Pablo",
    "user-pubkey-xyz": "User",
    "agent1-pubkey-abc": "agent1",
    "agent2-pubkey-def": "agent2",
    "owner-pubkey": "ProjectOwner",
    "interloper-pubkey": "Interloper",
};

const mockGetName = mock(async (pubkey: string) => {
    return mockPubkeyNames[pubkey] ?? "Unknown";
});

const mockGetNameSync = mock((pubkey: string) => {
    return mockPubkeyNames[pubkey] ?? "Unknown";
});

describe("ConversationStore", () => {
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-123";
    const AGENT1_PUBKEY = "agent1-pubkey-abc";
    const AGENT2_PUBKEY = "agent2-pubkey-def";
    const USER_PUBKEY = "user-pubkey-xyz";

    let testDir: string;
    let store: ConversationStore;

    beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), "tenex-test-conversations-"));
        mockGetName.mockClear();
        mockGetNameSync.mockClear();
        spyOn(pubkeyServiceModule, "getPubkeyService").mockReturnValue({
            getName: mockGetName,
            getNameSync: mockGetNameSync,
        } as any);
        store = new ConversationStore(testDir);
    });

    afterEach(async () => {
        mock.restore();
        await rm(testDir, { recursive: true, force: true });
    });

    describe("File Operations", () => {
        it("should create conversation file on first save", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            const entry: ConversationRecordInput = {
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
            };
            store.addMessage(entry);
            await store.save();

            const filePath = join(
                testDir,
                PROJECT_ID,
                "conversations",
                `${CONVERSATION_ID}.json`
            );
            const content = await readFile(filePath, "utf-8");
            const data = JSON.parse(content);

            expect(data.messages).toHaveLength(1);
            expect(data.messages[0].pubkey).toBe(USER_PUBKEY);
        });

        it("should load existing conversation from file", async () => {
            // First create and save
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
            });
            await store.save();

            // Create new store instance and load
            const store2 = new ConversationStore(testDir);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            const messages = store2.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].pubkey).toBe(USER_PUBKEY);
        });

        it("backfills canonical record ids for legacy stored messages", async () => {
            const conversationsDir = join(testDir, PROJECT_ID, "conversations");
            await mkdir(conversationsDir, { recursive: true });
            await writeFile(
                join(conversationsDir, `${CONVERSATION_ID}.json`),
                JSON.stringify({
                    activeRal: {},
                    nextRalNumber: {},
                    injections: [],
                    messages: [
                        {
                            pubkey: USER_PUBKEY,
                            content: "hello",
                            messageType: "text",
                            eventId: "evt-1",
                        },
                    ],
                    metadata: {},
                    agentTodos: {},
                    todoNudgedAgents: [],
                    blockedAgents: [],
                    executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                }, null, 2)
            );

            store.load(PROJECT_ID, CONVERSATION_ID);

            expect(store.getAllMessages()[0].id).toBe("record:evt-1");
        });

        it("persists context-management scratchpads per agent", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);

            store.setContextManagementScratchpad(AGENT1_PUBKEY, {
                entries: {
                    objective: "Focus on parser cleanup",
                    notes: "Focus on the failing tests",
                },
                keepLastMessages: 6,
                omitToolCallIds: ["tool-call-1"],
                updatedAt: 123,
                agentLabel: "agent1",
            });
            await store.save();

            const store2 = new ConversationStore(testDir);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            expect(store2.getContextManagementScratchpad(AGENT1_PUBKEY)).toEqual({
                entries: {
                    notes: "Focus on the failing tests",
                    objective: "Focus on parser cleanup",
                },
                keepLastMessages: 6,
                omitToolCallIds: ["tool-call-1"],
                updatedAt: 123,
                agentLabel: "agent1",
            });
            expect(store2.listContextManagementScratchpads()).toEqual([{
                agentId: AGENT1_PUBKEY,
                agentLabel: "agent1",
                state: {
                    entries: {
                        notes: "Focus on the failing tests",
                        objective: "Focus on parser cleanup",
                    },
                    keepLastMessages: 6,
                    omitToolCallIds: ["tool-call-1"],
                    updatedAt: 123,
                    agentLabel: "agent1",
                },
            }]);
        });

        it("keeps scratchpads that only contain structured entries", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);

            store.setContextManagementScratchpad(AGENT1_PUBKEY, {
                entries: {
                    thesis: "The parser regression is in middleware ordering",
                },
                omitToolCallIds: [],
                agentLabel: "agent1",
            });

            expect(store.getContextManagementScratchpad(AGENT1_PUBKEY)).toEqual({
                entries: {
                    thesis: "The parser regression is in middleware ordering",
                },
                omitToolCallIds: [],
                agentLabel: "agent1",
            });
        });

        it("migrates legacy scratchpad notes into structured entries on load", async () => {
            const conversationDir = join(testDir, PROJECT_ID, "conversations");
            await mkdir(conversationDir, { recursive: true });
            await writeFile(
                join(conversationDir, `${CONVERSATION_ID}.json`),
                JSON.stringify({
                    activeRal: {},
                    nextRalNumber: {},
                    injections: [],
                    messages: [],
                    metadata: {},
                    agentTodos: {},
                    todoNudgedAgents: [],
                    blockedAgents: [],
                    executionTime: {
                        totalSeconds: 0,
                        isActive: false,
                        lastUpdated: 123,
                    },
                    contextManagementScratchpads: {
                        [AGENT1_PUBKEY]: {
                            notes: "Focus on the failing tests",
                            keepLastMessages: 6,
                            omitToolCallIds: ["tool-call-1"],
                            updatedAt: 123,
                            agentLabel: "agent1",
                        },
                    },
                }, null, 2)
            );

            store.load(PROJECT_ID, CONVERSATION_ID);

            expect(store.getContextManagementScratchpad(AGENT1_PUBKEY)).toEqual({
                entries: {
                    notes: "Focus on the failing tests",
                },
                keepLastMessages: 6,
                omitToolCallIds: ["tool-call-1"],
                updatedAt: 123,
                agentLabel: "agent1",
            });
        });

        it("should return empty state for new conversation", () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            expect(store.getAllMessages()).toHaveLength(0);
            expect(store.getActiveRals(AGENT1_PUBKEY)).toHaveLength(0);
        });
    });

    describe("RAL Lifecycle", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should create RAL with sequential numbers", () => {
            const ral1 = store.createRal(AGENT1_PUBKEY);
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const ral3 = store.createRal(AGENT1_PUBKEY);

            expect(ral1).toBe(1);
            expect(ral2).toBe(2);
            expect(ral3).toBe(3);
        });

        it("should track active RALs", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);

            const activeRals = store.getActiveRals(AGENT1_PUBKEY);
            expect(activeRals).toEqual([1, 2]);
        });

        it("should mark RAL as complete", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            store.completeRal(AGENT1_PUBKEY, 1);

            const activeRals = store.getActiveRals(AGENT1_PUBKEY);
            expect(activeRals).toEqual([2]);
            expect(store.isRalActive(AGENT1_PUBKEY, 1)).toBe(false);
            expect(store.isRalActive(AGENT1_PUBKEY, 2)).toBe(true);
        });

        it("should maintain separate RAL sequences per agent", () => {
            const agent1Ral1 = store.createRal(AGENT1_PUBKEY);
            const agent2Ral1 = store.createRal(AGENT2_PUBKEY);
            const agent1Ral2 = store.createRal(AGENT1_PUBKEY);

            expect(agent1Ral1).toBe(1);
            expect(agent2Ral1).toBe(1);
            expect(agent1Ral2).toBe(2);
        });

        it("should register externally-assigned RAL via ensureRalActive", () => {
            // Use ensureRalActive to register an externally-assigned RAL number
            store.ensureRalActive(AGENT1_PUBKEY, 5);

            expect(store.isRalActive(AGENT1_PUBKEY, 5)).toBe(true);
            expect(store.getActiveRals(AGENT1_PUBKEY)).toEqual([5]);
        });

        it("should not duplicate RAL when ensureRalActive called multiple times", () => {
            store.ensureRalActive(AGENT1_PUBKEY, 3);
            store.ensureRalActive(AGENT1_PUBKEY, 3);
            store.ensureRalActive(AGENT1_PUBKEY, 3);

            expect(store.getActiveRals(AGENT1_PUBKEY)).toEqual([3]);
        });

        it("should update nextRalNumber when ensureRalActive uses higher number", () => {
            store.ensureRalActive(AGENT1_PUBKEY, 10);

            // Next createRal should return 11
            const nextRal = store.createRal(AGENT1_PUBKEY);
            expect(nextRal).toBe(11);
        });
    });

    describe("Message Visibility Rules", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should include all user messages for any agent", async () => {
            // User message
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
        });

        it("should keep only the latest delegation completion injection per RAL", async () => {
            const ral = store.createRal(AGENT1_PUBKEY);

            store.addMessage({
                pubkey: USER_PUBKEY,
                ral,
                content: "# DELEGATION COMPLETED\n\nfirst update",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });

            store.addMessage({
                pubkey: USER_PUBKEY,
                ral,
                content: "# DELEGATION COMPLETED\n\nsecond update",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });

            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);
            const completionMessages = messages.filter(
                (message) =>
                    typeof message.content === "string" &&
                    message.content.includes("# DELEGATION COMPLETED")
            );

            expect(completionMessages).toHaveLength(1);
            expect(completionMessages[0].content).toContain("second update");
        });

        it("should include all messages from same agent completed RALs", async () => {
            // RAL 1 - completed
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "I will help",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    input: { path: "/tmp/test" },
                }] as ToolCallPart[],
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    output: { type: "text", value: "file content" },
                }] as ToolResultPart[],
            });
            store.completeRal(AGENT1_PUBKEY, 1);

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should include all messages from completed RAL 1
            expect(messages).toHaveLength(3);
        });

        it("should exclude messages from other active RALs", async () => {
            // RAL 1 - active (not completed)
            store.createRal(AGENT1_PUBKEY);
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "Working on it",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    input: { path: "/tmp/test" },
                }] as ToolCallPart[],
            });

            // RAL 2 - current
            const ral2 = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral2);

            // Should NOT include RAL 1 messages - other active RALs are excluded
            expect(messages).toHaveLength(0);
        });

        it("should include only text outputs from other agents", async () => {
            // Agent 2 messages
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "I am agent 2",
                messageType: "text",
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    input: {},
                }] as ToolCallPart[],
            });
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    output: { type: "text", value: "content" },
                }] as ToolResultPart[],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent 1 RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Should only include the text output, not tool calls/results
            // Broadcasts from other agents - role will change with new implementation
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
            expect(messages[0].content).toContain("I am agent 2");
        });

        it("should exclude messages with only tool calls from other agents", async () => {
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "fs_read",
                    input: {},
                }] as ToolCallPart[],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(0);
        });

        it("should use 'user' role for targeted agent-to-agent messages", async () => {
            // Agent2 sends a targeted message to Agent1 via p-tag
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "What is your role in this project?",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent1 builds messages for its RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Targeted messages from other agents appear as "user" to the target
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
        });

        it("should use 'user' role for broadcast agent messages", async () => {
            // Agent2 broadcasts (no specific target)
            // All non-self messages use "user" role
            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "I have completed my analysis.",
                messageType: "text",
                // No targetedPubkeys = broadcast
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent1 builds messages for its RAL
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
        });

        it("should use 'user' role for observers of targeted messages", async () => {
            // Agent2 sends a message targeted to Agent1
            // A third agent (Agent3) observing should see as "user" (all non-self)
            const AGENT3_PUBKEY = "agent3-pubkey-ghi";

            store.createRal(AGENT2_PUBKEY);
            store.addMessage({
                pubkey: AGENT2_PUBKEY,
                ral: 1,
                content: "Here is my analysis.",
                messageType: "text",
                targetedPubkeys: [AGENT1_PUBKEY],
            });
            store.completeRal(AGENT2_PUBKEY, 1);

            // Agent3 builds messages - all non-self messages are "user"
            const ral = store.createRal(AGENT3_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT3_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user"); // Changed: all non-self = user
        });

        it("should keep tool-results immediately after tool-calls even when user message arrives mid-execution", async () => {
            // =====================================================================
            // BUG: User messages arriving mid-tool-execution break AI SDK validation
            // =====================================================================
            //
            // Scenario discovered via trace 2413268c9e906dab131772b7f081835b:
            // 1. Agent calls git commit tool (tool-call stored)
            // 2. User sends "review all the changes..." (user message stored)
            // 3. Tool completes (tool-result stored)
            //
            // Chronological storage order: [tool-call, user, tool-result]
            // AI SDK required order:       [tool-call, tool-result, user]
            //
            // The AI SDK's convertToLanguageModelPrompt() validates that every
            // tool-call is immediately followed by its result. When it encounters
            // the user message before the tool-result, it throws:
            // "Tool result is missing for tool call toolu_01AQ2GzT9o1DAa3mukVHrSpY"
            //
            // FIX: Defer non-tool messages while tool-calls are pending, then
            // flush them after all results arrive.
            // =====================================================================
            const ral = store.createRal(AGENT1_PUBKEY);

            // Tool call
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_mid_exec",
                    toolName: "Bash",
                    input: { command: "git commit" },
                }] as ToolCallPart[],
            });

            // User message arrives while tool is executing
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "please also check the branches",
                messageType: "text",
            });

            // Tool result arrives
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral,
                content: "",
                messageType: "tool-result",
                toolData: [{
                    type: "tool-result",
                    toolCallId: "call_mid_exec",
                    toolName: "Bash",
                    output: { type: "text", value: "commit success" },
                }] as ToolResultPart[],
            });

            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Should have 3 messages in correct order:
            // [tool-call, tool-result, user-message]
            expect(messages).toHaveLength(3);

            // First: tool-call (assistant role)
            expect(messages[0].role).toBe("assistant");
            const toolCallContent = messages[0].content as ToolCallPart[];
            expect(toolCallContent[0].type).toBe("tool-call");
            expect(toolCallContent[0].toolCallId).toBe("call_mid_exec");

            // Second: tool-result (tool role) - must immediately follow tool-call
            expect(messages[1].role).toBe("tool");
            const toolResultContent = messages[1].content as ToolResultPart[];
            expect(toolResultContent[0].type).toBe("tool-result");
            expect(toolResultContent[0].toolCallId).toBe("call_mid_exec");

            // Third: user message (user role) - deferred until after tool completes
            expect(messages[2].role).toBe("user");
            expect(messages[2].content).toContain("please also check the branches");
        });

        it("should add synthetic error results for orphaned tool-calls", async () => {
            // =====================================================================
            // BUG: Orphaned tool-calls from RAL interruption break AI SDK validation
            // =====================================================================
            //
            // Scenario discovered via trace 2da953abc7faba84d43b061fa77f4b1a:
            // 1. planning-coordinator agent calls delegate_followup tool
            // 2. A delegation completes, triggering "executor.aborted_for_injection"
            // 3. RAL is aborted while tool is still executing
            // 4. Tool completes in background (AI SDK telemetry shows result)
            // 5. But tool-did-execute handler never runs - stream already torn down
            // 6. Tool-call is stored in ConversationStore, but result is never stored
            // 7. When RAL resumes, the orphaned tool-call causes AI SDK validation to fail
            //
            // FIX: Detect orphaned tool-calls (those with no matching result) and
            // inject synthetic error results so the AI SDK validation passes.
            // The error message indicates the tool was interrupted, allowing the
            // LLM to understand what happened and potentially retry.
            // =====================================================================
            const ral = store.createRal(AGENT1_PUBKEY);

            // Tool call without result (simulating an aborted execution)
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral,
                content: "",
                messageType: "tool-call",
                toolData: [{
                    type: "tool-call",
                    toolCallId: "call_orphaned",
                    toolName: "delegate_followup",
                    input: { message: "test" },
                }] as ToolCallPart[],
            });

            // User message after (no tool-result ever stored)
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "what happened?",
                messageType: "text",
            });

            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            // Should have 3 messages: tool-call, synthetic tool-result, user-message
            expect(messages).toHaveLength(3);

            // First: tool-call
            expect(messages[0].role).toBe("assistant");

            // Second: synthetic tool-result
            expect(messages[1].role).toBe("tool");
            const syntheticResult = messages[1].content as ToolResultPart[];
            expect(syntheticResult[0].toolCallId).toBe("call_orphaned");
            expect(syntheticResult[0].output).toMatchObject({
                type: "text",
                value: expect.stringContaining("interrupted"),
            });

            // Third: user message
            expect(messages[2].role).toBe("user");
        });
    });

    describe("Injection Queue", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should add injection to queue", () => {
            store.createRal(AGENT1_PUBKEY);

            const injection: Injection = {
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "injected message",
                queuedAt: Date.now(),
            };

            store.addInjection(injection);

            const injections = store.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(injections).toHaveLength(1);
            expect(injections[0].content).toBe("injected message");
        });

        it("should consume injections and move to messages", () => {
            store.createRal(AGENT1_PUBKEY);

            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "injected message",
                queuedAt: Date.now(),
            });

            const consumed = store.consumeInjections(AGENT1_PUBKEY, 1);
            expect(consumed).toHaveLength(1);

            // Should be in messages now
            const messages = store.getAllMessages();
            expect(messages).toHaveLength(1);
            expect(messages[0].content).toBe("injected message");

            // Should not be in queue anymore
            const remaining = store.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(remaining).toHaveLength(0);
        });

        it("should only consume injections for target RAL", () => {
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);

            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "for RAL 1",
                queuedAt: Date.now(),
            });
            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 2 },
                role: "user",
                content: "for RAL 2",
                queuedAt: Date.now(),
            });

            const consumed = store.consumeInjections(AGENT1_PUBKEY, 1);
            expect(consumed).toHaveLength(1);
            expect(consumed[0].content).toBe("for RAL 1");

            // RAL 2 injection should still be pending
            const remaining = store.getPendingInjections(AGENT1_PUBKEY, 2);
            expect(remaining).toHaveLength(1);
        });
    });

    describe("Event ID Tracking", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should track event IDs", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
                eventId: "event-123",
            });

            expect(store.hasEventId("event-123")).toBe(true);
            expect(store.hasEventId("event-456")).toBe(false);
        });

        it("should allow setting event ID after message creation", () => {
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                ral: 1,
                content: "response",
                messageType: "text",
            });

            const messages = store.getAllMessages();
            const index = messages.length - 1;

            store.setEventId(index, "published-event-id");

            expect(store.hasEventId("published-event-id")).toBe(true);
            expect(messages[index].eventId).toBe("published-event-id");
        });

        it("should deduplicate messages by eventId", () => {
            // =====================================================================
            // BUG: Duplicate message insertion in delegation injection flow
            // =====================================================================
            //
            // When a user sends a message during a delegation (supervision/injection),
            // the message was inserted TWICE via different code paths:
            //
            // 1. Nostr Event Path (AgentDispatchService → ConversationStore.addEvent()):
            //    - Adds message WITH eventId
            //
            // 2. Injection Path (AgentExecutor → conversationStore.addMessage()):
            //    - Originally added message WITHOUT eventId (deduplication failed)
            //    - Now fixed to include eventId for proper deduplication
            //
            // The LLM would see the same message twice, causing confusion about
            // who sent the message.
            //
            // FIX: addMessage() now checks if eventId already exists and skips
            // the duplicate message, returning -1 to signal deduplication.
            // =====================================================================

            // First insert - Nostr event path
            const index1 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Quick update about the poems",
                messageType: "text",
                eventId: "nostr-event-abc123",
            });

            expect(index1).toBe(0);
            expect(store.getAllMessages()).toHaveLength(1);
            expect(store.hasEventId("nostr-event-abc123")).toBe(true);

            // Second insert - Injection path with same eventId
            // (after fix: injection path now includes eventId)
            const index2 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Quick update about the poems",
                messageType: "text",
                eventId: "nostr-event-abc123", // Same eventId
                senderPubkey: USER_PUBKEY, // Injection adds sender attribution
            });

            // Should be deduplicated - returns -1 and message is NOT added
            expect(index2).toBe(-1);
            expect(store.getAllMessages()).toHaveLength(1);
        });

        it("should allow messages without eventId (no deduplication)", () => {
            // Messages without eventId should always be added (backwards compatibility)
            const index1 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "First message",
                messageType: "text",
            });

            const index2 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Second message",
                messageType: "text",
            });

            expect(index1).toBe(0);
            expect(index2).toBe(1);
            expect(store.getAllMessages()).toHaveLength(2);
        });

        it("should allow messages with different eventIds", () => {
            const index1 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "First event",
                messageType: "text",
                eventId: "event-111",
            });

            const index2 = store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Second event",
                messageType: "text",
                eventId: "event-222",
            });

            expect(index1).toBe(0);
            expect(index2).toBe(1);
            expect(store.getAllMessages()).toHaveLength(2);
        });
    });

    describe("relocateToEnd", () => {
        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
        });

        it("should move existing entry to end and apply updates", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "user message",
                messageType: "text",
                eventId: "evt-1",
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                content: "tool call",
                messageType: "tool-call",
                ral: 1,
            });
            store.addMessage({
                pubkey: AGENT1_PUBKEY,
                content: "tool result",
                messageType: "tool-result",
                ral: 1,
            });

            const result = store.relocateToEnd("evt-1", {
                ral: 1,
                senderPubkey: USER_PUBKEY,
                senderPrincipal: {
                    id: "telegram:user:42",
                    transport: "telegram",
                    displayName: "Alice Telegram",
                },
                targetedPubkeys: [AGENT1_PUBKEY],
                targetedPrincipals: [{
                    id: `nostr:${AGENT1_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: AGENT1_PUBKEY,
                    displayName: "agent-one",
                }],
            });

            expect(result).toBe(true);

            const messages = store.getAllMessages();
            expect(messages).toHaveLength(3);

            // The user message should now be last
            const last = messages[2];
            expect(last.content).toBe("user message");
            expect(last.eventId).toBe("evt-1");
            expect(last.ral).toBe(1);
            expect(last.senderPubkey).toBe(USER_PUBKEY);
            expect(last.senderPrincipal?.displayName).toBe("Alice Telegram");
            expect(last.targetedPubkeys).toEqual([AGENT1_PUBKEY]);
            expect(last.targetedPrincipals?.[0]?.displayName).toBe("agent-one");

            // Tool messages should be first two
            expect(messages[0].messageType).toBe("tool-call");
            expect(messages[1].messageType).toBe("tool-result");
        });

        it("should preserve principal snapshots when storing event messages", () => {
            const fakeEnvelope = createMockInboundEnvelope({
                principal: {
                    id: USER_PUBKEY,
                    transport: "nostr",
                    linkedPubkey: USER_PUBKEY,
                    kind: "human",
                },
                message: {
                    id: "evt-principal-1",
                    transport: "nostr",
                    nativeId: "evt-principal-1",
                },
                content: "hello from telegram-linked user",
                occurredAt: 123,
                metadata: {
                    eventKind: NDKKind.Text,
                    eventTagCount: 1,
                    replyTargets: [],
                    articleReferences: [],
                    nudgeEventIds: [],
                    skillEventIds: [],
                },
                recipients: [{
                    id: `nostr:${AGENT1_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: AGENT1_PUBKEY,
                    kind: "agent",
                }],
            });

            store.addEnvelopeMessage(fakeEnvelope, false, {
                senderPrincipal: {
                    id: "telegram:user:55",
                    transport: "telegram",
                    linkedPubkey: USER_PUBKEY,
                    displayName: "Alice Telegram",
                },
                targetedPrincipals: [{
                    id: `nostr:${AGENT1_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: AGENT1_PUBKEY,
                    displayName: "agent-one",
                }],
            });

            const [message] = store.getAllMessages();
            expect(message.senderPrincipal?.id).toBe("telegram:user:55");
            expect(message.senderPrincipal?.displayName).toBe("Alice Telegram");
            expect(message.targetedPrincipals?.[0]?.id).toBe(`nostr:${AGENT1_PUBKEY}`);
            expect(message.targetedPrincipals?.[0]?.displayName).toBe("agent-one");
        });

        it("does not persist transport principal ids into pubkey for transport-only senders", () => {
            const fakeEnvelope = createMockInboundEnvelope({
                principal: {
                    id: "telegram:user:88",
                    transport: "telegram",
                    linkedPubkey: undefined,
                    kind: "human",
                },
                message: {
                    id: "evt-transport-user-1",
                    transport: "telegram",
                    nativeId: "evt-transport-user-1",
                },
                content: "hello from telegram-only user",
                occurredAt: 456,
                metadata: {
                    eventKind: NDKKind.Text,
                    eventTagCount: 1,
                    replyTargets: [],
                    articleReferences: [],
                    nudgeEventIds: [],
                    skillEventIds: [],
                },
                recipients: [{
                    id: `nostr:${AGENT1_PUBKEY}`,
                    transport: "nostr",
                    linkedPubkey: AGENT1_PUBKEY,
                    kind: "agent",
                }],
            });

            store.addEnvelopeMessage(fakeEnvelope, false, {
                senderPrincipal: {
                    id: "telegram:user:88",
                    transport: "telegram",
                    displayName: "Telegram User",
                },
            });

            const [message] = store.getAllMessages();
            expect(message.pubkey).toBe("");
            expect(message.senderPubkey).toBeUndefined();
            expect(message.senderPrincipal?.id).toBe("telegram:user:88");
            expect(message.senderPrincipal?.displayName).toBe("Telegram User");
            expect(store.getRootAuthorPubkey()).toBeUndefined();
            expect(store.getFirstUserMessage()?.senderPrincipal?.id).toBe("telegram:user:88");
        });

        it("should return false when eventId is not found", () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "hello",
                messageType: "text",
                eventId: "evt-1",
            });

            const result = store.relocateToEnd("nonexistent", { ral: 1 });
            expect(result).toBe(false);
            expect(store.getAllMessages()).toHaveLength(1);
        });
    });

    describe("Persistence", () => {
        it("should persist activeRal state", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            store.completeRal(AGENT1_PUBKEY, 1);
            await store.save();

            const store2 = new ConversationStore(testDir);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            expect(store2.getActiveRals(AGENT1_PUBKEY)).toEqual([2]);
            expect(store2.isRalActive(AGENT1_PUBKEY, 1)).toBe(false);
        });

        it("should persist injections", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.addInjection({
                targetRal: { pubkey: AGENT1_PUBKEY, ral: 1 },
                role: "user",
                content: "pending injection",
                queuedAt: 1234567890,
            });
            await store.save();

            const store2 = new ConversationStore(testDir);
            store2.load(PROJECT_ID, CONVERSATION_ID);

            const injections = store2.getPendingInjections(AGENT1_PUBKEY, 1);
            expect(injections).toHaveLength(1);
            expect(injections[0].content).toBe("pending injection");
        });

        it("should persist RAL number sequence", async () => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            store.createRal(AGENT1_PUBKEY);
            store.createRal(AGENT1_PUBKEY);
            await store.save();

            const store2 = new ConversationStore(testDir);
            store2.load(PROJECT_ID, CONVERSATION_ID);
            const nextRal = store2.createRal(AGENT1_PUBKEY);

            expect(nextRal).toBe(3);
        });
    });

    describe("Multi-Agent Attribution (computeAttributionPrefix)", () => {
        // Test the new computeAttributionPrefix system that replaced the old
        // [Note: Message from {name}] prefix. The new system uses 5 priority rules:
        // 1. Self → no prefix
        // 2. Non-text → no prefix
        // 3. Targeted elsewhere → routing prefix [@sender -> @recipient]
        // 4. Agent sender → attribution prefix [@sender]
        // 5. User sender → no prefix
        const OWNER_PUBKEY = "owner-pubkey";
        const INTERLOPER_PUBKEY = "interloper-pubkey";

        beforeEach(() => {
            // Reset agent registry to empty set to prevent inter-test leakage
            ConversationStore.initialize(testDir);
            store.load(PROJECT_ID, CONVERSATION_ID);
            mockGetNameSync.mockClear();
        });

        it("should NOT add attribution prefix when sender matches root author (non-agent user)", async () => {
            // User messages get no prefix regardless of senderPubkey
            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Initial message from owner",
                messageType: "text",
            });

            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Follow-up from owner",
                messageType: "text",
                senderPubkey: OWNER_PUBKEY,
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(2);
            expect(messages[0].content).toBe("Initial message from owner");
            expect(messages[1].content).toBe("Follow-up from owner");
        });

        it("should NOT add attribution for non-agent senderPubkey (user intervention)", async () => {
            // With the new system, non-agent senders (users) get no prefix
            // regardless of whether they differ from the conversation initiator
            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Initial message from owner",
                messageType: "text",
            });

            // Message injected by another user (interloper is not an agent)
            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Message from interloper",
                messageType: "text",
                senderPubkey: INTERLOPER_PUBKEY,
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(2);
            expect(messages[0].content).toBe("Initial message from owner");
            // Non-agent senderPubkey → Rule 5 → no prefix
            expect(messages[1].content).toBe("Message from interloper");
        });

        it("should NOT add attribution prefix when senderPubkey is not set", async () => {
            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Message one",
                messageType: "text",
            });

            store.addMessage({
                pubkey: INTERLOPER_PUBKEY,
                content: "Message two",
                messageType: "text",
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(2);
            expect(messages[0].content).toBe("Message one");
            expect(messages[1].content).toBe("Message two");
        });

        it("should add attribution prefix when sender is a known agent", async () => {
            // Register agents for this test (beforeEach resets to empty)
            ConversationStore.initialize(testDir, [AGENT1_PUBKEY, "agent2-pk"]);

            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Initial message",
                messageType: "text",
            });

            // Message from a known agent
            store.addMessage({
                pubkey: OWNER_PUBKEY,
                content: "Agent message",
                messageType: "text",
                senderPubkey: "agent2-pk",
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(2);
            // Agent senderPubkey → Rule 4 → attribution prefix
            const content = messages[1].content as string;
            expect(content).toContain("Agent message");
            expect(content).toMatch(/^\[@/); // Has attribution prefix
        });

        it("should handle empty conversation gracefully", async () => {
            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(0);
        });

        it("should not attribute user intervention (user is non-agent)", async () => {
            const DELEGATOR_PUBKEY = "agent1-pubkey-abc";
            const PROJECT_OWNER = "owner-pubkey";

            store.addMessage({
                pubkey: DELEGATOR_PUBKEY,
                content: "Please research this topic",
                messageType: "text",
            });

            // Project owner intervenes - not an agent, so no attribution prefix
            store.addMessage({
                pubkey: DELEGATOR_PUBKEY,
                content: "Actually, focus on the architecture",
                messageType: "text",
                senderPubkey: PROJECT_OWNER,
            });

            const ral = store.createRal(AGENT1_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT1_PUBKEY, ral);

            expect(messages).toHaveLength(2);
            expect(messages[0].content).toBe("Please research this topic");
            // User senderPubkey → Rule 5 → no prefix
            expect(messages[1].content).toBe("Actually, focus on the architecture");
        });
    });

    describe("Message Attribution Formatting (Multi-Agent)", () => {
        // These tests verify the new computeAttributionPrefix behavior:
        // - Self messages → no prefix
        // - User messages targeted to me → no prefix
        // - Agent messages targeted to me → [@agent] prefix
        // - Messages targeted elsewhere → [@sender -> @recipient] routing prefix
        // - User broadcasts → no prefix
        const TRANSPARENT_PK = "transparent-pk";
        const AGENT1_PK = "agent1-pk";
        const AGENT2_PK = "agent2-pk";
        const PABLO_PK = "pablo-pk";

        beforeEach(() => {
            store.load(PROJECT_ID, CONVERSATION_ID);
            // Register agents so ConversationStore knows they're agents
            ConversationStore.initialize("/test/project", [TRANSPARENT_PK, AGENT1_PK, AGENT2_PK]);
            mockGetName.mockClear();
        });

        it("should NOT add attribution prefix to own messages", async () => {
            // Transparent sends a message to Pablo - no prefix (self = Rule 1)
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Hello Pablo!",
                messageType: "text",
                targetedPubkeys: [PABLO_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("Hello Pablo!"); // No prefix (self)
        });

        it("should NOT add attribution prefix to own broadcast", async () => {
            // Transparent broadcasts (no recipient) - no prefix (self = Rule 1)
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Announcement to all",
                messageType: "text",
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("Announcement to all"); // No prefix (self)
        });

        it("should NOT add attribution prefix to user messages targeted to me", async () => {
            // Pablo sends message to Transparent - no prefix (user targeted to me = Rule 5)
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Hello Transparent!",
                messageType: "text",
                targetedPubkeys: [TRANSPARENT_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("Hello Transparent!"); // No prefix (user → me)
        });

        it("should add attribution prefix to agent-to-agent messages targeted to me", async () => {
            // Agent1 sends message to Transparent - attribution prefix (agent → me = Rule 4)
            store.addMessage({
                pubkey: AGENT1_PK,
                ral: 1,
                content: "Hey Transparent, can you help?",
                messageType: "text",
                targetedPubkeys: [TRANSPARENT_PK],
            });
            store.completeRal(AGENT1_PK, 1);
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            // Agent sender → Rule 4 → [@agent] attribution prefix
            const content = messages[0].content as string;
            expect(content).toContain("Hey Transparent, can you help?");
            expect(content).toMatch(/^\[@/); // Has attribution prefix
        });

        it("should add routing prefix to messages targeted elsewhere", async () => {
            // Pablo sends message to Agent1, Transparent is observing - routing prefix (Rule 3)
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Agent1, what color?",
                messageType: "text",
                targetedPubkeys: [AGENT1_PK],
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            // Targeted elsewhere → Rule 3 → routing prefix
            const content = messages[0].content as string;
            expect(content).toContain("Agent1, what color?");
            expect(content).toMatch(/^\[@.*->.*@/); // Has routing prefix
        });

        it("should NOT add attribution prefix to user broadcasts", async () => {
            // Pablo broadcasts to all agents - no prefix (user, no targeting = Rule 5)
            store.addMessage({
                pubkey: PABLO_PK,
                content: "Everyone, listen up!",
                messageType: "text",
            });
            store.ensureRalActive(TRANSPARENT_PK, 1);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 1);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("Everyone, listen up!"); // No prefix (user broadcast)
        });

        it("should exclude other active RAL messages from buildMessagesForRal", async () => {
            // Create active RAL with messages
            store.ensureRalActive(TRANSPARENT_PK, 1);
            store.addMessage({
                pubkey: TRANSPARENT_PK,
                ral: 1,
                content: "Working on task 1",
                messageType: "text",
            });

            // Create second RAL - should NOT see RAL 1 messages
            // (concurrent RAL context is added separately by AgentExecutor)
            store.ensureRalActive(TRANSPARENT_PK, 2);

            const messages = await store.buildMessagesForRal(TRANSPARENT_PK, 2);

            // No messages from other active RALs should be included
            expect(messages).toHaveLength(0);
        });
    });
});

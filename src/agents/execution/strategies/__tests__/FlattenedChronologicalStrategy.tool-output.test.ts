import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy, reconstructToolMessagesFromEvent } from "../FlattenedChronologicalStrategy";
import "./test-mocks";

/**
 * Test that tool outputs from previous agent turns are included in subsequent prompts.
 * This ensures agents can reference the results of their own tool calls.
 */
describe("FlattenedChronologicalStrategy - Tool Output in Subsequent Chats", () => {
    const USER_PUBKEY = "user-pubkey-123";
    const AGENT_PUBKEY = "agent-a-pubkey-456";
    const CONVERSATION_ID = "test-conversation-tools";

    describe("reconstructToolMessagesFromEvent", () => {
        it("reconstructs tool-call and tool-result messages from a tool event", () => {
            const toolEvent = new NDKEvent();
            toolEvent.id = "tool-event-abc123def456";
            toolEvent.pubkey = AGENT_PUBKEY;
            toolEvent.content = JSON.stringify({
                tool: "project_list",
                input: {},
                output: { projects: [{ title: "Olas" }, { title: "TENEX" }] },
            });
            toolEvent.kind = 1111;
            toolEvent.created_at = 1001;
            toolEvent.tags = [["tool", "project_list"]];
            toolEvent.sig = "sig";

            const messages = reconstructToolMessagesFromEvent(toolEvent);

            expect(messages).not.toBeNull();
            expect(messages).toHaveLength(2);

            // First message should be assistant with tool-call
            const toolCallMsg = messages![0];
            expect(toolCallMsg.role).toBe("assistant");
            expect(toolCallMsg.content).toBeArrayOfSize(1);
            expect((toolCallMsg.content as any[])[0].type).toBe("tool-call");
            expect((toolCallMsg.content as any[])[0].toolName).toBe("project_list");

            // Second message should be tool with tool-result
            const toolResultMsg = messages![1];
            expect(toolResultMsg.role).toBe("tool");
            expect(toolResultMsg.content).toBeArrayOfSize(1);
            expect((toolResultMsg.content as any[])[0].type).toBe("tool-result");
            expect((toolResultMsg.content as any[])[0].output.value).toContain("Olas");
        });

        it("returns null for invalid tool event content", () => {
            const badEvent = new NDKEvent();
            badEvent.id = "bad-event-123";
            badEvent.content = "not json";
            badEvent.sig = "sig";

            const result = reconstructToolMessagesFromEvent(badEvent);
            expect(result).toBeNull();
        });

        it("returns null when tool name is missing", () => {
            const badEvent = new NDKEvent();
            badEvent.id = "bad-event-456";
            badEvent.content = JSON.stringify({ input: {}, output: "result" });
            badEvent.sig = "sig";

            const result = reconstructToolMessagesFromEvent(badEvent);
            expect(result).toBeNull();
        });
    });

    describe("buildMessages with tool events", () => {
        let events: NDKEvent[];
        let strategy: FlattenedChronologicalStrategy;
        let mockContext: ExecutionContext;
        let mockConversation: Conversation;

        beforeAll(async () => {
            // Conversation flow:
            // 1. User asks agent to list projects
            // 2. Agent calls project_list tool (published as tool event)
            // 3. User asks follow-up question about the tool results
            events = [];

            // Event 1: User asks agent to list projects
            const event1 = new NDKEvent();
            event1.id = "event-1-user-request";
            event1.pubkey = USER_PUBKEY;
            event1.content = "run project_list";
            event1.kind = 11;
            event1.created_at = 1000;
            event1.tags = [["p", AGENT_PUBKEY]];
            event1.sig = "sig1";
            events.push(event1);

            // Event 2: Agent's tool execution (published tool event)
            const event2 = new NDKEvent();
            event2.id = "event-2-tool-execution";
            event2.pubkey = AGENT_PUBKEY;
            event2.content = JSON.stringify({
                tool: "project_list",
                input: {},
                output: {
                    projects: [
                        { title: "Olas Monorepo", id: "olas-1" },
                        { title: "Olas iOS", id: "olas-2" },
                        { title: "TENEX Backend", id: "tenex-1" },
                    ],
                },
            });
            event2.kind = 1111;
            event2.created_at = 1001;
            event2.tags = [
                ["e", event1.id],
                ["E", event1.id],
                ["tool", "project_list"],
            ];
            event2.sig = "sig2";
            events.push(event2);

            // Event 3: User asks follow-up about tool results
            const event3 = new NDKEvent();
            event3.id = "event-3-user-followup";
            event3.pubkey = USER_PUBKEY;
            event3.content = "How many projects have 'Olas' in the name? Answer with just a number.";
            event3.kind = 1111;
            event3.created_at = 1002;
            event3.tags = [
                ["e", event2.id],
                ["E", event1.id],
                ["p", AGENT_PUBKEY],
            ];
            event3.sig = "sig3";
            events.push(event3);

            mockConversation = {
                id: CONVERSATION_ID,
                history: events,
                participants: new Set([USER_PUBKEY, AGENT_PUBKEY]),
                agentStates: new Map(),
                agentTodos: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            strategy = new FlattenedChronologicalStrategy();

            const agent: AgentInstance = {
                name: "Agent A",
                slug: "agent-a",
                pubkey: AGENT_PUBKEY,
                role: "assistant",
                instructions: "Test Agent",
                tools: [],
            };

            const threadService = new ThreadService();

            mockContext = {
                agent,
                conversationId: CONVERSATION_ID,
                projectPath: "/test/path",
                triggeringEvent: event3, // Agent responding to follow-up question
                conversationCoordinator: { threadService } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;
        });

        it("includes tool-call and tool-result messages from previous tool execution", async () => {
            const messages = await strategy.buildMessages(mockContext, events[2]);

            // Find tool-related messages
            const assistantMessages = messages.filter((m) => m.role === "assistant");
            const toolMessages = messages.filter((m) => m.role === "tool");

            // Should have at least one assistant message with tool-call
            const hasToolCall = assistantMessages.some((m) => {
                if (!Array.isArray(m.content)) return false;
                return m.content.some((c: any) => c.type === "tool-call" && c.toolName === "project_list");
            });
            expect(hasToolCall).toBe(true);

            // Should have at least one tool message with tool-result
            const hasToolResult = toolMessages.some((m) => {
                if (!Array.isArray(m.content)) return false;
                return m.content.some((c: any) => c.type === "tool-result" && c.toolName === "project_list");
            });
            expect(hasToolResult).toBe(true);
        });

        it("tool result contains the actual output data", async () => {
            const messages = await strategy.buildMessages(mockContext, events[2]);

            // Find the tool result message
            const toolMessage = messages.find((m) => {
                if (m.role !== "tool" || !Array.isArray(m.content)) return false;
                return m.content.some((c: any) => c.type === "tool-result");
            });

            expect(toolMessage).toBeDefined();
            const toolResult = (toolMessage!.content as any[]).find((c) => c.type === "tool-result");
            expect(toolResult.output.value).toContain("Olas");
            expect(toolResult.output.value).toContain("TENEX");
        });

        it("includes the follow-up user message after tool messages", async () => {
            const messages = await strategy.buildMessages(mockContext, events[2]);

            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Should include the follow-up question
            const hasFollowUp = messageContents.some((c) => c.includes("How many projects"));
            expect(hasFollowUp).toBe(true);
        });

        it("maintains correct message order: tool-call before tool-result before follow-up", async () => {
            const messages = await strategy.buildMessages(mockContext, events[2]);

            // Find indices
            let toolCallIndex = -1;
            let toolResultIndex = -1;
            let followUpIndex = -1;

            messages.forEach((m, i) => {
                if (m.role === "assistant" && Array.isArray(m.content)) {
                    if (m.content.some((c: any) => c.type === "tool-call")) {
                        toolCallIndex = i;
                    }
                }
                if (m.role === "tool" && Array.isArray(m.content)) {
                    if (m.content.some((c: any) => c.type === "tool-result")) {
                        toolResultIndex = i;
                    }
                }
                if (m.role === "user") {
                    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                    if (content.includes("How many projects")) {
                        followUpIndex = i;
                    }
                }
            });

            // All should be present
            expect(toolCallIndex).toBeGreaterThanOrEqual(0);
            expect(toolResultIndex).toBeGreaterThanOrEqual(0);
            expect(followUpIndex).toBeGreaterThanOrEqual(0);

            // Order should be: tool-call, then tool-result, then follow-up
            expect(toolCallIndex).toBeLessThan(toolResultIndex);
            expect(toolResultIndex).toBeLessThan(followUpIndex);
        });
    });
});

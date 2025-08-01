import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ReasonActLoop } from "../ReasonActLoop";
import type { LLMService, StreamEvent } from "@/llm/types";
import type { Agent } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import { Message } from "multi-llm-ts";

describe("ReasonActLoop - Orchestrator Reminder", () => {
    let reasonActLoop: ReasonActLoop;
    let mockLLMService: LLMService;
    let mockAgent: Agent;
    let mockConversation: Conversation;
    let streamMock: any;

    beforeEach(() => {
        streamMock = mock();
        
        mockLLMService = {
            stream: streamMock,
        } as unknown as LLMService;

        mockAgent = {
            name: "orchestrator",
            pubkey: "orchestrator-pubkey",
            isOrchestrator: true,
            description: "Test orchestrator",
            prompt: "Test prompt",
        };

        mockConversation = {
            id: "test-conversation",
            history: [
                {
                    pubkey: "orchestrator-pubkey",
                    content: "test",
                    createdAt: new Date(),
                },
            ],
            metadata: {},
        } as unknown as Conversation;

        reasonActLoop = new ReasonActLoop(mockLLMService);
    });

    it("should remind orchestrator to use continue in non-chat/brainstorm phases", async () => {
        const messages = [new Message("user", "What's the status?")];

        // First call returns content without terminal tools
        const firstStream: AsyncIterable<StreamEvent> = {
            async *[Symbol.asyncIterator]() {
                yield { type: "content", content: "Here's the status update." };
                yield {
                    type: "done",
                    response: { type: "text", content: "Here's the status update.", toolCalls: [] },
                };
            },
        };

        // Second call (reminder) should use continue
        const reminderStream: AsyncIterable<StreamEvent> = {
            async *[Symbol.asyncIterator]() {
                yield { type: "content", content: "I'll route this to the appropriate agent." };
                yield {
                    type: "tool_complete",
                    tool: "continue",
                    result: {
                        __typedResult: {
                            success: true,
                            duration: 10,
                            data: {
                                output: {
                                    type: "continue",
                                    routing: {
                                        agents: ["executor"],
                                        phase: "execute",
                                        reason: "Need to check implementation",
                                        messageToAgents:
                                            "@executor, check the implementation status",
                                    },
                                },
                            },
                        },
                    },
                };
                yield {
                    type: "done",
                    response: {
                        type: "text",
                        content: "I'll route this to the appropriate agent.",
                        toolCalls: [],
                    },
                };
            },
        };

        // Set up the mock to return different streams on consecutive calls
        let callCount = 0;
        streamMock.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return firstStream;
            } else {
                return reminderStream;
            }
        });

        const context = {
            projectPath: "/test",
            conversationId: "test-conversation",
            agent: mockAgent,
            conversation: mockConversation,
            phase: "execute",
            publisher: {
                publishAgentMessage: mock(() => Promise.resolve()),
                publishToolComplete: mock(() => Promise.resolve()),
            },
            conversationManager: {
                updateAgentContext: mock(() => Promise.resolve()),
            },
        };

        const result = await reasonActLoop.execute(messages, context as any, {});

        // Should have called stream twice
        expect(streamMock).toHaveBeenCalledTimes(2);

        // Second call should have the reminder
        const secondCallMessages = streamMock.mock.calls[1][0];
        const assistantMessage = secondCallMessages.find((m: Message) => m.role === "assistant");
        expect(assistantMessage?.content).toContain("continue");

        // Result should be from the continue tool
        expect(result.type).toBe("continue");
    });

    it("should not remind if phase is chat or brainstorm", async () => {
        const messages = [new Message("user", "Let's brainstorm")];

        const stream: AsyncIterable<StreamEvent> = {
            async *[Symbol.asyncIterator]() {
                yield { type: "content", content: "Great idea! Let's explore..." };
                yield {
                    type: "done",
                    response: { type: "text", content: "Great idea! Let's explore...", toolCalls: [] },
                };
            },
        };

        streamMock.mockReturnValue(stream);

        const context = {
            projectPath: "/test",
            conversationId: "test-conversation",
            agent: mockAgent,
            conversation: mockConversation,
            phase: "chat", // Chat phase - no reminder needed
            publisher: {
                publishAgentMessage: mock(() => Promise.resolve()),
            },
            conversationManager: {
                updateAgentContext: mock(() => Promise.resolve()),
            },
        };

        const result = await reasonActLoop.execute(messages, context as any, {});

        // Should only call stream once (no reminder)
        expect(streamMock).toHaveBeenCalledTimes(1);
    });
});
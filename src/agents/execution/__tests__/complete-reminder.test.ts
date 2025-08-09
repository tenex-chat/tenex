import { describe, expect, it, mock, beforeEach } from "bun:test";
import { ReasonActLoop } from "../ReasonActLoop";
import type { LLMService, StreamEvent } from "@/llm/types";
import type { AgentInstance } from "@/agents/types";
import { Message } from "multi-llm-ts";
import { PHASES } from "@/conversations/phases";

describe("ReasonActLoop complete() reminder", () => {
    let mockLLMService: LLMService;
    let reasonActLoop: ReasonActLoop;

    beforeEach(() => {
        // Create a mock LLM service
        mockLLMService = {
            complete: mock(),
            stream: mock(),
        } as unknown as LLMService;

        reasonActLoop = new ReasonActLoop(mockLLMService);
    });

    it("should remind non-orchestrator agents to call complete() if they don't", async () => {
        // Mock the initial stream response (no complete tool call)
        const initialStream = async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "content", content: "I have finished the task successfully." };
            yield {
                type: "done",
                response: {
                    type: "text",
                    content: "I have finished the task successfully.",
                    toolCalls: [],
                },
            };
        };

        // Mock the reminder stream response (with complete tool call)
        const reminderStream = async function* (): AsyncGenerator<StreamEvent> {
            yield {
                type: "tool_start",
                tool: "complete",
                args: { response: "Task completed", summary: "Successfully finished" },
            };
            yield {
                type: "tool_complete",
                tool: "complete",
                result: {
                    __typedResult: {
                        success: true,
                        duration: 100,
                        data: {
                            output: {
                                type: "complete",
                                completion: {
                                    response: "Task completed",
                                    summary: "Successfully finished",
                                    nextAgent: "orchestrator-pubkey",
                                },
                            },
                        },
                    },
                },
            };
            yield { type: "done", response: { type: "text", content: "", toolCalls: [] } };
        };

        // Set up the mock to return different streams
        let callCount = 0;
        (mockLLMService.stream as any).mockImplementation(() => {
            callCount++;
            return callCount === 1 ? initialStream() : reminderStream();
        });

        // Create a non-orchestrator agent context
        const context = {
            projectPath: "/test",
            conversationId: "test-convo",
            phase: PHASES.EXECUTE,
            llmConfig: "test-config",
            agent: {
                name: "Test Agent",
                isOrchestrator: false,
            } as Agent,
            conversation: { id: "test-convo", history: [] } as any,
        };

        const messages = [new Message("user", "Please complete this task")];

        // Execute the streaming
        const events: StreamEvent[] = [];
        const generator = reasonActLoop.executeStreaming(
            context,
            messages,
            { conversationId: "test-convo" } as any,
            undefined,
            []
        );

        for await (const event of generator) {
            events.push(event);
        }

        // Verify that the LLM was called twice
        expect(mockLLMService.stream).toHaveBeenCalledTimes(2);

        // Verify the second call included the reminder message
        const secondCall = (mockLLMService.stream as any).mock.calls[1];
        const reminderMessages = secondCall[0].messages;
        expect(reminderMessages[reminderMessages.length - 1].content).toContain(
            "you haven't used the 'complete' tool yet"
        );
    });

    it("should not remind orchestrator agents in chat phase", async () => {
        // Mock stream response for orchestrator
        const stream = async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "content", content: "I'd be happy to help you with that task." };
            yield {
                type: "done",
                response: {
                    type: "text",
                    content: "I'd be happy to help you with that task.",
                    toolCalls: [],
                },
            };
        };

        (mockLLMService.stream as any).mockReturnValue(stream());

        // Create an orchestrator agent context in CHAT phase
        const context = {
            projectPath: "/test",
            conversationId: "test-convo",
            phase: PHASES.CHAT, // Chat phase - no reminder expected
            llmConfig: "test-config",
            agent: {
                name: "Orchestrator",
                isOrchestrator: true,
            } as Agent,
            conversation: { id: "test-convo", history: [] } as any,
        };

        const messages = [new Message("user", "What can you help me with?")];

        // Execute the streaming
        const generator = reasonActLoop.executeStreaming(
            context,
            messages,
            { conversationId: "test-convo" } as any,
            undefined,
            []
        );

        for await (const event of generator) {
            // consume events
        }

        // Verify that the LLM was only called once (no reminder)
        expect(mockLLMService.stream).toHaveBeenCalledTimes(1);
    });

    it("should auto-complete if agent ignores reminder (stubborn agent)", async () => {
        // Mock the initial stream response (no complete tool call)
        const initialStream = async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "content", content: "I have finished the task successfully." };
            yield {
                type: "done",
                response: {
                    type: "text",
                    content: "I have finished the task successfully.",
                    toolCalls: [],
                },
            };
        };

        // Mock the reminder stream response (still no complete tool call - stubborn agent)
        const stubbornStream = async function* (): AsyncGenerator<StreamEvent> {
            yield {
                type: "content",
                content: "Oh, I understand, but I already finished the task.",
            };
            yield {
                type: "done",
                response: {
                    type: "text",
                    content: "Oh, I understand, but I already finished the task.",
                    toolCalls: [],
                },
            };
        };

        // Set up the mock to return different streams
        let callCount = 0;
        (mockLLMService.stream as any).mockImplementation(() => {
            callCount++;
            return callCount === 1 ? initialStream() : stubbornStream();
        });

        // Create a non-orchestrator agent context
        const context = {
            projectPath: "/test",
            conversationId: "test-convo",
            phase: PHASES.EXECUTE,
            llmConfig: "test-config",
            agent: {
                name: "Stubborn Agent",
                isOrchestrator: false,
            } as Agent,
            conversation: { id: "test-convo", history: [{ pubkey: "orchestrator-pubkey" }] } as any,
        };

        const messages = [new Message("user", "Please complete this task")];

        // Execute the streaming
        const events: StreamEvent[] = [];
        const generator = reasonActLoop.executeStreaming(
            context,
            messages,
            { conversationId: "test-convo" } as any,
            undefined,
            []
        );

        let doneEvent;
        for await (const event of generator) {
            events.push(event);
            if (event.type === "done") {
                doneEvent = event;
            }
        }

        // Verify that the LLM was called twice
        expect(mockLLMService.stream).toHaveBeenCalledTimes(2);

        // Verify that auto-completion was triggered
        expect(doneEvent).toBeDefined();
        const termination = (doneEvent as any).termination;
        expect(termination).toBeDefined();
        expect(termination?.type).toBe("complete");
        expect(termination?.completion.summary).toContain("Auto-completed by system");
    });

    it("should not remind if agent already called complete()", async () => {
        // Mock stream response with complete tool call
        const stream = async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "content", content: "Task finished." };
            yield { type: "tool_start", tool: "complete", args: { response: "Done" } };
            yield {
                type: "tool_complete",
                tool: "complete",
                result: {
                    __typedResult: {
                        success: true,
                        duration: 100,
                        data: {
                            output: {
                                type: "complete",
                                completion: {
                                    response: "Done",
                                    summary: "Task complete",
                                    nextAgent: "orchestrator-pubkey",
                                },
                            },
                        },
                    },
                },
            };
            yield {
                type: "done",
                response: { type: "text", content: "Task finished.", toolCalls: [] },
            };
        };

        (mockLLMService.stream as any).mockReturnValue(stream());

        // Create a non-orchestrator agent context
        const context = {
            projectPath: "/test",
            conversationId: "test-convo",
            phase: PHASES.EXECUTE,
            llmConfig: "test-config",
            agent: {
                name: "Test Agent",
                isOrchestrator: false,
            } as Agent,
            conversation: { id: "test-convo", history: [] } as any,
        };

        const messages = [new Message("user", "Please complete this task")];

        // Execute the streaming
        const generator = reasonActLoop.executeStreaming(
            context,
            messages,
            { conversationId: "test-convo" } as any,
            undefined,
            []
        );

        for await (const event of generator) {
            // consume events
        }

        // Verify that the LLM was only called once (no reminder needed)
        expect(mockLLMService.stream).toHaveBeenCalledTimes(1);
    });
});

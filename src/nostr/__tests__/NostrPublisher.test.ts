import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { NDKEvent, NDKTag } from "@nostr-dev-kit/ndk";
import { NostrPublisher, type NostrPublisherContext, type ResponseOptions } from "../NostrPublisher";
import type { Agent } from "@/agents/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { Conversation } from "@/conversations/types";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import * as ndkClient from "@/nostr/ndkClient";
import * as services from "@/services";
import { logger } from "@/utils/logger";
import { Message } from "multi-llm-ts";
import { EVENT_KINDS } from "@/llm/types";

// Mock NDKEvent at module level
const createMockNDKEvent = () => {
    const event = {
        id: "mock-event-id",
        kind: 1,
        content: "",
        tags: [] as NDKTag[],
        created_at: Math.floor(Date.now() / 1000),
        tag: mock((tag: NDKTag) => {
            event.tags.push(tag);
        }),
        removeTag: mock((tagName: string) => {
            event.tags = event.tags.filter(tag => tag[0] !== tagName);
        }),
        sign: mock(() => Promise.resolve()),
        publish: mock(() => Promise.resolve()),
    };
    return event;
};

// Keep track of created events
let currentMockEvent = createMockNDKEvent();

// Mock NDKEvent constructor
mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: mock(() => {
        currentMockEvent = createMockNDKEvent();
        return currentMockEvent;
    }),
}));

// Mock TypingIndicatorManager
mock.module("../TypingIndicatorManager", () => ({
    TypingIndicatorManager: mock(() => ({
        cleanup: mock(() => {}),
        startTyping: mock(() => Promise.resolve()),
        stopTyping: mock(() => Promise.resolve()),
    })),
}));

describe("NostrPublisher", () => {
    let publisher: NostrPublisher;
    let mockContext: NostrPublisherContext;
    let mockAgent: Agent;
    let mockConversationManager: ConversationManager;
    let mockConversation: Conversation;
    let mockTriggeringEvent: NDKEvent;
    let mockProjectContext: any;
    let loggerDebugSpy: any;
    let loggerErrorSpy: any;

    beforeEach(() => {
        // Reset the current mock event before each test
        currentMockEvent = createMockNDKEvent();

        // Setup mock conversation
        mockConversation = {
            id: "conv-123",
            phase: "CHAT",
            agentHistory: [],
            context: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                currentSessionStart: null,
                sessions: [],
            },
        } as Conversation;

        // Setup mock conversation manager
        mockConversationManager = {
            getConversation: mock(() => mockConversation),
            addMessageToContext: mock(() => Promise.resolve()),
            saveConversation: mock(() => Promise.resolve()),
        } as unknown as ConversationManager;

        // Setup mock agent
        mockAgent = {
            name: "TestAgent",
            slug: "test-agent",
            signer: {
                sign: mock(() => Promise.resolve("mock-signature")),
                pubkey: mock(() => "mock-agent-pubkey"),
            },
        } as unknown as Agent;

        // Setup mock triggering event
        mockTriggeringEvent = {
            id: "trigger-event-123",
            pubkey: "user-pubkey",
            content: "Test triggering event content that is long enough to be substring",
            tag: mock(() => ["a", "30311:project-pubkey:test-project"]),
            tagValue: mock((tag: string) => tag === "E" ? null : undefined),
            reply: mock(() => createMockNDKEvent()),
        } as unknown as NDKEvent;

        // Setup mock project context
        mockProjectContext = {
            project: {
                name: "test-project",
                pubkey: "project-pubkey",
                kind: 30311,
            },
        };

        // Mock getProjectContext
        spyOn(services, "getProjectContext").mockReturnValue(mockProjectContext);

        // Mock getNDK
        spyOn(ndkClient, "getNDK").mockReturnValue({} as any);

        // Spy on logger methods
        loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});

        // Setup context
        mockContext = {
            conversationId: "conv-123",
            agent: mockAgent,
            triggeringEvent: mockTriggeringEvent,
            conversationManager: mockConversationManager,
        };

        // Create publisher instance
        publisher = new NostrPublisher(mockContext);
    });

    afterEach(() => {
        mock.restore();
    });

    describe("cleanup", () => {
        it("should cleanup typing indicator manager", () => {
            const typingManagerCleanupSpy = spyOn((publisher as any).typingIndicatorManager, "cleanup");
            
            publisher.cleanup();
            
            expect(typingManagerCleanupSpy).toHaveBeenCalled();
        });
    });

    describe("publishResponse", () => {
        it("should publish a basic response successfully", async () => {
            const options: ResponseOptions = {
                content: "This is a test response",
            };

            const result = await publisher.publishResponse(options);

            // Verify the event was created correctly
            expect(result.content).toBe("This is a test response");
            expect(result.sign).toHaveBeenCalledWith(mockAgent.signer);
            expect(result.publish).toHaveBeenCalled();

            // Verify conversation was updated
            expect(mockConversationManager.addMessageToContext).toHaveBeenCalledWith(
                "conv-123",
                "test-agent",
                expect.any(Message)
            );
            expect(mockConversationManager.saveConversation).toHaveBeenCalledWith("conv-123");

            // Verify logging - check both metadata and published response logs
            const debugCalls = loggerDebugSpy.mock.calls;
            const publishedCall = debugCalls.find((call: any[]) => 
                call[0] === "Published agent response"
            );
            expect(publishedCall).toBeDefined();
            expect(publishedCall[1]).toMatchObject({
                eventId: "mock-event-id",
                contentLength: 23,
                agent: "TestAgent",
                phase: "CHAT",
            });
        });

        it("should add LLM metadata when provided", async () => {
            const options: ResponseOptions = {
                content: "Test response",
                llmMetadata: {
                    model: "gpt-4",
                    provider: "openai",
                    cost: 0.05,
                    promptTokens: 100,
                    completionTokens: 50,
                    totalTokens: 150,
                    inputTokens: 100,
                    outputTokens: 50,
                },
            };

            const result = await publisher.publishResponse(options);

            // Verify LLM metadata tags were added
            expect(result.tags).toContainEqual(["llm-model", "gpt-4"]);
            expect(result.tags).toContainEqual(["llm-cost-usd", "0.05"]);
            expect(result.tags).toContainEqual(["llm-prompt-tokens", "100"]);
            expect(result.tags).toContainEqual(["llm-completion-tokens", "50"]);
            expect(result.tags).toContainEqual(["llm-total-tokens", "150"]);
        });

        it("should add routing metadata when continue metadata is provided", async () => {
            const options: ResponseOptions = {
                content: "Continuing to next phase",
                continueMetadata: {
                    type: "continue",
                    routing: {
                        phase: "PLAN",
                        agents: ["agent1"],
                        reason: "Moving to planning phase",
                        context: {
                            summary: "Task requires planning",
                        },
                    },
                },
            };

            const result = await publisher.publishResponse(options);

            // Verify routing metadata was added
            expect(result.tags).toContainEqual(["new-phase", "PLAN"]);
            expect(result.tags).toContainEqual(["phase-from", "CHAT"]);
            expect(result.tags).toContainEqual(["routing-reason", "Moving to planning phase"]);
            expect(result.tags).toContainEqual(["routing-summary", "Task requires planning"]);
            expect(result.tags).toContainEqual(["routing-agents", "agent1"]);
        });

        it("should add destination pubkeys when provided", async () => {
            const options: ResponseOptions = {
                content: "Test response",
                destinationPubkeys: ["pubkey1", "pubkey2", "pubkey3"],
            };

            const result = await publisher.publishResponse(options);

            // Verify p-tags were added
            expect(result.tags).toContainEqual(["p", "pubkey1"]);
            expect(result.tags).toContainEqual(["p", "pubkey2"]);
            expect(result.tags).toContainEqual(["p", "pubkey3"]);
        });

        it("should add additional tags when provided", async () => {
            const options: ResponseOptions = {
                content: "Test response",
                additionalTags: [
                    ["custom", "tag1"],
                    ["another", "tag2", "with", "extra"],
                ],
            };

            const result = await publisher.publishResponse(options);

            // Verify additional tags were added
            expect(result.tags).toContainEqual(["custom", "tag1"]);
            expect(result.tags).toContainEqual(["another", "tag2", "with", "extra"]);
        });

        it("should handle errors during message context update", async () => {
            const error = new Error("Failed to update context");
            mockConversationManager.addMessageToContext = mock(() => Promise.reject(error));

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow("Failed to update context");

            // Verify event was not published
            expect(currentMockEvent.publish).not.toHaveBeenCalled();

            // Verify error was logged
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to publish response",
                expect.objectContaining({
                    agent: "TestAgent",
                    error: "Failed to update context",
                })
            );
        });

        it("should handle errors during conversation save", async () => {
            const error = new Error("Failed to save conversation");
            mockConversationManager.saveConversation = mock(() => Promise.reject(error));

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow("Failed to save conversation");

            // Verify event was not published
            expect(currentMockEvent.publish).not.toHaveBeenCalled();

            // Verify message was added to context
            expect(mockConversationManager.addMessageToContext).toHaveBeenCalled();
        });

        it("should handle errors during event signing", async () => {
            const error = new Error("Signing failed");
            
            // Override the reply method to return an event with failing sign
            mockTriggeringEvent.reply = mock(() => {
                const failingEvent = createMockNDKEvent();
                failingEvent.sign = mock(() => Promise.reject(error));
                return failingEvent;
            });

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow("Signing failed");

            // Verify conversation was saved before the failure
            expect(mockConversationManager.saveConversation).toHaveBeenCalled();
        });

        it("should handle errors during event publishing", async () => {
            const error = new Error("Publishing failed");
            
            // Override the reply method to return an event with failing publish
            mockTriggeringEvent.reply = mock(() => {
                const failingEvent = createMockNDKEvent();
                failingEvent.publish = mock(() => Promise.reject(error));
                return failingEvent;
            });

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow("Publishing failed");

            // Verify conversation was saved before the failure
            expect(mockConversationManager.saveConversation).toHaveBeenCalled();
        });

        it("should handle missing conversation", async () => {
            mockConversationManager.getConversation = mock(() => null);

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow(
                "Conversation not found in ConversationManager: conv-123"
            );
        });
    });

    describe("publishError", () => {
        it("should publish error notification successfully", async () => {
            const errorMessage = "Something went wrong";

            const result = await publisher.publishError(errorMessage);

            expect(result.content).toBe(errorMessage);
            expect(result.tags).toContainEqual(["error", "system"]);
            expect(result.sign).toHaveBeenCalledWith(mockAgent.signer);
            expect(result.publish).toHaveBeenCalled();

            expect(loggerDebugSpy).toHaveBeenCalledWith(
                "Published error notification",
                expect.objectContaining({
                    eventId: "mock-event-id",
                    error: errorMessage,
                    agent: "TestAgent",
                })
            );
        });

        it("should handle errors during error publishing", async () => {
            const publishError = new Error("Network error");
            
            // Override reply to return an event with failing publish
            mockTriggeringEvent.reply = mock(() => {
                const failingEvent = createMockNDKEvent();
                failingEvent.publish = mock(() => Promise.reject(publishError));
                return failingEvent;
            });

            await expect(publisher.publishError("Test error")).rejects.toThrow("Network error");

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to publish error",
                expect.objectContaining({
                    agent: "TestAgent",
                    error: "Network error",
                })
            );
        });
    });

    describe("publishTenexLog", () => {
        it("should publish TENEX log successfully", async () => {
            const logData = {
                event: "test_event",
                agent: "TestAgent",
                details: {
                    action: "test_action",
                    value: 123,
                },
                timestamp: 1234567890,
            };

            const result = await publisher.publishTenexLog(logData);

            expect(result.kind).toBe(EVENT_KINDS.TENEX_LOG);
            expect(result.created_at).toBe(1234567890);
            
            const content = JSON.parse(result.content);
            expect(content).toEqual({
                event: "test_event",
                agent: "TestAgent",
                details: {
                    action: "test_action",
                    value: 123,
                },
                timestamp: 1234567890,
            });

            expect(result.tags).toContainEqual(["tenex-event", "test_event"]);
            expect(result.tags).toContainEqual(["tenex-agent", "TestAgent"]);
        });

        it("should use current timestamp if not provided", async () => {
            const logData = {
                event: "test_event",
                agent: "TestAgent",
                details: {},
            };

            const beforeTime = Math.floor(Date.now() / 1000);
            const result = await publisher.publishTenexLog(logData);
            const afterTime = Math.floor(Date.now() / 1000);

            expect(result.created_at).toBeGreaterThanOrEqual(beforeTime);
            expect(result.created_at).toBeLessThanOrEqual(afterTime);
        });

        it("should handle complex details object", async () => {
            const logData = {
                event: "complex_event",
                agent: "TestAgent",
                details: {
                    nested: {
                        deeply: {
                            value: "test",
                        },
                    },
                    array: [1, 2, 3],
                    boolean: true,
                    null: null,
                },
            };

            const result = await publisher.publishTenexLog(logData);
            const content = JSON.parse(result.content);

            expect(content.details).toEqual(logData.details);
        });

        it("should handle publishing errors", async () => {
            const publishError = new Error("Failed to publish log");
            
            // Mock NDKEvent constructor to return event with failing publish
            const NDKEvent = (await import("@nostr-dev-kit/ndk")).NDKEvent as any;
            NDKEvent.mockImplementationOnce(() => {
                const failingEvent = createMockNDKEvent();
                failingEvent.publish = mock(() => Promise.reject(publishError));
                return failingEvent;
            });

            const logData = {
                event: "test_event",
                agent: "TestAgent",
                details: {},
            };

            await expect(publisher.publishTenexLog(logData)).rejects.toThrow("Failed to publish log");

            // Check if error was logged
            const errorCalls = loggerErrorSpy.mock.calls;
            expect(errorCalls.length).toBeGreaterThan(0);
            
            const tenexLogError = errorCalls.find((call: any[]) => 
                call[0] === "Failed to publish TENEX log"
            );
            expect(tenexLogError).toBeDefined();
            expect(tenexLogError[1]).toMatchObject({
                tenexEvent: "test_event",
                agent: "TestAgent",
                error: "Failed to publish log",
            });
        });
    });

    describe("edge cases", () => {
        it("should handle empty content in response", async () => {
            const options: ResponseOptions = {
                content: "",
            };

            const result = await publisher.publishResponse(options);

            expect(result.content).toBe("");
            expect(mockConversationManager.addMessageToContext).toHaveBeenCalledWith(
                "conv-123",
                "test-agent",
                new Message("assistant", "")
            );
        });

        it("should handle very long content", async () => {
            const longContent = "x".repeat(100000);
            const options: ResponseOptions = {
                content: longContent,
            };

            const result = await publisher.publishResponse(options);

            expect(result.content).toBe(longContent);
            expect(loggerDebugSpy).toHaveBeenCalledWith(
                "Published agent response",
                expect.objectContaining({
                    contentLength: 100000,
                })
            );
        });

        it("should handle all metadata types together", async () => {
            const options: ResponseOptions = {
                content: "Test response",
                llmMetadata: {
                    model: "gpt-4",
                    provider: "openai",
                    cost: 0.1,
                    promptTokens: 200,
                    completionTokens: 100,
                    totalTokens: 300,
                },
                continueMetadata: {
                    type: "continue",
                    routing: {
                        phase: "BUILD",
                        agents: ["builder-agent"],
                        reason: "Moving to build phase",
                        context: {
                            summary: "Continue summary",
                        },
                    },
                },
                completeMetadata: {
                    type: "complete",
                    completion: {
                        response: "Final answer",
                        summary: "Task completed",
                        nextAgent: "orchestrator",
                    },
                },
                destinationPubkeys: ["pubkey1"],
                additionalTags: [["custom", "tag"]],
            };

            const result = await publisher.publishResponse(options);

            // Verify all metadata was added
            expect(result.tags).toContainEqual(["llm-model", "gpt-4"]);
            expect(result.tags).toContainEqual(["routing-summary", "Continue summary"]);
            expect(result.tags).toContainEqual(["p", "pubkey1"]);
            expect(result.tags).toContainEqual(["custom", "tag"]);
        });

        it("should handle non-Error objects in catch blocks", async () => {
            mockConversationManager.addMessageToContext = mock(() => 
                Promise.reject("String error")
            );

            const options: ResponseOptions = {
                content: "Test response",
            };

            await expect(publisher.publishResponse(options)).rejects.toThrow("String error");

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to publish response",
                expect.objectContaining({
                    error: "String error",
                })
            );
        });
    });
});
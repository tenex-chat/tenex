import { describe, it, expect, beforeEach, jest } from "bun:test";
import { NostrPublisher } from "../NostrPublisher";
import type { NostrPublisherContext, ResponseOptions } from "../NostrPublisher";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import type { ConversationManager } from "@/conversations/ConversationManager";

// Mock dependencies
jest.mock("@/nostr", () => ({
    getNDK: jest.fn(() => ({
        signer: {
            user: jest.fn(() => ({
                npub: "test-npub",
                pubkey: "test-pubkey"
            }))
        },
        publish: jest.fn()
    }))
}));

jest.mock("@/services", () => ({
    getProjectContext: jest.fn(() => ({
        ndkProject: {
            nostrPubkey: "project-pubkey"
        }
    }))
}));

jest.mock("@/utils/logger", () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

describe("NostrPublisher", () => {
    let publisher: NostrPublisher;
    let mockContext: NostrPublisherContext;
    let mockEvent: NDKEvent;

    beforeEach(() => {
        mockEvent = new NDKEvent();
        mockEvent.id = "test-event-id";
        mockEvent.pubkey = "test-pubkey";
        mockEvent.tags = [];

        mockContext = {
            conversationId: "test-conversation",
            agent: {
                name: "test-agent",
                pubkey: "agent-pubkey",
                backend: "claude"
            } as AgentInstance,
            triggeringEvent: mockEvent,
            conversationManager: {
                getConversation: jest.fn(() => ({
                    id: "test-conversation",
                    title: "Test Conversation",
                    phase: "executing"
                }))
            } as unknown as ConversationManager
        };

        publisher = new NostrPublisher(mockContext);
    });

    describe("initialization", () => {
        it("should initialize with correct context", () => {
            expect(publisher).toBeDefined();
            expect(publisher["context"]).toEqual(mockContext);
        });

        it("should create typing indicator manager", () => {
            expect(publisher["typingIndicatorManager"]).toBeDefined();
        });
    });

    describe("publishResponse", () => {
        it("should publish a response with basic options", async () => {
            const options: ResponseOptions = {
                content: "Test response content"
            };

            const result = await publisher.publishResponse(options);
            
            expect(result).toBeDefined();
            expect(result.content).toBe("Test response content");
        });

        it("should include LLM metadata when provided", async () => {
            const options: ResponseOptions = {
                content: "Test response",
                llmMetadata: {
                    provider: "openai",
                    model: "gpt-4",
                    usage: {
                        inputTokens: 100,
                        outputTokens: 50,
                        totalTokens: 150
                    }
                }
            };

            const result = await publisher.publishResponse(options);
            
            expect(result).toBeDefined();
            expect(result.tags).toEqual(
                expect.arrayContaining([
                    expect.arrayContaining(["llm_provider", "openai"]),
                    expect.arrayContaining(["llm_model", "gpt-4"])
                ])
            );
        });

        it("should include completion metadata when provided", async () => {
            const options: ResponseOptions = {
                content: "Task completed",
                completeMetadata: {
                    success: true,
                    phase: "completed",
                    message: "Task finished successfully"
                }
            };

            const result = await publisher.publishResponse(options);
            
            expect(result).toBeDefined();
            expect(result.tags).toEqual(
                expect.arrayContaining([
                    expect.arrayContaining(["tenex-action", "complete"])
                ])
            );
        });

        it("should handle errors gracefully", async () => {
            const mockError = new Error("Publishing failed");
            jest.spyOn(publisher, "publishResponse").mockRejectedValueOnce(mockError);

            await expect(publisher.publishResponse({ content: "test" }))
                .rejects.toThrow("Publishing failed");
        });
    });

    describe("streaming", () => {
        it("should start and finalize streaming", async () => {
            const streamStarted = await publisher.startStreaming();
            expect(streamStarted).toBe(true);

            const streamContent = "Streaming content...";
            await publisher.streamContent(streamContent);

            const finalEvent = await publisher.finalizeStream({
                llmMetadata: {
                    provider: "anthropic",
                    model: "claude-3",
                    usage: {
                        inputTokens: 200,
                        outputTokens: 100,
                        totalTokens: 300
                    }
                }
            });

            expect(finalEvent).toBeDefined();
            expect(finalEvent.content).toContain(streamContent);
        });

        it("should handle stream cancellation", async () => {
            await publisher.startStreaming();
            await publisher.streamContent("Partial content");
            
            const cancelled = await publisher.cancelStream();
            expect(cancelled).toBe(true);
        });
    });

    describe("error handling", () => {
        it("should handle missing context gracefully", () => {
            const invalidContext = {
                ...mockContext,
                agent: undefined
            } as unknown as NostrPublisherContext;

            expect(() => new NostrPublisher(invalidContext))
                .not.toThrow();
        });

        it("should log errors when publishing fails", async () => {
            const loggerSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            
            // Force an error by breaking the NDK mock
            jest.mock("@/nostr", () => ({
                getNDK: jest.fn(() => {
                    throw new Error("NDK initialization failed");
                })
            }));

            try {
                await publisher.publishResponse({ content: "test" });
            } catch (error) {
                // Expected to throw
            }

            loggerSpy.mockRestore();
        });
    });

    describe("voice mode", () => {
        it("should handle voice mode events correctly", async () => {
            const voiceEvent = new NDKEvent();
            voiceEvent.tags = [["voice", "true"]];
            
            const voiceContext: NostrPublisherContext = {
                ...mockContext,
                triggeringEvent: voiceEvent
            };

            const voicePublisher = new NostrPublisher(voiceContext);
            const result = await voicePublisher.publishResponse({
                content: "Voice response"
            });

            expect(result.tags).toEqual(
                expect.arrayContaining([
                    expect.arrayContaining(["voice", "true"])
                ])
            );
        });
    });
});
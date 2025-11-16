import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDK } from "@nostr-dev-kit/ndk";
import { AgentExecutor } from "../AgentExecutor";
import type { ExecutionContext } from "../types";

/**
 * Test suite for AgentExecutor error handling, specifically for tool schema validation errors
 * that occur at the LLM provider level before streaming begins.
 *
 * This test captures the bug where:
 * 1. Tool schema validation fails at the provider (e.g., OpenRouter/OpenAI)
 * 2. The error is thrown from llmService.stream()
 * 3. AgentExecutor catches and re-throws the error
 * 4. The error bubbles up without a completionEvent
 * 5. AgentSupervisor tries to access completionEvent.usage and crashes
 */
describe("AgentExecutor - Tool Schema Validation Errors", () => {
    let mockAgent: AgentInstance;
    let mockContext: ExecutionContext;
    let mockConversationCoordinator: ConversationCoordinator;
    let publishedErrorEvent: any = null;

    beforeEach(() => {
        // Reset error tracking
        publishedErrorEvent = null;

        // Mock required modules
        mock.module("@/services", () => ({
            isProjectContextInitialized: () => true,
            getProjectContext: () => ({
                projectPath: "/test/project",
                configService: {
                    getProjectPath: () => "/test/project",
                },
                llmLogger: {
                    withAgent: () => ({
                        debug: () => {},
                        info: () => {},
                        error: () => {},
                        logRequest: () => {},
                        logResponse: () => {},
                    }),
                },
                agents: new Map(),
                getLessonsForAgent: () => [],
                project: {
                    tags: [
                        ["title", "Test Project"],
                        ["repo", "test-repo"],
                    ],
                },
                getProjectManager: () => ({
                    id: "pm-id",
                    name: "Project Manager",
                    slug: "project-manager",
                    pubkey: "pm-pubkey",
                }),
            }),
        }));

        mock.module("@/services/DelegationRegistry", () => ({
            DelegationRegistry: {
                getInstance: () => ({
                    hasPendingDelegation: () => false,
                    createPendingDelegation: () => {},
                    resolvePendingDelegation: () => {},
                    rejectPendingDelegation: () => {},
                    getPendingDelegationsForConversation: () => [],
                }),
            },
        }));

        mock.module("@/conversations/executionTime", () => ({
            startExecutionTime: mock(() => {}),
            stopExecutionTime: mock(() => {}),
        }));

        mock.module("@/services/LLMOperationsRegistry", () => ({
            llmOpsRegistry: {
                registerOperation: () => new AbortController().signal,
                completeOperation: () => {},
            },
        }));

        mock.module("@/tools/registry", () => ({
            getToolsObject: () => ({
                // Simulate a tool with invalid schema that will fail at provider level
                invalid_tool: {
                    name: "invalid_tool",
                    description: "A tool with invalid schema",
                    parameters: {
                        type: "object",
                        properties: {
                            tags: {
                                type: "array",
                                // Missing 'items' field - this is invalid per OpenAI spec
                            },
                        },
                    },
                },
            }),
        }));

        mock.module("@/prompts/utils/systemPromptBuilder", () => ({
            buildSystemPrompt: () => "You are a test agent.",
            buildSystemPromptMessages: () => [
                {
                    message: {
                        role: "system",
                        content: "You are a test agent.",
                    },
                },
            ],
        }));

        mock.module("@/conversations/services/ThreadService", () => ({
            threadService: {
                getThreadToEvent: () => [],
                getThreadFromEvent: () => [],
            },
        }));

        mock.module("@/utils/phase-utils", () => ({
            createEventContext: () => ({
                projectId: "test-project",
                conversationId: "test-conversation-id",
                model: "test-model",
            }),
            formatConversationSnapshot: async () => "Test conversation snapshot",
        }));

        // Create mock conversation coordinator
        mockConversationCoordinator = {
            getConversation: mock(() => ({
                id: "test-conversation-id",
                title: "Test Conversation",
                phase: "CHAT",
                history: [],
                agentStates: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            })),
            buildOrchestratorRoutingContext: mock(async () => ({
                user_request: "Test user request",
                workflow_narrative: "Test narrative",
            })),
            saveConversation: mock(async () => {}),
            updateState: mock(async () => {}),
            getAgentContext: mock(() => null),
            setAgentContext: mock(async () => {}),
            updatePhase: mock(async () => {}),
        } as any;

        // Create mock agent with invalid tool
        mockAgent = {
            id: "test-agent-id",
            name: "test-agent",
            slug: "test-agent",
            pubkey: "test-agent-pubkey",
            description: "Test agent",
            tools: ["invalid_tool"],
            systemPrompt: "You are a test agent.",
            conversationStarters: [],
            customInstructions: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            projectId: "test-project",
            llmProvider: "openrouter",
            model: "openai/gpt-4o-mini",
            temperature: 0.7,
            llmConfig: {
                provider: "openrouter",
                model: "openai/gpt-4o-mini",
                temperature: 0.7,
            },
            createLLMService: mock(() => {
                const eventHandlers = new Map();
                return {
                    provider: "openrouter",
                    model: "openai/gpt-4o-mini",
                    on: mock((event: string, handler: Function) => {
                        eventHandlers.set(event, handler);
                    }),
                    removeAllListeners: mock(() => {
                        eventHandlers.clear();
                    }),
                    // Simulate the provider throwing a tool schema validation error
                    stream: mock(async () => {
                        // Simulate OpenRouter/OpenAI error for invalid tool schema
                        const error = new Error("Provider returned error") as any;
                        error.name = "AI_APICallError";
                        error.statusCode = 400;
                        error.responseBody = JSON.stringify({
                            error: {
                                message: "Provider returned error",
                                code: 400,
                                metadata: {
                                    raw: JSON.stringify({
                                        error: {
                                            message:
                                                "Invalid schema for function 'invalid_tool': In context=('properties', 'tags'), array schema missing items.",
                                            type: "invalid_request_error",
                                            param: "tools[0].function.parameters",
                                            code: "invalid_function_parameters",
                                        },
                                    }),
                                    provider_name: "OpenAI",
                                },
                            },
                        });
                        error.isRetryable = false;

                        // Call stream-error handler before throwing
                        const errorHandler = eventHandlers.get("stream-error");
                        if (errorHandler) {
                            await errorHandler({ error });
                        }

                        throw error;
                    }),
                };
            }),
            createMetadataStore: mock(() => ({
                get: mock(() => undefined),
                set: mock(() => {}),
                delete: mock(() => {}),
                has: mock(() => false),
                clear: mock(() => {}),
            })),
        } as any;

        // Create mock execution context
        mockContext = {
            agent: mockAgent,
            conversationId: "test-conversation-id",
            phase: "CHAT",
            projectPath: "/test/project",
            messages: [],
            tools: [],
            toolContext: {},
            conversationCoordinator: mockConversationCoordinator,
            triggeringEvent: {
                id: "test-event-id",
                pubkey: "test-user-pubkey",
                kind: 1,
                content: "Test message",
                tags: [],
                created_at: Math.floor(Date.now() / 1000),
                sig: "test-sig",
                tagValue: mock((tagName: string) => undefined),
            } as any,
            getConversation: () => mockConversationCoordinator.getConversation(),
        } as any;
    });

    afterEach(() => {
        mock.restore();
    });

    it("should handle tool schema validation errors without crashing", async () => {
        // Create a mock AgentPublisher that tracks published events
        const mockTypingCalls: any[] = [];
        const mockErrorCalls: any[] = [];
        const mockCompleteCalls: any[] = [];

        mock.module("@/nostr/AgentPublisher", () => ({
            AgentPublisher: class {
                async typing(data: any) {
                    mockTypingCalls.push(data);
                }
                async error(data: any) {
                    publishedErrorEvent = data;
                    mockErrorCalls.push(data);
                }
                async complete(data: any) {
                    mockCompleteCalls.push(data);
                    return { id: "complete-event-id" };
                }
                async conversation() {}
                async toolUse() {
                    return { id: "tool-event-id" };
                }
                async publishStreamingDelta() {}
                async forceFlushStreamingBuffers() {}
                resetStreamingSequence() {}
            },
        }));

        const executor = new AgentExecutor();

        // The execute should handle the error gracefully
        try {
            await executor.execute(mockContext);
            // If we get here, the error was handled but execution should still fail
            expect(true).toBe(false); // Should not reach here
        } catch (error: any) {
            // The error should be caught and handled
            expect(error).toBeDefined();
            expect(error.name).toBe("AI_APICallError");

            // Verify that an error event was published
            expect(publishedErrorEvent).toBeDefined();
            expect(publishedErrorEvent.message).toContain("AI provider");

            // Verify typing indicator was started
            expect(mockTypingCalls.length).toBeGreaterThan(0);
            expect(mockTypingCalls[0].state).toBe("start");

            // The test fails here because the current implementation crashes
            // when trying to access completionEvent.usage in AgentSupervisor
        }
    });

    it("should propagate tool schema errors to the user", async () => {
        const mockErrorCalls: any[] = [];

        mock.module("@/nostr/AgentPublisher", () => ({
            AgentPublisher: class {
                async typing() {}
                async error(data: any) {
                    publishedErrorEvent = data;
                    mockErrorCalls.push(data);
                }
                async complete() {
                    return { id: "complete-event-id" };
                }
                async conversation() {}
                async toolUse() {
                    return { id: "tool-event-id" };
                }
                async publishStreamingDelta() {}
                resetStreamingSequence() {}
            },
        }));

        const executor = new AgentExecutor();

        try {
            await executor.execute(mockContext);
        } catch (error) {
            // Error is expected
        }

        // Verify error was published with useful information
        expect(mockErrorCalls.length).toBeGreaterThan(0);
        const errorEvent = mockErrorCalls[0];
        expect(errorEvent.message).toBeDefined();
        expect(errorEvent.message).toContain("error");
    });

    it("should not crash when completionEvent is undefined", async () => {
        mock.module("@/nostr/AgentPublisher", () => ({
            AgentPublisher: class {
                async typing() {}
                async error() {}
                async complete() {
                    return { id: "complete-event-id" };
                }
                async conversation() {}
                async toolUse() {
                    return { id: "tool-event-id" };
                }
                async publishStreamingDelta() {}
                resetStreamingSequence() {}
            },
        }));

        const executor = new AgentExecutor();

        try {
            await executor.execute(mockContext);
            expect(true).toBe(false); // Should throw
        } catch (error: any) {
            // The error should be the original tool schema error, not a crash
            expect(error.name).toBe("AI_APICallError");
            // Should NOT be: "undefined is not an object (evaluating 'completionEvent.usage')"
            expect(error.message).not.toContain("undefined is not an object");
        }
    });
});

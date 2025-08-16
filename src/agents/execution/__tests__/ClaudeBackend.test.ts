import { describe, expect, test, beforeEach, mock, Mock } from "bun:test";
import type { ExecutionContext } from "../types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { AgentInstance } from "@/agents/types";
import type { Tool } from "@/tools/types";
import type { Message } from "multi-llm-ts";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock dependencies
const mockHandleAgentCompletion = mock(() => Promise.resolve({
    event: {
        id: "test-event-id",
        sign: mock(async () => {}),
        publish: mock(async () => {}),
    }
}));
const mockOrchestratorExecute = mock(() => Promise.resolve({
    success: true,
    task: {
        id: "test-task-id",
        content: "Task completed",
    },
    sessionId: "test-session-id",
    totalCost: 0.05,
    messageCount: 3,
    duration: 5000,
    finalResponse: "I completed the task successfully.",
}));
const mockGetNDK = mock(() => ({}));

// Mock modules
mock.module("../completionHandler", () => ({
    handleAgentCompletion: mockHandleAgentCompletion,
}));

mock.module("@/claude/orchestrator", () => ({
    ClaudeTaskOrchestrator: mock(() => ({
        execute: mockOrchestratorExecute,
    })),
}));

mock.module("@/nostr/TaskPublisher", () => ({
    TaskPublisher: mock(() => ({})),
}));

mock.module("@/nostr/ndkClient", () => ({
    getNDK: mockGetNDK,
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
    },
}));

// Import ClaudeBackend after mocks are set up
import { ClaudeBackend } from "../ClaudeBackend";

describe("ClaudeBackend", () => {
    let backend: ClaudeBackend;
    let mockContext: ExecutionContext;
    let mockPublisher: NostrPublisher;
    let mockConversationManager: ConversationManager;
    let mockOrchestrator: ClaudeTaskOrchestrator;
    let mockAgent: AgentInstance;
    let mockTriggeringEvent: NDKEvent;

    beforeEach(() => {
        // Reset all mocks
        mockHandleAgentCompletion.mockClear();
        mockOrchestratorExecute.mockClear();
        mockGetNDK.mockClear();

        // Setup mock agent
        mockAgent = {
            name: "TestAgent",
            slug: "test-agent",
            description: "Test agent for unit tests",
            instructions: "Test instructions",
            tools: [],
            capabilities: [],
            builtIn: false,
            signer: {
                privateKey: "test-private-key",
            },
        };

        // Setup mock triggering event
        mockTriggeringEvent = {
            id: "test-event-id",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "test content",
            sig: "test-sig",
        } as NDKEvent;

        // Setup mock conversation manager
        mockConversationManager = {
            getConversation: mock(() => ({
                id: "test-conversation-id",
                phase: "CHAT",
                messages: [],
            })),
            getAgentContext: mock(() => ({
                agentSlug: "test-agent",
                claudeSessionId: undefined,
            })),
            saveConversation: mock(() => Promise.resolve()),
            updateAgentState: mock(() => Promise.resolve()),
        } as unknown as ConversationManager;

        // Setup mock execution context
        mockContext = {
            agent: mockAgent,
            conversationId: "test-conversation-id",
            conversationManager: mockConversationManager,
            triggeringEvent: mockTriggeringEvent,
            projectPath: "/test/project",
            claudeSessionId: undefined,
        };

        // Setup mock publisher
        mockPublisher = {
            publishAgentMessage: mock(() => Promise.resolve()),
            publishToolUse: mock(() => Promise.resolve()),
            publishToolResult: mock(() => Promise.resolve()),
            addLLMMetadata: mock(() => {}),
        } as unknown as NostrPublisher;

        // Reset orchestrator mock to default success response
        mockOrchestratorExecute.mockImplementation(() => Promise.resolve({
            success: true,
            task: {
                id: "test-task-id",
                content: "Task completed",
            },
            sessionId: "test-session-id",
            totalCost: 0.05,
            messageCount: 3,
            duration: 5000,
            finalResponse: "I completed the task successfully.",
        }));

        backend = new ClaudeBackend();
    });

    describe("execute", () => {
        test("should successfully execute a task with Claude Code", async () => {
            const messages: Message[] = [
                {
                    role: "system",
                    content: "You are a helpful assistant.",
                },
                {
                    role: "user",
                    content: "Please help me with this task.",
                },
            ];
            const tools: Tool[] = [];

            await backend.execute(messages, tools, mockContext, mockPublisher);

            // Verify orchestrator was called with correct parameters
            expect(mockOrchestratorExecute).toHaveBeenCalledWith({
                prompt: "Please help me with this task.",
                systemPrompt: "You are a helpful assistant.",
                projectPath: "/test/project",
                title: "Claude Code Execution (via TestAgent)",
                conversationRootEventId: "test-conversation-id",
                conversation: {
                    id: "test-conversation-id",
                    phase: "CHAT",
                    messages: [],
                },
                conversationManager: mockConversationManager,
                abortSignal: expect.any(AbortSignal),
                resumeSessionId: undefined,
                agentName: "TestAgent",
            });

            // Verify completion handler was called
            expect(mockHandleAgentCompletion).toHaveBeenCalledWith({
                response: "I completed the task successfully.",
                summary: "Claude Code execution completed. Task ID: test-task-id",
                agent: mockAgent,
                conversationId: "test-conversation-id",
                publisher: mockPublisher,
                triggeringEvent: mockTriggeringEvent,
                conversationManager: mockConversationManager,
            });

            // Verify session ID was stored
            expect(mockConversationManager.updateAgentState as Mock<any>).toHaveBeenCalledWith(
                "test-conversation-id",
                "test-agent",
                { claudeSessionId: "test-session-id" }
            );
        });

        test("should resume an existing Claude session when claudeSessionId is provided", async () => {
            // Setup context with existing session ID
            mockContext.claudeSessionId = "existing-session-id";

            const messages: Message[] = [
                {
                    role: "user",
                    content: "Continue with the previous task.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            // Verify orchestrator was called with resumeSessionId
            expect(mockOrchestratorExecute).toHaveBeenCalledWith(
                expect.objectContaining({
                    resumeSessionId: "existing-session-id",
                })
            );
        });

        test("should throw error when no messages are provided", async () => {
            const messages: Message[] = [];

            await expect(
                backend.execute(messages, [], mockContext, mockPublisher)
            ).rejects.toThrow("No user message provided");
        });

        test("should throw error when prompt is empty", async () => {
            const messages: Message[] = [
                {
                    role: "user",
                    content: "",
                },
            ];

            await expect(
                backend.execute(messages, [], mockContext, mockPublisher)
            ).rejects.toThrow("No prompt found in messages");
        });

        test("should handle Claude execution failure", async () => {
            // Setup orchestrator to return failure
            mockOrchestratorExecute.mockImplementationOnce(() => Promise.resolve({
                success: false,
                error: "Claude execution failed due to timeout",
                task: { id: "failed-task-id" },
                totalCost: 0,
                messageCount: 0,
                duration: 10000,
            }));

            const messages: Message[] = [
                {
                    role: "user",
                    content: "Do something that will fail.",
                },
            ];

            await expect(
                backend.execute(messages, [], mockContext, mockPublisher)
            ).rejects.toThrow("Claude code execution failed: Claude execution failed due to timeout");
        });

        test("should use task content as fallback when no final response", async () => {
            // Setup orchestrator without finalResponse
            mockOrchestratorExecute.mockImplementationOnce(() => Promise.resolve({
                success: true,
                task: {
                    id: "test-task-id",
                    content: "Task content as fallback",
                },
                sessionId: "test-session-id",
                totalCost: 0.05,
                messageCount: 3,
                duration: 5000,
                // No finalResponse field
            }));

            const messages: Message[] = [
                {
                    role: "user",
                    content: "Do something.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            // Verify completion handler was called with task content
            expect(mockHandleAgentCompletion).toHaveBeenCalledWith(
                expect.objectContaining({
                    response: "Task content as fallback",
                })
            );
        });

        test("should handle case when agent context is not found", async () => {
            // Setup conversation manager to return null for agent context
            (mockConversationManager.getAgentContext as Mock<any>).mockImplementationOnce(() => null);

            const messages: Message[] = [
                {
                    role: "user",
                    content: "Test without agent context.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            // Should still complete successfully but not save session ID
            expect(mockHandleAgentCompletion).toHaveBeenCalled();
            // saveConversation should not be called when context is null
            expect(mockConversationManager.saveConversation as Mock<any>).not.toHaveBeenCalled();
        });

        test("should extract system prompt from system message", async () => {
            const messages: Message[] = [
                {
                    role: "system",
                    content: "Custom system prompt for testing.",
                },
                {
                    role: "assistant",
                    content: "I understand.",
                },
                {
                    role: "user",
                    content: "Execute with custom system prompt.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            expect(mockOrchestratorExecute).toHaveBeenCalledWith(
                expect.objectContaining({
                    systemPrompt: "Custom system prompt for testing.",
                    prompt: "Execute with custom system prompt.",
                })
            );
        });

        test("should handle missing system prompt gracefully", async () => {
            const messages: Message[] = [
                {
                    role: "user",
                    content: "Execute without system prompt.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            expect(mockOrchestratorExecute).toHaveBeenCalledWith(
                expect.objectContaining({
                    systemPrompt: "",  // Empty string when no system message
                    prompt: "Execute without system prompt.",
                })
            );
        });
        
        test("should strip thinking blocks from messages", async () => {
            const messages: Message[] = [
                {
                    role: "system",
                    content: "You are a helpful assistant.<thinking>Internal thoughts here</thinking> Be concise.",
                },
                {
                    role: "user",
                    content: "Task with <thinking>user thoughts</thinking> content.",
                },
            ];

            await backend.execute(messages, [], mockContext, mockPublisher);

            // Verify that the orchestrator was called with cleaned content
            expect(mockOrchestratorExecute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: "Task with  content.",
                    systemPrompt: "You are a helpful assistant. Be concise.",
                })
            );
        });
    });
});
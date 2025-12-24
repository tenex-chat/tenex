import { describe, expect, it, mock, beforeEach } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Span } from "@opentelemetry/api";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock systemPromptBuilder
const mockBuildSystemPromptMessages = mock(async () => [
    { message: { role: "system" as const, content: "System prompt content" } },
]);
mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages: mockBuildSystemPromptMessages,
}));

// Mock AgentEventDecoder
mock.module("@/nostr/AgentEventDecoder", () => ({
    AgentEventDecoder: {
        extractNudgeEventIds: mock(() => []),
    },
}));

// Mock NudgeService
const mockFetchNudges = mock(async () => null);
mock.module("@/services/nudge", () => ({
    NudgeService: {
        getInstance: mock(() => ({
            fetchNudges: mockFetchNudges,
        })),
    },
}));

// Mock services
let mockProjectCtx: any = null;
mock.module("@/services/projects", () => ({
    isProjectContextInitialized: mock(() => mockProjectCtx !== null),
    getProjectContext: mock(() => mockProjectCtx),
}));

import { addSystemPrompt } from "../SystemPromptInjector";
import type { ExecutionContext } from "../../types";
import type { ModelMessage } from "ai";

// Create a mock span
function createMockSpan(): Span {
    return {
        addEvent: mock(() => {}),
        setAttribute: mock(() => {}),
        setAttributes: mock(() => {}),
        end: mock(() => {}),
        recordException: mock(() => {}),
        setStatus: mock(() => {}),
        updateName: mock(() => {}),
        isRecording: mock(() => true),
        spanContext: mock(() => ({
            traceId: "trace-123",
            spanId: "span-123",
            traceFlags: 1,
        })),
    } as unknown as Span;
}

describe("SystemPromptInjector", () => {
    beforeEach(() => {
        mockProjectCtx = null;
        mockBuildSystemPromptMessages.mockClear();
        mockFetchNudges.mockClear();
    });

    describe("addSystemPrompt", () => {
        it("should do nothing when conversation is null", async () => {
            const messages: ModelMessage[] = [];
            const context = {
                getConversation: () => null,
                agent: { name: "Test Agent", pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, createMockSpan());

            expect(messages).toHaveLength(0);
        });

        it("should add fallback prompt when project context not initialized", async () => {
            mockProjectCtx = null;

            const messages: ModelMessage[] = [];
            const context = {
                getConversation: () => ({ history: [] }),
                agent: {
                    name: "Test Agent",
                    pubkey: "agent-pubkey",
                    instructions: "Be helpful",
                },
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, createMockSpan());

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("system");
            expect(messages[0].content).toContain("Test Agent");
            expect(messages[0].content).toContain("Be helpful");
        });

        it("should build system prompt from project context when initialized", async () => {
            mockProjectCtx = {
                project: { name: "Test Project" },
                agents: new Map([["agent-1", { slug: "test-agent" }]]),
                getLessonsForAgent: mock(() => []),
                agentLessons: new Map(),
                getProjectManager: mock(() => ({ pubkey: "pm-pubkey" })),
            };

            mockBuildSystemPromptMessages.mockResolvedValue([
                { message: { role: "system", content: "Built system prompt" } },
            ]);

            const messages: ModelMessage[] = [];
            const context = {
                getConversation: () => ({ history: [] }),
                agent: {
                    name: "Test Agent",
                    slug: "test-agent",
                    pubkey: "agent-pubkey",
                },
                projectBasePath: "/project",
                workingDirectory: "/project",
                currentBranch: "main",
                triggeringEvent: { tags: [] } as unknown as NDKEvent,
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, createMockSpan());

            expect(mockBuildSystemPromptMessages).toHaveBeenCalled();
            expect(messages).toHaveLength(1);
            expect(messages[0].content).toBe("Built system prompt");
        });

        it("should include lessons in system prompt build", async () => {
            const testLessons = [
                { title: "Lesson 1", content: "Content 1" },
                { title: "Lesson 2", content: "Content 2" },
            ];

            mockProjectCtx = {
                project: { name: "Test Project" },
                agents: new Map(),
                getLessonsForAgent: mock(() => testLessons),
                agentLessons: new Map([["agent-pubkey", testLessons]]),
                getProjectManager: mock(() => ({ pubkey: "pm-pubkey" })),
            };

            const messages: ModelMessage[] = [];
            const span = createMockSpan();
            const context = {
                getConversation: () => ({ history: [] }),
                agent: {
                    name: "Test Agent",
                    slug: "test-agent",
                    pubkey: "agent-pubkey",
                },
                projectBasePath: "/project",
                workingDirectory: "/project",
                currentBranch: "main",
                triggeringEvent: { tags: [] } as unknown as NDKEvent,
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, span);

            // Verify lessons were passed to builder
            expect(mockBuildSystemPromptMessages).toHaveBeenCalled();
            const callArgs = mockBuildSystemPromptMessages.mock.calls[0][0];
            expect(callArgs.agentLessons.get("agent-pubkey")).toEqual(testLessons);
        });

        it("should add tracing events for lessons", async () => {
            mockProjectCtx = {
                project: { name: "Test Project" },
                agents: new Map(),
                getLessonsForAgent: mock(() => [{ title: "Test Lesson" }]),
                agentLessons: new Map([["agent-pubkey", [{ title: "Test Lesson" }]]]),
                getProjectManager: mock(() => ({ pubkey: "pm-pubkey" })),
            };

            const messages: ModelMessage[] = [];
            const span = createMockSpan();
            const context = {
                getConversation: () => ({ history: [] }),
                agent: {
                    name: "Test Agent",
                    slug: "test-agent",
                    pubkey: "agent-pubkey",
                },
                projectBasePath: "/project",
                workingDirectory: "/project",
                currentBranch: "main",
                triggeringEvent: { tags: [] } as unknown as NDKEvent,
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, span);

            expect(span.addEvent).toHaveBeenCalled();
        });

        it("should identify project manager correctly", async () => {
            mockProjectCtx = {
                project: { name: "Test Project" },
                agents: new Map(),
                getLessonsForAgent: mock(() => []),
                agentLessons: new Map(),
                getProjectManager: mock(() => ({ pubkey: "agent-pubkey" })), // Same as agent
            };

            const messages: ModelMessage[] = [];
            const context = {
                getConversation: () => ({ history: [] }),
                agent: {
                    name: "Project Manager",
                    slug: "pm",
                    pubkey: "agent-pubkey",
                },
                projectBasePath: "/project",
                workingDirectory: "/project",
                currentBranch: "main",
                triggeringEvent: { tags: [] } as unknown as NDKEvent,
            } as unknown as ExecutionContext;

            await addSystemPrompt(messages, context, createMockSpan());

            const callArgs = mockBuildSystemPromptMessages.mock.calls[0][0];
            expect(callArgs.isProjectManager).toBe(true);
        });
    });
});

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "../AgentPublisher";
import type { AskConfig, DelegateConfig } from "../AgentPublisher";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../AgentEventEncoder";

/**
 * Mock interface for NDKEvent used in tests.
 * Provides type-safe mocking of event properties.
 */
interface MockTriggeringEvent {
    id: string;
    tags: string[][];
    pubkey?: string;
}

/**
 * Mock interface for root event.
 */
interface MockRootEvent {
    id: string;
}

// Minimal mocks - only mock what's necessary for these specific tests
mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({})),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Mock ProjectContextStore for aTagProject
mock.module("@/services/projects", () => ({
    getProjectContext: mock(() => ({
        project: {
            tagReference: mock(() => ["a", "31933:testpubkey:test-project"]),
            pubkey: "testpubkey",
        },
        projectTag: "31933:testpubkey:test-project",
    })),
    isProjectContextInitialized: mock(() => true),
}));

// Mock OpenTelemetry - needed for trace context injection
const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
};

const mockSpan = {
    addEvent: mock(),
    setAttributes: mock(),
    setAttribute: mock(),
    setStatus: mock(),
    recordException: mock(),
    end: mock(),
    isRecording: () => true,
    updateName: mock(),
    spanContext: () => ({ traceId: "test", spanId: "test", traceFlags: 0 }),
};

mock.module("@opentelemetry/api", () => ({
    ROOT_CONTEXT: mockContext,
    context: {
        active: mock(() => mockContext),
        with: mock((_ctx: unknown, fn: () => unknown) => fn()),
    },
    propagation: {
        inject: mock(),
    },
    trace: {
        getTracer: mock(() => ({
            startActiveSpan: mock((_name: string, fn: (span: unknown) => unknown) =>
                fn(mockSpan)
            ),
        })),
        getActiveSpan: mock(() => null),
        setSpan: mock(() => mockContext),
    },
    SpanStatusCode: {
        OK: 1,
        ERROR: 2,
    },
    TraceFlags: {
        NONE: 0,
        SAMPLED: 1,
    },
}));

mock.module("@/telemetry/LLMSpanRegistry", () => ({
    getLLMSpanId: mock(() => null),
}));

describe("AgentPublisher - Delegation Tag", () => {
    let mockPublish: ReturnType<typeof mock>;
    let capturedEvents: NDKEvent[] = [];
    let mockAgentInstance: AgentInstance;
    let publisher: AgentPublisher;

    beforeEach(() => {
        capturedEvents = [];

        // Mock NDKEvent.publish to capture events
        mockPublish = mock(() => Promise.resolve(new Set()));

        spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
            capturedEvents.push(this);
            return mockPublish();
        });

        // Create mock AgentInstance with minimal required properties
        mockAgentInstance = {
            slug: "test-agent",
            pubkey: "test-agent-pubkey",
            sign: mock((_event: NDKEvent) => Promise.resolve()),
            projectTag: "31933:testpubkey:test-project",
        } as unknown as AgentInstance;

        publisher = new AgentPublisher(mockAgentInstance);
    });

    afterEach(() => {
        capturedEvents = [];
    });

    /**
     * Helper to create a valid EventContext for testing.
     */
    function createTestContext(overrides?: Partial<EventContext>): EventContext {
        const triggeringEvent: MockTriggeringEvent = {
            id: "triggering-event-id",
            tags: [],
            pubkey: "triggering-pubkey",
        };
        const rootEvent: MockRootEvent = { id: "root-event-id" };

        return {
            conversationId: "parent-conversation-id",
            triggeringEvent: triggeringEvent as unknown as NDKEvent,
            rootEvent,
            ralNumber: 1,
            ...overrides,
        };
    }

    describe("delegate()", () => {
        it("should add delegation tag with parent conversationId", async () => {
            const context = createTestContext({
                conversationId: "parent-conversation-id-123",
            });

            const config: DelegateConfig = {
                recipient: "recipient-pubkey",
                content: "Please do this task",
            };

            await publisher.delegate(config, context);

            expect(capturedEvents.length).toBe(1);
            const event = capturedEvents[0];

            // Check for delegation tag
            const delegationTag = event.tags.find((tag) => tag[0] === "delegation");
            expect(delegationTag).toBeDefined();
            expect(delegationTag?.[1]).toBe("parent-conversation-id-123");
        });

        it("should throw error when conversationId is missing", async () => {
            const contextWithoutConversationId = createTestContext({
                conversationId: undefined as unknown as string,
            });

            const config: DelegateConfig = {
                recipient: "recipient-pubkey",
                content: "Please do this task",
            };

            await expect(
                publisher.delegate(config, contextWithoutConversationId)
            ).rejects.toThrow("Cannot add delegation tag: conversationId is required in context for delegation events");
        });

        it("should throw error when conversationId is empty string", async () => {
            const contextWithEmptyConversationId = createTestContext({
                conversationId: "",
            });

            const config: DelegateConfig = {
                recipient: "recipient-pubkey",
                content: "Please do this task",
            };

            await expect(
                publisher.delegate(config, contextWithEmptyConversationId)
            ).rejects.toThrow("Cannot add delegation tag: conversationId is required in context for delegation events");
        });
    });

    describe("ask()", () => {
        it("should add delegation tag with parent conversationId", async () => {
            const context = createTestContext({
                conversationId: "parent-conversation-id-456",
            });

            const config: AskConfig = {
                recipient: "recipient-pubkey",
                context: "Full context here",
                title: "Quick question",
                questions: [
                    {
                        type: "question",
                        title: "Question",
                        question: "Quick question?",
                    },
                ],
            };

            await publisher.ask(config, context);

            expect(capturedEvents.length).toBe(1);
            const event = capturedEvents[0];

            // Check for delegation tag
            const delegationTag = event.tags.find((tag) => tag[0] === "delegation");
            expect(delegationTag).toBeDefined();
            expect(delegationTag?.[1]).toBe("parent-conversation-id-456");
        });

        it("should throw error when conversationId is missing", async () => {
            const contextWithoutConversationId = createTestContext({
                conversationId: undefined as unknown as string,
            });

            const config: AskConfig = {
                recipient: "recipient-pubkey",
                context: "Full context here",
                title: "Quick question",
                questions: [
                    {
                        type: "question",
                        title: "Question",
                        question: "Quick question?",
                    },
                ],
            };

            await expect(
                publisher.ask(config, contextWithoutConversationId)
            ).rejects.toThrow("Cannot add delegation tag: conversationId is required in context for delegation events");
        });
    });
});

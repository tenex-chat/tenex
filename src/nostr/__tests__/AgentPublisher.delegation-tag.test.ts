import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import * as projectsModule from "@/services/projects";
import { AgentPublisher } from "../AgentPublisher";
import type { AskConfig, DelegateConfig } from "../types";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../types";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";
import * as ndkClientModule from "../ndkClient";
import * as traceContextModule from "../trace-context";

// Minimal mocks - only mock what's necessary for these specific tests

describe("AgentPublisher - Delegation Tag", () => {
    let mockPublish: ReturnType<typeof mock>;
    let capturedEvents: NDKEvent[] = [];
    let mockAgentInstance: AgentInstance;
    let publisher: AgentPublisher;
    let publishSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        capturedEvents = [];
        spyOn(ndkClientModule, "getNDK").mockReturnValue({} as any);
        spyOn(traceContextModule, "injectTraceContext").mockImplementation(() => {});
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                tagReference: () => ["a", "31933:testpubkey:test-project"],
                pubkey: "testpubkey",
            },
            projectTag: "31933:testpubkey:test-project",
        } as any);
        spyOn(projectsModule, "isProjectContextInitialized").mockReturnValue(true);
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});

        // Mock NDKEvent.publish to capture events
        mockPublish = mock(() =>
            Promise.resolve(new Set([{ url: "wss://relay.test" }] as Array<{ url: string }>))
        );

        publishSpy = spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
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
        publishSpy?.mockRestore();
        mock.restore();
    });

    /**
     * Helper to create a valid EventContext for testing.
     */
    function createTestContext(overrides?: Partial<EventContext>): EventContext {
        const triggeringEnvelope = createMockInboundEnvelope({
            principal: {
                id: "triggering-pubkey",
                transport: "nostr",
                linkedPubkey: "triggering-pubkey",
                kind: "human",
            },
            message: {
                id: "triggering-event-id",
                transport: "nostr",
                nativeId: "triggering-event-id",
            },
        });

        return {
            conversationId: "parent-conversation-id",
            triggeringEnvelope,
            rootEvent: { id: "root-event-id" },
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

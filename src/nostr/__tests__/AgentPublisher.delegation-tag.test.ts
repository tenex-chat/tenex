import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "../AgentPublisher";
import type { AskConfig, DelegateConfig } from "../types";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../types";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";
import * as ndkClientModule from "../ndkClient";
import * as rustPublishOutbox from "../RustPublishOutbox";
import * as traceContextModule from "../trace-context";

const mockProjectContext = {
    project: {
        tagReference: () => ["a", "31933:testpubkey:test-project"],
        pubkey: "testpubkey",
    },
    agentRegistry: {
        getAgentByPubkey: () => null,
    },
};

// Minimal mocks - only mock what's necessary for these specific tests

describe("AgentPublisher - Delegation Tag", () => {
    let capturedEnqueues: Array<{
        event: NDKEvent;
        context: rustPublishOutbox.RustPublishOutboxContext;
    }> = [];
    let mockAgentInstance: AgentInstance;
    let publisher: AgentPublisher;
    let enqueueSpy: ReturnType<typeof spyOn>;
    let directPublishSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        capturedEnqueues = [];
        const mockRelay = {
            url: "wss://relay.test",
            once: mock(() => undefined),
            off: mock(() => undefined),
            connectivity: {
                connected: true,
                connectionStats: {
                    attempts: 1,
                    success: 1,
                },
            },
        };
        spyOn(ndkClientModule, "getNDK").mockReturnValue({
            subManager: { seenEvents: new Map() },
            pool: { relays: new Map([[mockRelay.url, mockRelay]]) },
        } as any);
        spyOn(traceContextModule, "injectTraceContext").mockImplementation(() => {});
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});

        enqueueSpy = spyOn(
            rustPublishOutbox,
            "enqueueSignedEventForRustPublish"
        ).mockImplementation(async (event, context = {}) => {
            capturedEnqueues.push({ event, context });
            return event.rawEvent() as Awaited<ReturnType<typeof rustPublishOutbox.enqueueSignedEventForRustPublish>>;
        });
        directPublishSpy = spyOn(NDKEvent.prototype, "publish");
        const signer = NDKPrivateKeySigner.generate();

        // Create mock AgentInstance with minimal required properties
        mockAgentInstance = {
            slug: "test-agent",
            pubkey: (await signer.user()).pubkey,
            sign: mock((event: NDKEvent) => event.sign(signer)),
            projectTag: "31933:testpubkey:test-project",
        } as unknown as AgentInstance;

        publisher = new AgentPublisher(mockAgentInstance, mockProjectContext);
    });

    afterEach(() => {
        capturedEnqueues = [];
        enqueueSpy?.mockRestore();
        directPublishSpy?.mockRestore();
        mock.restore();
    });

    function expectSingleEnqueuedEvent(): NDKEvent {
        expect(capturedEnqueues.length).toBe(1);
        expect(enqueueSpy).toHaveBeenCalledTimes(1);
        expect(directPublishSpy).not.toHaveBeenCalled();

        const { event, context } = capturedEnqueues[0];
        expect(event.rawEvent().sig).toBeString();
        expect(context.requestId).toStartWith("agent:");
        return event;
    }

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

            const event = expectSingleEnqueuedEvent();

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

        it("should add a variant tag when provided", async () => {
            const context = createTestContext();

            const config: DelegateConfig = {
                recipient: "recipient-pubkey",
                content: "Please do this task",
                variant: "deep",
            };

            await publisher.delegate(config, context);

            const event = expectSingleEnqueuedEvent();

            const variantTag = event.tags.find((tag) => tag[0] === "variant");
            expect(variantTag).toBeDefined();
            expect(variantTag?.[1]).toBe("deep");
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

            const event = expectSingleEnqueuedEvent();

            // Check for delegation tag
            const delegationTag = event.tags.find((tag) => tag[0] === "delegation");
            expect(delegationTag).toBeDefined();
            expect(delegationTag?.[1]).toBe("parent-conversation-id-456");
        });

        it("should forward team and branch tags from triggering event", async () => {
            const context = createTestContext({
                triggeringEnvelope: createMockInboundEnvelope({
                    metadata: { teamName: "alpha-team", branchName: "feature/xyz" },
                }),
            });

            const config: AskConfig = {
                recipient: "recipient-pubkey",
                context: "Full context here",
                title: "Team-scoped question",
                questions: [
                    {
                        type: "question",
                        title: "Question",
                        question: "What should I do next?",
                    },
                ],
            };

            await publisher.ask(config, context);

            const event = expectSingleEnqueuedEvent();

            const teamTag = event.tags.find((tag) => tag[0] === "team");
            expect(teamTag).toBeDefined();
            expect(teamTag?.[1]).toBe("alpha-team");

            const branchTag = event.tags.find((tag) => tag[0] === "branch");
            expect(branchTag).toBeDefined();
            expect(branchTag?.[1]).toBe("feature/xyz");
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

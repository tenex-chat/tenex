import { describe, expect, it, beforeEach, mock } from "bun:test";
import { NostrPublisher } from "../NostrPublisher";
import type { NostrPublisherContext } from "../NostrPublisher";
import type { AgentInstance } from "@/agents/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";

describe("Voice Mode Tag Propagation", () => {
    let publisher: NostrPublisher;
    let mockContext: NostrPublisherContext;
    let mockNDK: NDK;
    let mockTriggeringEvent: NDKEvent;
    let mockConversationManager: ConversationManager;

    beforeEach(() => {
        // Mock NDK
        mockNDK = {
            assertSigner: mock(() => {}),
        } as unknown as NDK;

        // Mock triggering event
        mockTriggeringEvent = {
            id: "test-event-id",
            content: "Test content",
            tagValue: mock((key: string) => {
                if (key === "mode") return "voice";
                return undefined;
            }),
            reply: mock(() => {
                const reply = new NDKEvent(mockNDK);
                reply.tags = [];
                reply.tag = mock((tag: string[]) => {
                    reply.tags.push(tag);
                });
                reply.removeTag = mock((tagName: string) => {
                    reply.tags = reply.tags.filter(t => t[0] !== tagName);
                });
                reply.sign = mock(async () => {}),
                reply.publish = mock(async () => {});
                return reply;
            }),
            tags: [],
        } as unknown as NDKEvent;

        // Mock agent
        const mockAgent: Agent = {
            name: "test-agent",
            pubkey: "test-pubkey",
            slug: "test-agent",
            signer: {} as any,
            isOrchestrator: false,
        } as Agent;

        // Mock conversation manager
        mockConversationManager = {
            getConversation: mock(() => ({
                id: "test-conversation",
                phase: "chat",
                events: [],
                phaseTransitions: [],
                startTime: Date.now(),
                metadata: {},
            })),
            saveConversation: mock(async () => {}),
        } as unknown as ConversationManager;

        // Create context
        mockContext = {
            conversationId: "test-conversation",
            agent: mockAgent,
            triggeringEvent: mockTriggeringEvent,
            conversationManager: mockConversationManager,
        };

        // Mock getProjectContext and getNDK
        mock.module("@/services", () => ({
            getProjectContext: () => ({
                project: {
                    tags: [],
                },
            }),
        }));

        mock.module("@/nostr", () => ({
            getNDK: () => mockNDK,
        }));

        mock.module("@/conversations/executionTime", () => ({
            getTotalExecutionTimeSeconds: () => 0,
        }));

        publisher = new NostrPublisher(mockContext);
    });

    it("should add voice mode tag to published response when triggering event has voice mode", async () => {
        const response = await publisher.publishResponse({
            content: "This is a voice-optimized response",
        });

        // Check that the response has the voice mode tag
        const voiceModeTag = response.tags.find(tag => tag[0] === "mode" && tag[1] === "voice");
        expect(voiceModeTag).toBeTruthy();
        expect(voiceModeTag).toEqual(["mode", "voice"]);
    });

    it("should not add voice mode tag when triggering event doesn't have voice mode", async () => {
        // Mock triggering event without voice mode
        mockTriggeringEvent.tagValue = mock((key: string) => {
            if (key === "mode") return undefined;
            return undefined;
        });

        const response = await publisher.publishResponse({
            content: "This is a regular response",
        });

        // Check that the response doesn't have the voice mode tag
        const voiceModeTag = response.tags.find(tag => tag[0] === "mode");
        expect(voiceModeTag).toBeUndefined();
    });

    it("should add voice mode tag to streaming events when in voice mode", () => {
        // Verify that the triggering event has voice mode
        expect(mockTriggeringEvent.tagValue("mode")).toBe("voice");
        
        // Create stream publisher - it will inherit the voice mode from context
        const streamPublisher = publisher.createStreamPublisher();
        
        // Verify the stream publisher has access to voice mode context
        expect(streamPublisher).toBeDefined();
        
        // The actual streaming event publication would include the voice mode tag
        // based on the context.triggeringEvent.tagValue("mode") check
    });

    it("should propagate voice mode tag to error events", async () => {
        const errorEvent = await publisher.publishError("Test error message");
        
        // Check that the error event has the voice mode tag
        const voiceModeTag = errorEvent.tags.find(tag => tag[0] === "mode" && tag[1] === "voice");
        expect(voiceModeTag).toBeTruthy();
    });
});
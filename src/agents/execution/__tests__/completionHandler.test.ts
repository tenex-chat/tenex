import { describe, it, expect, beforeEach, mock } from "bun:test";
import { handleAgentCompletion } from "../completionHandler";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("completionHandler", () => {
    let mockPublisher: NostrPublisher;
    let mockAgent: AgentInstance;
    let mockPMAgent: AgentInstance;
    let mockGetProjectContext: any;

    beforeEach(() => {
        // Reset mocks
        mock.restore();

        // Setup mock PM agent
        mockPMAgent = {
            id: "pm-123",
            pubkey: "pm-pubkey",
            name: "ProjectManager",
            description: "Project Manager agent",
            capabilities: [],
            tools: [],
        } as Agent;

        // Mock ProjectContext
        mockGetProjectContext = mock(() => ({
            getProjectAgent: () => mockPMAgent,
        }));
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: mockGetProjectContext,
        }));

        // Mock logger
        mock.module("@/utils/logger", () => ({
            logger: {
                info: mock(() => {}),
                error: mock(() => {}),
                warn: mock(() => {}),
                debug: mock(() => {}),
            },
        }));

        // Setup mock publisher with createBaseReply method
        const mockReply = {
            content: "",
            tags: [],
            tag: mock((tag: string[]) => {}),
            rawEvent: mock(() => ({})),
            id: "mock-event-id",
        };
        
        mockPublisher = {
            publishResponse: mock(() => Promise.resolve()),
            createBaseReply: mock(() => mockReply),
            context: {
                triggeringEvent: {
                    id: "triggering-event-id",
                    pubkey: "user-pubkey",
                    tagValue: mock(() => undefined),
                },
                agent: mockAgent,
            },
        } as unknown as NostrPublisher;

        // Setup mock agent
        mockAgent = {
            id: "agent-123",
            pubkey: "agent-pubkey",
            name: "TestAgent",
            slug: "test-agent",
            description: "Test agent",
            capabilities: [],
            tools: [],
        } as AgentInstance;
    });

    it("should handle basic completion successfully", async () => {
        const response = "Task completed successfully";
        const conversationId = "conv-123";

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Verify the result
        expect(result.completion).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: "user-pubkey", // Now responds to triggering event author
            },
        });
        expect(result.event).toBeDefined();

        // Verify the event was created with correct p-tag
        const mockReplyTag = mockPublisher.createBaseReply().tag as any;
        expect(mockReplyTag).toHaveBeenCalledWith(["p", "user-pubkey"]);
    });

    it("should handle completion with custom summary", async () => {
        const response = "Detailed task completion with multiple steps...";
        const summary = "Created authentication system";
        const conversationId = "conv-456";

        const result = await handleAgentCompletion({
            response,
            summary,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Verify the result uses the custom summary
        expect(result.completion.completion.summary).toBe(summary);
        expect(result.completion.completion.response).toBe(response);

        // Verify the result has both completion and event
        expect(result.completion).toBeDefined();
        expect(result.event).toBeDefined();
    });

    it("should always route to PM agent when no explicit triggering event", async () => {
        const response = "Task done";
        const conversationId = "conv-789";

        await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Verify it retrieved the PM
        expect(mockGetProjectContext).toHaveBeenCalled();

        // Verify it created reply event with p-tag to triggering author
        const mockReplyTag = mockPublisher.createBaseReply().tag as any;
        expect(mockReplyTag).toHaveBeenCalledWith(["p", "user-pubkey"]);
    });

    it("should handle completion with triggering event", async () => {
        const response = "Task completed";
        const conversationId = "conv-999";
        const triggeringEvent = {
            id: "event-123",
            pubkey: "user-pubkey",
        } as NDKEvent;

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent,
        });

        // With explicit triggering event, should use its pubkey
        expect(result.completion).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: "user-pubkey", // Uses triggering event's pubkey
            },
        });
        expect(result.event).toBeDefined();
    });

    it("should return event without publishing", async () => {
        const response = "Task completed";
        const conversationId = "conv-no-publish";

        // The completion handler no longer publishes, just creates the event
        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });
        
        // Should return both completion and unpublished event
        expect(result.completion).toBeDefined();
        expect(result.event).toBeDefined();
        expect(result.event.content).toBe(response);
    });

    it("should handle empty response", async () => {
        const response = "";
        const conversationId = "conv-empty";

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Should still work with empty response
        expect(result.completion).toEqual({
            type: "complete",
            completion: {
                response: "",
                summary: "",
                nextAgent: "user-pubkey",
            },
        });
        expect(result.event).toBeDefined();
    });

    it("should handle very long responses", async () => {
        const response = "A".repeat(10000); // Very long response
        const summary = "Long task completed";
        const conversationId = "conv-long";

        const result = await handleAgentCompletion({
            response,
            summary,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Should handle long responses without truncation
        expect(result.completion.completion.response).toBe(response);
        expect(result.completion.completion.summary).toBe(summary);
    });

    it("should preserve completion metadata structure", async () => {
        const response = "Task completed";
        const conversationId = "conv-metadata";

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
            triggeringEvent: mockPublisher.context.triggeringEvent as NDKEvent,
        });

        // Verify the exact structure of completion metadata
        expect(result.completion).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: "user-pubkey", // Now responds to triggering event author
            },
        });
    });
});
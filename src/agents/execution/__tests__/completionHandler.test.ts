import { describe, it, expect, beforeEach, mock } from "bun:test";
import { handleAgentCompletion } from "../completionHandler";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("completionHandler", () => {
    let mockPublisher: NostrPublisher;
    let mockAgent: AgentInstance;
    let mockOrchestratorAgent: AgentInstance;
    let mockGetProjectContext: any;

    beforeEach(() => {
        // Reset mocks
        mock.restore();

        // Setup mock orchestrator agent
        mockOrchestratorAgent = {
            id: "orchestrator-123",
            pubkey: "orchestrator-pubkey",
            name: "Orchestrator",
            description: "Orchestrator agent",
            capabilities: [],
            tools: [],
        } as Agent;

        // Mock ProjectContext
        mockGetProjectContext = mock(() => ({
            getProjectAgent: () => mockOrchestratorAgent,
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

        // Setup mock publisher
        mockPublisher = {
            publishResponse: mock(() => Promise.resolve()),
        } as unknown as NostrPublisher;

        // Setup mock agent
        mockAgent = {
            id: "agent-123",
            pubkey: "agent-pubkey",
            name: "TestAgent",
            description: "Test agent",
            capabilities: [],
            tools: [],
        } as Agent;
    });

    it("should handle basic completion successfully", async () => {
        const response = "Task completed successfully";
        const conversationId = "conv-123";

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
        });

        // Verify the result
        expect(result).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: mockOrchestratorAgent.pubkey,
            },
        });

        // Verify publishResponse was called correctly
        expect(mockPublisher.publishResponse).toHaveBeenCalledWith({
            content: response,
            destinationPubkeys: [mockOrchestratorAgent.pubkey],
            completeMetadata: {
                type: "complete",
                completion: {
                    response,
                    summary: response,
                    nextAgent: mockOrchestratorAgent.pubkey,
                },
            },
        });
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
        });

        // Verify the result uses the custom summary
        expect(result.completion.summary).toBe(summary);
        expect(result.completion.response).toBe(response);

        // Verify publishResponse was called with custom summary
        expect(mockPublisher.publishResponse).toHaveBeenCalledWith({
            content: response,
            destinationPubkeys: [mockOrchestratorAgent.pubkey],
            completeMetadata: {
                type: "complete",
                completion: {
                    response,
                    summary,
                    nextAgent: mockOrchestratorAgent.pubkey,
                },
            },
        });
    });

    it("should always route to orchestrator agent", async () => {
        const response = "Task done";
        const conversationId = "conv-789";

        await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
        });

        // Verify it retrieved the orchestrator
        expect(mockGetProjectContext).toHaveBeenCalled();

        // Verify it published to orchestrator's pubkey
        expect(mockPublisher.publishResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                destinationPubkeys: [mockOrchestratorAgent.pubkey],
            })
        );
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

        // The triggering event is passed but not used in the current implementation
        // This test ensures it doesn't break when provided
        expect(result).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: mockOrchestratorAgent.pubkey,
            },
        });
    });

    it("should handle publisher error gracefully", async () => {
        const response = "Task completed";
        const conversationId = "conv-error";
        const publishError = new Error("Failed to publish to Nostr");

        // Make publisher throw an error
        mockPublisher.publishResponse = mock(() => Promise.reject(publishError));

        // The function should throw the error up
        await expect(
            handleAgentCompletion({
                response,
                agent: mockAgent,
                conversationId,
                publisher: mockPublisher,
            })
        ).rejects.toThrow("Failed to publish to Nostr");
    });

    it("should handle empty response", async () => {
        const response = "";
        const conversationId = "conv-empty";

        const result = await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
        });

        // Should still work with empty response
        expect(result).toEqual({
            type: "complete",
            completion: {
                response: "",
                summary: "",
                nextAgent: mockOrchestratorAgent.pubkey,
            },
        });
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
        });

        // Should handle long responses without truncation
        expect(result.completion.response).toBe(response);
        expect(result.completion.summary).toBe(summary);
    });

    it("should preserve completion metadata structure", async () => {
        const response = "Task completed";
        const conversationId = "conv-metadata";

        await handleAgentCompletion({
            response,
            agent: mockAgent,
            conversationId,
            publisher: mockPublisher,
        });

        // Verify the exact structure of completeMetadata
        const publishResponseMock = mockPublisher.publishResponse as any;
        const call = publishResponseMock.mock.calls[0][0];
        expect(call.completeMetadata).toEqual({
            type: "complete",
            completion: {
                response,
                summary: response,
                nextAgent: mockOrchestratorAgent.pubkey,
            },
        });
    });
});
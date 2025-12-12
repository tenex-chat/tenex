import { describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { DelegationService } from "@/services/delegation";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("DelegationService - Self-delegation validation (simplified)", () => {
    it("should reject self-delegation when phase is not provided", async () => {
        // Create minimal mocks inline
        const mockAgent = {
            slug: "test-agent",
            name: "Test Agent",
            pubkey: "test-pubkey-123",
        } as AgentInstance;

        const mockConversationCoordinator = {
            getConversation: () => ({
                history: [{ id: "root-event-id" } as NDKEvent],
            }),
        } as any;

        const mockTriggeringEvent = { id: "triggering-event-id" } as NDKEvent;

        const mockAgentPublisher = {
            delegate: () => Promise.resolve({ batchId: "test-batch-id" }),
        } as any;

        const delegationService = new DelegationService(
            mockAgent,
            "test-conversation-id",
            mockConversationCoordinator,
            mockTriggeringEvent,
            mockAgentPublisher,
            "/test/project/path",
            "main"
        );

        // Test: self-delegation without phase should throw
        const intent = {
            delegations: [
                {
                    recipient: "test-pubkey-123", // Same as agent's pubkey
                    request: "Do something",
                    // No phase provided
                },
            ],
        };

        try {
            await delegationService.execute(intent);
            // Should not reach here
            expect(true).toBe(false);
        } catch (error: any) {
            expect(error.message).toContain("Self-delegation is not permitted");
            expect(error.message).toContain("test-agent");
            expect(error.message).toContain("specifying a phase");
        }
    });

    it("should allow self-delegation when phase is provided", async () => {
        // Create minimal mocks inline
        const mockAgent = {
            slug: "test-agent",
            name: "Test Agent",
            pubkey: "test-pubkey-123",
        } as AgentInstance;

        const mockConversationCoordinator = {
            getConversation: () => ({
                history: [{ id: "root-event-id" } as NDKEvent],
            }),
        } as any;

        const mockTriggeringEvent = { id: "triggering-event-id" } as NDKEvent;

        const mockAgentPublisher = {
            delegate: () => Promise.resolve({ batchId: "test-batch-id" }),
        } as any;

        const delegationService = new DelegationService(
            mockAgent,
            "test-conversation-id",
            mockConversationCoordinator,
            mockTriggeringEvent,
            mockAgentPublisher,
            "/test/project/path",
            "main"
        );

        // Mock DelegationRegistryService directly
        const DelegationRegistryService = require("@/services/delegation").DelegationRegistryService;
        const originalGetInstance = DelegationRegistryService.getInstance;
        DelegationRegistryService.getInstance = () => ({
            waitForBatchCompletion: () =>
                Promise.resolve([
                    {
                        response: "Test response",
                        summary: "Test summary",
                        assignedTo: "test-pubkey-123",
                    },
                ]),
        });

        try {
            // Test: self-delegation with phase should succeed
            const intent = {
                delegations: [
                    {
                        recipient: "test-pubkey-123", // Same as agent's pubkey
                        request: "Do something in this phase",
                        phase: "planning", // Phase is provided
                    },
                ],
            };

            const result = await delegationService.execute(intent);

            expect(result).toBeDefined();
            expect(result.type).toBe("delegation_responses");
            expect(result.responses).toBeArray();
        } finally {
            // Restore original
            DelegationRegistryService.getInstance = originalGetInstance;
        }
    });

    it("should allow delegation to others without phase", async () => {
        // Create minimal mocks inline
        const mockAgent = {
            slug: "test-agent",
            name: "Test Agent",
            pubkey: "test-pubkey-123",
        } as AgentInstance;

        const mockConversationCoordinator = {
            getConversation: () => ({
                history: [{ id: "root-event-id" } as NDKEvent],
            }),
        } as any;

        const mockTriggeringEvent = { id: "triggering-event-id" } as NDKEvent;

        const mockAgentPublisher = {
            delegate: () => Promise.resolve({ batchId: "test-batch-id" }),
        } as any;

        const delegationService = new DelegationService(
            mockAgent,
            "test-conversation-id",
            mockConversationCoordinator,
            mockTriggeringEvent,
            mockAgentPublisher,
            "/test/project/path",
            "main"
        );

        // Mock DelegationRegistryService directly
        const DelegationRegistryService = require("@/services/delegation").DelegationRegistryService;
        const originalGetInstance = DelegationRegistryService.getInstance;
        DelegationRegistryService.getInstance = () => ({
            waitForBatchCompletion: () =>
                Promise.resolve([
                    {
                        response: "Test response",
                        summary: "Test summary",
                        assignedTo: "other-agent-pubkey",
                    },
                ]),
        });

        try {
            // Test: delegation to others without phase should succeed
            const intent = {
                delegations: [
                    {
                        recipient: "other-agent-pubkey", // Different from agent's pubkey
                        request: "Do something",
                        // No phase needed when delegating to others
                    },
                ],
            };

            const result = await delegationService.execute(intent);

            expect(result).toBeDefined();
            expect(result.type).toBe("delegation_responses");
            expect(result.responses).toBeArray();
        } finally {
            // Restore original
            DelegationRegistryService.getInstance = originalGetInstance;
        }
    });
});

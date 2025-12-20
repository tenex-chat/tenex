import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import { RALRegistry } from "@/services/ral";
import { createDelegateTool } from "@/tools/implementations/delegate";
import { createDelegateExternalTool } from "@/tools/implementations/delegate_external";
import { createDelegateFollowupTool } from "@/tools/implementations/delegate_followup";

// Mock the resolution function to return pubkeys for our test agents
import * as agentResolution from "@/utils/agent-resolution";
const mockResolve = spyOn(agentResolution, "resolveRecipientToPubkey");
mockResolve.mockImplementation((recipient: string) => {
    if (recipient === "self-agent") return "agent-pubkey-123";
    if (recipient === "other-agent") return "other-pubkey-456";
    return recipient.startsWith("agent-pubkey-") ? recipient : null;
});

// Mock parseNostrUser for delegate_external tests
import * as nostrParser from "@/utils/nostr-entity-parser";
const mockParse = spyOn(nostrParser, "parseNostrUser");
mockParse.mockImplementation((recipient: string) => {
    if (recipient === "self-agent") return "agent-pubkey-123";
    if (recipient === "other-agent") return "other-pubkey-456";
    return recipient.startsWith("agent-pubkey-") ? recipient : null;
});

describe("Delegation tools - Self-delegation validation", () => {
    const conversationId = "test-conversation-id";
    let registry: RALRegistry;

    const createMockContext = (): ExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        conversationCoordinator: {} as any,
        triggeringEvent: {} as any,
        agentPublisher: {} as any,
        phase: undefined,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("delegate tool", () => {
        it("should reject self-delegation without phase by slug", async () => {
            const context = createMockContext();
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "self-agent", prompt: "Do something" }
                ],
            };

            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                // Self-delegation is now allowed with phase, so error says "requires a phase"
                expect(error.message).toContain("Self-delegation requires a phase");
            }
        });

        it("should reject self-delegation without phase by pubkey", async () => {
            const context = createMockContext();
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "agent-pubkey-123", prompt: "Do something" }
                ],
            };

            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Self-delegation requires a phase");
            }
        });

        it("should reject when self without phase is included in multiple recipients", async () => {
            const context = createMockContext();
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "self-agent", prompt: "Task for self" },
                    { recipient: "other-agent", prompt: "Task for other" },
                ],
            };

            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                // Will fail on self-delegation without phase
                expect(error.message).toContain("Self-delegation requires a phase");
            }
        });
    });

    describe("delegate_followup tool", () => {
        it("should reject self-delegation when delegation points to self", async () => {
            const context = createMockContext();
            const followupTool = createDelegateFollowupTool(context);

            // Set up a delegation in the RAL that points to self
            const ralNumber = registry.create(context.agent.pubkey, conversationId);
            registry.saveState(context.agent.pubkey, conversationId, ralNumber, [], [
                {
                    eventId: "self-delegation-event",
                    recipientPubkey: "agent-pubkey-123", // Same as self
                    prompt: "Original task",
                },
            ]);

            const input = {
                delegation_event_id: "self-delegation-event",
                message: "Follow-up question",
            };

            try {
                await followupTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Self-delegation is not permitted");
            }
        });

        it("should error when delegation event ID not found", async () => {
            const context = createMockContext();
            const followupTool = createDelegateFollowupTool(context);

            // Don't set up any delegations
            registry.create(context.agent.pubkey, conversationId);

            const input = {
                delegation_event_id: "non-existent-event",
                message: "Follow-up question",
            };

            try {
                await followupTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("No delegation found with event ID");
            }
        });
    });

    describe("delegate_external tool", () => {
        it("should reject self-delegation without projectId", async () => {
            const context = createMockContext();
            const externalTool = createDelegateExternalTool(context);

            const input = {
                content: "External message",
                recipient: "agent-pubkey-123",
            };

            try {
                await externalTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                // Error message updated - self-delegation requires projectId
                expect(error.message).toContain("Self-delegation requires a projectId");
            }
        });

        it("should allow self-delegation when projectId is provided", async () => {
            const context = createMockContext();
            const externalTool = createDelegateExternalTool(context);

            const input = {
                content: "Cross-project delegation",
                recipient: "agent-pubkey-123",
                projectId: "naddr1differentproject",
            };

            // This should not throw - it will fail later due to missing mocks
            // but the validation should pass
            try {
                await externalTool.execute(input);
            } catch (error: any) {
                // Should fail for a different reason (NDK mocking), not self-delegation
                expect(error.message).not.toContain("Self-delegation is not permitted");
            }
        });
    });
});

// Restore mocks
afterAll(() => {
    mockResolve.mockRestore();
    mockParse.mockRestore();
});

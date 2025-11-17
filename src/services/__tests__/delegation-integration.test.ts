/**
 * Integration test to verify the unified delegation approach works correctly
 * This test uses NDK test utilities for realistic simulation
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { RelayMock, RelayPoolMock, SignerGenerator, UserGenerator } from "@nostr-dev-kit/ndk/test";
import type { AgentInstance } from "@/agents/types";
import { DelegationRegistry } from "../DelegationRegistry";
import { DelegationCompletionHandler } from "@/event-handler/DelegationCompletionHandler";
import { logger } from "@/utils/logger";

describe("Delegation System Integration Test", () => {
    let ndk: NDK;
    let pool: RelayPoolMock;
    let relay: RelayMock;
    let registry: DelegationRegistry;
    let delegatingAgent: AgentInstance;
    let recipient1: AgentInstance;
    let recipient2: AgentInstance;
    let recipient3: AgentInstance;

    beforeEach(async () => {
        // Initialize registry
        await DelegationRegistry.initialize();
        registry = DelegationRegistry.getInstance();
        await registry.clear();

        // Set up NDK with mock relay infrastructure
        pool = new RelayPoolMock();
        ndk = new NDK({
            explicitRelayUrls: ["wss://relay.test.com"],
        });

        // @ts-expect-error - Replace pool with mock
        ndk.pool = pool;

        // Add mock relay
        relay = pool.addMockRelay("wss://relay.test.com");
        relay.connect();

        // Create test agents using deterministic NDK users
        const alice = await UserGenerator.getUser("alice", ndk);
        const bob = await UserGenerator.getUser("bob", ndk);
        const carol = await UserGenerator.getUser("carol", ndk);
        const dave = await UserGenerator.getUser("dave", ndk);

        delegatingAgent = {
            slug: "delegator",
            name: "Delegating Agent",
            pubkey: alice.pubkey,
            signer: SignerGenerator.getSigner("alice"),
        } as AgentInstance;

        recipient1 = {
            slug: "recipient1",
            name: "Recipient 1",
            pubkey: bob.pubkey,
            signer: SignerGenerator.getSigner("bob"),
        } as AgentInstance;

        recipient2 = {
            slug: "recipient2",
            name: "Recipient 2",
            pubkey: carol.pubkey,
            signer: SignerGenerator.getSigner("carol"),
        } as AgentInstance;

        recipient3 = {
            slug: "recipient3",
            name: "Recipient 3",
            pubkey: dave.pubkey,
            signer: SignerGenerator.getSigner("dave"),
        } as AgentInstance;
    });

    describe("Single-Recipient Delegation", () => {
        it("should handle single delegation without synthetic IDs", async () => {
            const rootConversationId = "conv_single_123";
            const delegationRequest = "Please analyze this code";

            // 1. Register delegation using unified approach
            const batchId = await registry.registerDelegation({
                delegationEventId: "delegation_event_single_456", // Actual event ID
                recipients: [
                    {
                        pubkey: recipient1.pubkey,
                        request: delegationRequest,
                        phase: "analysis",
                    },
                ],
                delegatingAgent,
                rootConversationId: rootConversationId,
                originalRequest: delegationRequest,
            });

            console.log("✅ Single delegation registered:", {
                batchId,
                eventId: "delegation_event_single_456",
                recipient: recipient1.pubkey.substring(0, 16),
            });

            // 2. Verify delegation can be found by conversation key
            const delegation = registry.getDelegationByConversationKey(
                rootConversationId,
                delegatingAgent.pubkey,
                recipient1.pubkey
            );

            expect(delegation).toBeDefined();
            expect(delegation?.delegationEventId).toBe("delegation_event_single_456");
            expect(delegation?.status).toBe("pending");

            // 3. Simulate completion
            const result = await registry.recordTaskCompletion({
                conversationId: rootConversationId,
                fromPubkey: delegatingAgent.pubkey,
                toPubkey: recipient1.pubkey,
                completionEventId: "completion_single_789",
                response: "Analysis complete: The code is clean",
                summary: "Code analysis",
            });

            expect(result.batchComplete).toBe(true);
            expect(result.remainingDelegations).toBe(0);

            console.log("✅ Single delegation completed successfully");
        });
    });

    describe("Multi-Recipient Delegation", () => {
        it("should handle multi-recipient delegation with shared event ID", async () => {
            const rootConversationId = "conv_multi_456";
            const delegationRequest = "Review this from different perspectives";
            const sharedEventId = "delegation_event_multi_789";

            // 1. Register multi-recipient delegation
            const recipients = [recipient1, recipient2, recipient3];
            const batchId = await registry.registerDelegation({
                delegationEventId: sharedEventId, // Same event ID for all
                recipients: recipients.map((r) => ({
                    pubkey: r.pubkey,
                    request: delegationRequest,
                    phase: "review",
                })),
                delegatingAgent,
                rootConversationId: rootConversationId,
                originalRequest: delegationRequest,
            });

            console.log("✅ Multi-recipient delegation registered:", {
                batchId,
                sharedEventId,
                recipientCount: recipients.length,
            });

            // 2. Verify each recipient has their own record with shared event ID
            for (const recipient of recipients) {
                const delegation = registry.getDelegationByConversationKey(
                    rootConversationId,
                    delegatingAgent.pubkey,
                    recipient.pubkey
                );

                expect(delegation).toBeDefined();
                expect(delegation?.delegationEventId).toBe(sharedEventId);
                expect(delegation?.status).toBe("pending");
            }

            // 3. Test finding by event ID and responder
            const foundByEvent = registry.findDelegationByEventAndResponder(
                sharedEventId,
                recipient2.pubkey
            );
            expect(foundByEvent).toBeDefined();
            expect(foundByEvent?.assignedTo.pubkey).toBe(recipient2.pubkey);

            // 4. Complete delegations one by one
            let completedCount = 0;
            for (const recipient of recipients) {
                const result = await registry.recordTaskCompletion({
                    conversationId: rootConversationId,
                    fromPubkey: delegatingAgent.pubkey,
                    toPubkey: recipient.pubkey,
                    completionEventId: `completion_${recipient.slug}`,
                    response: `Review from ${recipient.name}`,
                });

                completedCount++;
                const expectComplete = completedCount === recipients.length;

                expect(result.batchComplete).toBe(expectComplete);
                expect(result.remainingDelegations).toBe(recipients.length - completedCount);

                console.log(`✅ Recipient ${completedCount}/${recipients.length} completed`, {
                    recipient: recipient.slug,
                    batchComplete: result.batchComplete,
                });
            }

            // 5. Verify all are completed
            const completions = registry.getBatchCompletions(batchId);
            expect(completions).toHaveLength(recipients.length);

            console.log("✅ Multi-recipient delegation completed successfully");
        });
    });

    describe("Completion Event Processing", () => {
        it("should process completion events using conversation key lookup", async () => {
            const rootConversationId = "conv_completion_test";
            const delegationEventId = "delegation_completion_123";

            // Setup delegation
            await registry.registerDelegation({
                delegationEventId: delegationEventId,
                recipients: [
                    {
                        pubkey: recipient1.pubkey,
                        request: "Test task",
                    },
                ],
                delegatingAgent,
                rootConversationId: rootConversationId,
                originalRequest: "Test task",
            });

            // Create mock completion event
            const mockCompletionEvent = {
                id: "completion_event_456",
                pubkey: recipient1.pubkey,
                content: "Task completed",
                tags: [
                    ["e", delegationEventId],
                    ["p", delegatingAgent.pubkey],
                    ["status", "completed"],
                ],
                tagValue: (tag: string) => {
                    if (tag === "status") return "completed";
                    return undefined;
                },
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", delegationEventId]];
                    if (tag === "p") return [["p", delegatingAgent.pubkey]];
                    return [];
                },
            } as Partial<NDKEvent>;

            // Mock conversation
            const mockConversation = {
                id: rootConversationId,
                history: [],
            };

            // Process completion through handler
            const result = await DelegationCompletionHandler.handleDelegationCompletion(
                mockCompletionEvent as NDKEvent,
                mockConversation as any,
                {} as any // Mock coordinator
            );

            // The handler should find the delegation
            const delegation = registry.getDelegationByConversationKey(
                rootConversationId,
                delegatingAgent.pubkey,
                recipient1.pubkey
            );

            expect(delegation?.status).toBe("completed"); // Handler calls recordTaskCompletion internally

            console.log("✅ Completion event processing validated");
        });
    });

    describe("No Synthetic IDs Verification", () => {
        it("should never create synthetic IDs in the new system", async () => {
            const logSpy = spyOn(logger, "info");
            const debugSpy = spyOn(logger, "debug");

            // Test single recipient
            await registry.registerDelegation({
                delegationEventId: "event_no_synthetic_1",
                recipients: [
                    {
                        pubkey: recipient1.pubkey,
                        request: "Test",
                    },
                ],
                delegatingAgent,
                rootConversationId: "conv_no_synthetic",
                originalRequest: "Test",
            });

            // Test multi recipient
            await registry.registerDelegation({
                delegationEventId: "event_no_synthetic_2",
                recipients: [
                    { pubkey: recipient1.pubkey, request: "Test" },
                    { pubkey: recipient2.pubkey, request: "Test" },
                ],
                delegatingAgent,
                rootConversationId: "conv_no_synthetic_multi",
                originalRequest: "Test",
            });

            // Check logs for any synthetic ID patterns (eventId:pubkey)
            const allLogs = [
                ...logSpy.mock.calls.map((c) => JSON.stringify(c)),
                ...debugSpy.mock.calls.map((c) => JSON.stringify(c)),
            ].join("\n");

            // Look for patterns that would indicate synthetic IDs
            const syntheticIdPattern = /event_no_synthetic_[12]:[a-f0-9]+/i;
            expect(allLogs).not.toMatch(syntheticIdPattern);

            console.log("✅ Verified: No synthetic IDs created");

            logSpy.mockRestore();
            debugSpy.mockRestore();
        });
    });
});

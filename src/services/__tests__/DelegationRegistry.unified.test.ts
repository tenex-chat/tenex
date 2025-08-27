import { DelegationRegistry } from "../DelegationRegistry";
import { logger } from "@/utils/logger";
import type { AgentInstance } from "@/agents/types";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { generateSecretKey, nip19 } from "nostr-tools";

// Mock the logger to capture log output
const logSpy = jest.spyOn(logger, "info");
const debugSpy = jest.spyOn(logger, "debug");
const warnSpy = jest.spyOn(logger, "warn");

describe("DelegationRegistry - Unified Approach (No Synthetic IDs)", () => {
  let registry: DelegationRegistry;
  
  // Generate proper test keys
  const secretKey1 = generateSecretKey();
  const nsec1 = nip19.nsecEncode(secretKey1);
  const secretKey2 = generateSecretKey();
  const nsec2 = nip19.nsecEncode(secretKey2);

  const mockAgent: AgentInstance = {
    slug: "test-agent",
    name: "Test Agent",
    pubkey: "agent1_pubkey_1234567890abcdef",
    signer: new NDKPrivateKeySigner(nsec1),
    prompts: { systemPrompt: "test" },
    description: "Test agent",
    capabilities: [],
    model: "test-model",
    nsec: nsec1,
    project: undefined,
  };

  const mockAgent2: AgentInstance = {
    slug: "test-agent-2",
    name: "Test Agent 2",
    pubkey: "agent2_pubkey_fedcba0987654321",
    signer: new NDKPrivateKeySigner(nsec2),
    prompts: { systemPrompt: "test" },
    description: "Test agent 2",
    capabilities: [],
    model: "test-model",
    nsec: nsec2,
    project: undefined,
  };

  beforeAll(async () => {
    await DelegationRegistry.initialize();
  });

  beforeEach(async () => {
    registry = DelegationRegistry.getInstance();
    await registry.clear();
    logSpy.mockClear();
    debugSpy.mockClear();
    warnSpy.mockClear();
  });

  describe("Single-Recipient Delegation (formerly external)", () => {
    it("should register single-recipient delegation using unified approach", async () => {
      const delegationEventId = "single_delegation_event_123";
      const recipientPubkey = "recipient_pubkey_abc123";
      const rootConversationId = "root_conv_789";
      const request = "Please analyze this code";

      // Register using unified approach with single recipient
      const batchId = await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: [{
          pubkey: recipientPubkey,
          request: request,
          phase: "analysis",
        }],
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: request,
      });

      expect(batchId).toBeDefined();
      
      // Verify logging
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("✅ Delegation registered"),
        expect.objectContaining({
          batchId,
          delegationEventId: expect.any(String),
          recipientCount: 1,
          delegatingAgent: "test-agent",
        })
      );

      // Verify delegation can be found by conversation key
      const delegation = registry.getDelegationByConversationKey(
        rootConversationId,
        mockAgent.pubkey,
        recipientPubkey
      );

      expect(delegation).toBeDefined();
      expect(delegation?.delegationEventId).toBe(delegationEventId);
      expect(delegation?.status).toBe("pending");
      expect(delegation?.assignedTo.pubkey).toBe(recipientPubkey);

      // Verify we can find it by event ID and responder
      const foundByEvent = registry.findDelegationByEventAndResponder(
        delegationEventId,
        recipientPubkey
      );
      expect(foundByEvent).toBeDefined();
      expect(foundByEvent?.delegationEventId).toBe(delegationEventId);
    });

    it("should complete single-recipient delegation", async () => {
      const delegationEventId = "single_delegation_event_456";
      const recipientPubkey = "recipient_pubkey_def456";
      const rootConversationId = "root_conv_101";
      const request = "Explain this function";

      // Register delegation
      const batchId = await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: [{
          pubkey: recipientPubkey,
          request: request,
        }],
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: request,
      });

      // Complete the delegation
      const result = await registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipientPubkey,
        completionEventId: "completion_event_123",
        response: "The function does X, Y, Z",
        summary: "Function explanation",
      });

      expect(result.batchComplete).toBe(true);
      expect(result.batchId).toBe(batchId);
      expect(result.remainingDelegations).toBe(0);

      // Verify delegation status updated
      const delegation = registry.getDelegationByConversationKey(
        rootConversationId,
        mockAgent.pubkey,
        recipientPubkey
      );
      expect(delegation?.status).toBe("completed");
      expect(delegation?.completion?.response).toBe("The function does X, Y, Z");
    });
  });

  describe("Multi-Recipient Delegation", () => {
    it("should register multi-recipient delegation with same event ID", async () => {
      const delegationEventId = "multi_delegation_event_789";
      const recipients = [
        "recipient1_pubkey_111",
        "recipient2_pubkey_222",
        "recipient3_pubkey_333"
      ];
      const rootConversationId = "root_conv_202";
      const request = "Review this PR from different perspectives";

      // Register using unified approach with multiple recipients
      const batchId = await registry.registerDelegation({
        delegationEventId: delegationEventId, // Same event ID for all recipients
        recipients: recipients.map(recipientPubkey => ({
          pubkey: recipientPubkey,
          request: request,
          phase: "review",
        })),
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: request,
      });

      expect(batchId).toBeDefined();

      // Verify logging shows multi-recipient
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("✅ Delegation registered"),
        expect.objectContaining({
          batchId,
          delegationEventId: expect.any(String),
          recipientCount: 3,
          delegatingAgent: "test-agent",
        })
      );

      // Verify each recipient has their own delegation record
      for (const recipientPubkey of recipients) {
        const delegation = registry.getDelegationByConversationKey(
          rootConversationId,
          mockAgent.pubkey,
          recipientPubkey
        );

        expect(delegation).toBeDefined();
        expect(delegation?.delegationEventId).toBe(delegationEventId); // All share same event ID
        expect(delegation?.status).toBe("pending");
        expect(delegation?.assignedTo.pubkey).toBe(recipientPubkey);

        // Verify we can find each by event ID and responder
        const foundByEvent = registry.findDelegationByEventAndResponder(
          delegationEventId,
          recipientPubkey
        );
        expect(foundByEvent).toBeDefined();
        expect(foundByEvent?.assignedTo.pubkey).toBe(recipientPubkey);
      }
    });

    it("should handle partial completion of multi-recipient delegation", async () => {
      const delegationEventId = "multi_delegation_event_partial";
      const recipients = [
        "recipient1_pubkey_aaa",
        "recipient2_pubkey_bbb",
        "recipient3_pubkey_ccc"
      ];
      const rootConversationId = "root_conv_303";
      const request = "Analyze security implications";

      // Register multi-recipient delegation
      const batchId = await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: recipients.map(recipientPubkey => ({
          pubkey: recipientPubkey,
          request: request,
        })),
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: request,
      });

      // Complete first recipient
      const result1 = await registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipients[0],
        completionEventId: "completion_1",
        response: "Security analysis from perspective 1",
      });

      expect(result1.batchComplete).toBe(false);
      expect(result1.remainingDelegations).toBe(2);

      // Complete second recipient
      const result2 = await registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipients[1],
        completionEventId: "completion_2",
        response: "Security analysis from perspective 2",
      });

      expect(result2.batchComplete).toBe(false);
      expect(result2.remainingDelegations).toBe(1);

      // Complete third recipient - batch should be complete
      const result3 = await registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipients[2],
        completionEventId: "completion_3",
        response: "Security analysis from perspective 3",
      });

      expect(result3.batchComplete).toBe(true);
      expect(result3.remainingDelegations).toBe(0);

      // Verify all delegations are completed
      for (const recipientPubkey of recipients) {
        const delegation = registry.getDelegationByConversationKey(
          rootConversationId,
          mockAgent.pubkey,
          recipientPubkey
        );
        expect(delegation?.status).toBe("completed");
      }

      // Get batch completions
      const completions = registry.getBatchCompletions(batchId);
      expect(completions).toHaveLength(3);
      expect(completions.map(c => c.assignedTo)).toEqual(recipients);
    });

    it("should correctly identify delegations when multiple share same event ID", async () => {
      const delegationEventId = "shared_event_id_999";
      const recipients = ["pubkey_x", "pubkey_y", "pubkey_z"];
      const rootConversationId = "root_conv_404";

      await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: recipients.map(recipientPubkey => ({
          pubkey: recipientPubkey,
          request: "Test request",
        })),
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: "Test request",
      });

      // Finding by event ID and specific responder should return correct record
      const delegationY = registry.findDelegationByEventAndResponder(
        delegationEventId,
        "pubkey_y"
      );

      expect(delegationY).toBeDefined();
      expect(delegationY?.assignedTo.pubkey).toBe("pubkey_y");

      // Verify the deprecated getDelegationContextByTaskId warns about ambiguity
      warnSpy.mockClear();
      const ambiguousResult = registry.getDelegationContextByTaskId(delegationEventId);
      
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("getDelegationContextByTaskId is deprecated"),
        expect.anything()
      );
      
      // It will return one of them (first match), but we can't rely on which
      expect(ambiguousResult).toBeDefined();
      expect(recipients).toContain(ambiguousResult?.assignedTo.pubkey);
    });
  });

  describe("Synchronous Waiting", () => {
    it("should support synchronous waiting for batch completion", async () => {
      const delegationEventId = "sync_wait_event";
      const recipients = ["sync_recipient_1", "sync_recipient_2"];
      const rootConversationId = "root_conv_505";

      const batchId = await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: recipients.map(recipientPubkey => ({
          pubkey: recipientPubkey,
          request: "Synchronous test",
        })),
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: "Synchronous test",
      });

      // Start waiting (in a real scenario, this would block)
      const waitPromise = registry.waitForBatchCompletion(batchId);

      // Simulate async completion of delegations
      setTimeout(async () => {
        for (const recipient of recipients) {
          await registry.recordTaskCompletion({
            conversationId: rootConversationId,
            fromPubkey: mockAgent.pubkey,
            toPubkey: recipient,
            completionEventId: `completion_${recipient}`,
            response: `Response from ${recipient}`,
          });
        }
      }, 10);

      // Wait should resolve once all are complete
      const completions = await waitPromise;
      
      expect(completions).toHaveLength(2);
      expect(completions[0].response).toContain("Response from");
      expect(completions[1].response).toContain("Response from");
    });
  });


  describe("Edge Cases", () => {
    it("should handle empty batch gracefully", async () => {
      const batchId = await registry.registerDelegation({
        delegationEventId: "empty_batch_event",
        recipients: [],
        delegatingAgent: mockAgent,
        rootConversationId: "root_conv_empty",
        originalRequest: "Empty batch",
      });

      expect(batchId).toBeDefined();
      const completions = registry.getBatchCompletions(batchId);
      expect(completions).toEqual([]);
    });

    it("should prevent duplicate completions", async () => {
      const delegationEventId = "duplicate_test";
      const recipientPubkey = "duplicate_recipient";
      const rootConversationId = "root_conv_dup";

      await registry.registerDelegation({
        delegationEventId: delegationEventId,
        recipients: [{
          pubkey: recipientPubkey,
          request: "Test",
        }],
        delegatingAgent: mockAgent,
        rootConversationId: rootConversationId,
        originalRequest: "Test",
      });

      // First completion
      await registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipientPubkey,
        completionEventId: "comp_1",
        response: "First response",
      });

      // Attempt second completion (should fail or be ignored)
      await expect(registry.recordTaskCompletion({
        conversationId: rootConversationId,
        fromPubkey: mockAgent.pubkey,
        toPubkey: recipientPubkey,
        completionEventId: "comp_2",
        response: "Second response",
      })).rejects.toThrow();
    });
  });
});
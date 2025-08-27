import { beforeEach, describe, expect, it } from "@jest/globals";
import { TestHarness } from "./test-harness";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * E2E Test: Unified Delegation Approach (No Synthetic IDs)
 * 
 * This test validates that:
 * 1. Single-recipient delegations work with the unified approach
 * 2. Multi-recipient delegations work without synthetic IDs
 * 3. Conversation key lookups correctly identify delegations
 * 4. The system handles completion events properly
 */

describe("E2E: Unified Delegation System", () => {
  let harness: TestHarness;
  let registry: DelegationRegistry;

  // Track log output for verification
  const logs: Array<{ level: string; message: string; meta?: any }> = [];
  const originalInfo = logger.info.bind(logger);
  const originalDebug = logger.debug.bind(logger);
  const originalWarn = logger.warn.bind(logger);

  beforeAll(async () => {
    // Capture logs
    logger.info = (message: string, meta?: any) => {
      logs.push({ level: "info", message, meta });
      originalInfo(message, meta);
    };
    logger.debug = (message: string, meta?: any) => {
      logs.push({ level: "debug", message, meta });
      originalDebug(message, meta);
    };
    logger.warn = (message: string, meta?: any) => {
      logs.push({ level: "warn", message, meta });
      originalWarn(message, meta);
    };

    await DelegationRegistry.initialize();
    registry = DelegationRegistry.getInstance();
  });

  beforeEach(async () => {
    logs.length = 0;
    await registry.clear();
  });

  afterAll(() => {
    // Restore original logger
    logger.info = originalInfo;
    logger.debug = originalDebug;
    logger.warn = originalWarn;
  });

  describe("Single-Recipient Delegation Flow", () => {
    it("should handle single delegation through unified system", async () => {
      // Create test harness with mock provider scenario
      harness = new TestHarness({
        mockScenario: "delegation-single",
      });

      await harness.setup();

      const agent = harness.primaryAgent;
      const targetAgent = harness.agents[1]; // Second agent as delegation target

      // Configure mock to trigger delegation
      harness.mockProvider.setNextResponse({
        content: `I'll delegate this to another agent for analysis.`,
        toolCalls: [
          {
            name: "delegate_external",
            input: {
              content: "Please analyze this code pattern",
              recipient: targetAgent.pubkey,
            },
          },
        ],
      });

      // Send initial message
      const response = await harness.sendMessage(
        "Can you analyze this code?",
        agent.pubkey
      );

      // Verify delegation was registered
      const delegationLogs = logs.filter(
        l => l.message.includes("Registering single-recipient delegation")
      );
      expect(delegationLogs.length).toBeGreaterThan(0);

      // Verify unified approach was used
      const unifiedLogs = logs.filter(
        l => l.message.includes("unified batch approach")
      );
      expect(unifiedLogs.length).toBeGreaterThan(0);

      // Verify delegation can be found by conversation key
      const rootConvId = harness.conversationId;
      const delegation = registry.getDelegationByConversationKey(
        rootConvId,
        agent.pubkey,
        targetAgent.pubkey
      );

      expect(delegation).toBeDefined();
      expect(delegation?.status).toBe("pending");
      expect(delegation?.delegationEventId).toBeDefined();
      
      // Verify no synthetic IDs in logs
      const syntheticIdLogs = logs.filter(
        l => l.meta && JSON.stringify(l.meta).includes(":")
      );
      syntheticIdLogs.forEach(log => {
        // Event IDs shouldn't contain colons (synthetic ID format)
        if (log.meta.delegationEventId) {
          expect(log.meta.delegationEventId).not.toContain(":");
        }
      });

      await harness.cleanup();
    }, 30000);
  });

  describe("Multi-Recipient Delegation Flow", () => {
    it("should handle multi-recipient delegation without synthetic IDs", async () => {
      harness = new TestHarness({
        mockScenario: "delegation-multi",
        agentCount: 4, // Primary + 3 targets
      });

      await harness.setup();

      const agent = harness.primaryAgent;
      const targetAgents = harness.agents.slice(1, 4); // 3 target agents

      // Configure mock to trigger multi-recipient delegation
      harness.mockProvider.setNextResponse({
        content: `I'll ask multiple agents for their perspectives.`,
        toolCalls: [
          {
            name: "delegate",
            input: {
              request: "Review this implementation",
              recipients: targetAgents.map(a => a.pubkey),
            },
          },
        ],
      });

      // Send initial message
      await harness.sendMessage(
        "Can you get multiple reviews of this code?",
        agent.pubkey
      );

      // Verify multi-recipient batch was created
      const batchLogs = logs.filter(
        l => l.message.includes("Registering multi-recipient delegation batch")
      );
      expect(batchLogs.length).toBeGreaterThan(0);
      
      if (batchLogs[0]?.meta) {
        expect(batchLogs[0].meta.recipientCount).toBe(3);
      }

      // Verify each recipient has a delegation record
      const rootConvId = harness.conversationId;
      for (const targetAgent of targetAgents) {
        const delegation = registry.getDelegationByConversationKey(
          rootConvId,
          agent.pubkey,
          targetAgent.pubkey
        );

        expect(delegation).toBeDefined();
        expect(delegation?.status).toBe("pending");
        
        // All should share the same delegation event ID
        const firstDelegation = registry.getDelegationByConversationKey(
          rootConvId,
          agent.pubkey,
          targetAgents[0].pubkey
        );
        expect(delegation?.delegationEventId).toBe(firstDelegation?.delegationEventId);
      }

      // Verify we can find each by event ID and responder
      const sharedEventId = registry.getDelegationByConversationKey(
        rootConvId,
        agent.pubkey,
        targetAgents[0].pubkey
      )?.delegationEventId;

      for (const targetAgent of targetAgents) {
        const found = registry.findDelegationByEventAndResponder(
          sharedEventId!,
          targetAgent.pubkey
        );
        expect(found).toBeDefined();
        expect(found?.assignedTo.pubkey).toBe(targetAgent.pubkey);
      }

      await harness.cleanup();
    }, 30000);

    it("should handle partial completions correctly", async () => {
      harness = new TestHarness({
        mockScenario: "delegation-partial-completion",
        agentCount: 3,
      });

      await harness.setup();

      const agent = harness.primaryAgent;
      const target1 = harness.agents[1];
      const target2 = harness.agents[2];

      // Setup multi-recipient delegation
      harness.mockProvider.setNextResponse({
        content: `Delegating to two agents.`,
        toolCalls: [
          {
            name: "delegate",
            input: {
              request: "Analyze this",
              recipients: [target1.pubkey, target2.pubkey],
            },
          },
        ],
      });

      await harness.sendMessage("Please analyze", agent.pubkey);

      const rootConvId = harness.conversationId;

      // Simulate first agent completing
      const result1 = await registry.recordTaskCompletion({
        conversationId: rootConvId,
        fromPubkey: agent.pubkey,
        toPubkey: target1.pubkey,
        completionEventId: "mock_completion_1",
        response: "Analysis from agent 1",
      });

      expect(result1.batchComplete).toBe(false);
      expect(result1.remainingDelegations).toBe(1);

      // Verify first delegation is completed
      const delegation1 = registry.getDelegationByConversationKey(
        rootConvId,
        agent.pubkey,
        target1.pubkey
      );
      expect(delegation1?.status).toBe("completed");

      // Verify second is still pending
      const delegation2 = registry.getDelegationByConversationKey(
        rootConvId,
        agent.pubkey,
        target2.pubkey
      );
      expect(delegation2?.status).toBe("pending");

      // Complete second delegation
      const result2 = await registry.recordTaskCompletion({
        conversationId: rootConvId,
        fromPubkey: agent.pubkey,
        toPubkey: target2.pubkey,
        completionEventId: "mock_completion_2",
        response: "Analysis from agent 2",
      });

      expect(result2.batchComplete).toBe(true);
      expect(result2.remainingDelegations).toBe(0);

      await harness.cleanup();
    }, 30000);
  });

  describe("Completion Event Processing", () => {
    it("should process completion using conversation key lookup", async () => {
      harness = new TestHarness({
        mockScenario: "completion-processing",
      });

      await harness.setup();

      const agent = harness.primaryAgent;
      const targetAgent = harness.agents[1];
      const rootConvId = harness.conversationId;

      // Setup delegation
      harness.mockProvider.setNextResponse({
        content: `Delegating task.`,
        toolCalls: [
          {
            name: "delegate_external",
            input: {
              content: "Task to complete",
              recipient: targetAgent.pubkey,
            },
          },
        ],
      });

      await harness.sendMessage("Do something", agent.pubkey);

      // Get the delegation
      const delegation = registry.getDelegationByConversationKey(
        rootConvId,
        agent.pubkey,
        targetAgent.pubkey
      );
      expect(delegation).toBeDefined();
      const delegationEventId = delegation!.delegationEventId;

      // Simulate completion event from target agent
      const mockCompletionEvent: Partial<NDKEvent> = {
        id: "completion_event_id",
        pubkey: targetAgent.pubkey,
        content: "Task completed successfully",
        tags: [
          ["e", delegationEventId], // References the delegation event
          ["p", agent.pubkey], // Tags the delegating agent
          ["status", "completed"],
        ],
        tagValue: (tag: string) => {
          if (tag === "status") return "completed";
          return undefined;
        },
        getMatchingTags: (tag: string) => {
          if (tag === "e") return [["e", delegationEventId]];
          if (tag === "p") return [["p", agent.pubkey]];
          return [];
        },
      };

      // Process through DelegationCompletionHandler
      const { DelegationCompletionHandler } = await import(
        "@/event-handler/DelegationCompletionHandler"
      );

      // Mock conversation for the handler
      const mockConversation = {
        id: rootConvId,
        history: [],
      };

      const result = await DelegationCompletionHandler.handleDelegationCompletion(
        mockCompletionEvent as NDKEvent,
        mockConversation as any,
        harness.conversationCoordinator
      );

      // Verify completion was found via new lookup methods
      const completionLogs = logs.filter(
        l => l.message.includes("Found matching delegation")
      );
      expect(completionLogs.length).toBeGreaterThan(0);

      // Verify using conversation key or event+responder lookup
      const lookupLogs = logs.filter(
        l => l.message.includes("conversation key") || 
            l.message.includes("event ID and responder")
      );
      expect(lookupLogs.length).toBeGreaterThan(0);

      await harness.cleanup();
    }, 30000);
  });

  describe("Logging and Debugging", () => {
    it("should provide comprehensive logging throughout delegation flow", async () => {
      harness = new TestHarness({
        mockScenario: "logging-test",
      });

      await harness.setup();

      const agent = harness.primaryAgent;
      const targetAgent = harness.agents[1];

      // Trigger delegation
      harness.mockProvider.setNextResponse({
        content: `Delegating for detailed logging.`,
        toolCalls: [
          {
            name: "delegate_external",
            input: {
              content: "Test logging",
              recipient: targetAgent.pubkey,
            },
          },
        ],
      });

      await harness.sendMessage("Test", agent.pubkey);

      // Verify comprehensive logging
      const expectedLogPatterns = [
        "Registering",
        "Creating delegation record",
        "unified",
        "conversation key",
        "Found",
      ];

      for (const pattern of expectedLogPatterns) {
        const matchingLogs = logs.filter(l => 
          l.message.toLowerCase().includes(pattern.toLowerCase())
        );
        expect(matchingLogs.length).toBeGreaterThan(0);
      }

      // Verify no warnings about deprecated methods in normal flow
      const deprecationWarnings = logs.filter(
        l => l.level === "warn" && l.message.includes("deprecated")
      );
      expect(deprecationWarnings.length).toBe(0);

      await harness.cleanup();
    }, 30000);
  });
});
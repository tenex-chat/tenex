/**
 * Integration tests for RALRegistry heuristic violation methods
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";

describe("RALRegistry Heuristic Integration", () => {
  let registry: RALRegistry;
  const agentPubkey = "test-agent-pubkey";
  const conversationId = "test-conversation-id";
  const projectId = "test-project-id";

  beforeEach(() => {
    registry = RALRegistry.getInstance();
    registry.clearAll();
  });

  describe("Violation Management", () => {
    it("should add and consume heuristic violations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const violations = [
        {
          id: "v1",
          heuristicId: "h1",
          title: "Test Violation",
          message: "Test message",
          severity: "warning" as const,
          timestamp: Date.now(),
        },
      ];

      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, violations);

      const consumed = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );

      expect(consumed).toHaveLength(1);
      expect(consumed[0].id).toBe("v1");
    });

    it("should atomic read+clear violations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const violations = [
        {
          id: "v1",
          heuristicId: "h1",
          title: "Test",
          message: "Test",
          severity: "warning" as const,
          timestamp: Date.now(),
        },
      ];

      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, violations);

      // First consume
      const consumed1 = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );
      expect(consumed1).toHaveLength(1);

      // Second consume should be empty (already cleared)
      const consumed2 = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );
      expect(consumed2).toHaveLength(0);
    });

    it("should deduplicate violations by ID after consumption", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const violation = {
        id: "v1",
        heuristicId: "h1",
        title: "Test",
        message: "Test",
        severity: "warning" as const,
        timestamp: Date.now(),
      };

      // Add and consume violation
      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, [violation]);
      registry.getAndConsumeHeuristicViolations(agentPubkey, conversationId, ralNumber);

      // Try to add same violation again (should be filtered as already shown)
      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, [violation]);

      const consumed = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );

      // Should be empty (deduplicated because v1 was already shown)
      expect(consumed).toHaveLength(0);
    });

    it("should track shown violations across multiple consumptions", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const violation1 = {
        id: "v1",
        heuristicId: "h1",
        title: "First",
        message: "First",
        severity: "warning" as const,
        timestamp: Date.now(),
      };

      const violation2 = {
        id: "v2",
        heuristicId: "h2",
        title: "Second",
        message: "Second",
        severity: "warning" as const,
        timestamp: Date.now(),
      };

      // Add and consume first violation
      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, [violation1]);
      registry.getAndConsumeHeuristicViolations(agentPubkey, conversationId, ralNumber);

      // Add both violations (v1 should be filtered as already shown)
      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, [
        violation1,
        violation2,
      ]);

      const consumed = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );

      // Should only have v2 (v1 was already shown)
      expect(consumed).toHaveLength(1);
      expect(consumed[0].id).toBe("v2");
    });

    it("should check for pending violations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      expect(
        registry.hasPendingHeuristicViolations(agentPubkey, conversationId, ralNumber)
      ).toBe(false);

      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, [
        {
          id: "v1",
          heuristicId: "h1",
          title: "Test",
          message: "Test",
          severity: "warning",
          timestamp: Date.now(),
        },
      ]);

      expect(
        registry.hasPendingHeuristicViolations(agentPubkey, conversationId, ralNumber)
      ).toBe(true);

      registry.getAndConsumeHeuristicViolations(agentPubkey, conversationId, ralNumber);

      expect(
        registry.hasPendingHeuristicViolations(agentPubkey, conversationId, ralNumber)
      ).toBe(false);
    });

    it("should handle multiple violations", () => {
      const ralNumber = registry.create(agentPubkey, conversationId, projectId);

      const violations = Array.from({ length: 10 }, (_, i) => ({
        id: `v${i}`,
        heuristicId: `h${i}`,
        title: `Violation ${i}`,
        message: `Message ${i}`,
        severity: "warning" as const,
        timestamp: Date.now(),
      }));

      registry.addHeuristicViolations(agentPubkey, conversationId, ralNumber, violations);

      const consumed = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ralNumber
      );

      expect(consumed).toHaveLength(10);
    });

    it("should handle missing RAL gracefully", () => {
      // Try to add violations to non-existent RAL
      registry.addHeuristicViolations(agentPubkey, conversationId, 999, [
        {
          id: "v1",
          heuristicId: "h1",
          title: "Test",
          message: "Test",
          severity: "warning",
          timestamp: Date.now(),
        },
      ]);

      // Should return empty array
      const consumed = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        999
      );
      expect(consumed).toHaveLength(0);
    });
  });

  describe("Isolation", () => {
    it("should isolate violations per RAL", () => {
      const ral1 = registry.create(agentPubkey, conversationId, projectId);
      const ral2 = registry.create(agentPubkey, conversationId, projectId);

      registry.addHeuristicViolations(agentPubkey, conversationId, ral1, [
        {
          id: "v1",
          heuristicId: "h1",
          title: "RAL 1",
          message: "RAL 1",
          severity: "warning",
          timestamp: Date.now(),
        },
      ]);

      registry.addHeuristicViolations(agentPubkey, conversationId, ral2, [
        {
          id: "v2",
          heuristicId: "h2",
          title: "RAL 2",
          message: "RAL 2",
          severity: "warning",
          timestamp: Date.now(),
        },
      ]);

      const consumed1 = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ral1
      );
      const consumed2 = registry.getAndConsumeHeuristicViolations(
        agentPubkey,
        conversationId,
        ral2
      );

      expect(consumed1[0].id).toBe("v1");
      expect(consumed2[0].id).toBe("v2");
    });
  });
});

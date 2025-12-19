import { describe, expect, it } from "bun:test";
import { ConcurrentRALCoordinator } from "../ConcurrentRALCoordinator";
import type { RALSummary } from "@/services/ral";

describe("ConcurrentRALCoordinator", () => {
  const coordinator = new ConcurrentRALCoordinator();

  describe("getToolAvailability", () => {
    it("should allow abort for RAL with no pending delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const availability = coordinator.getToolAvailability(rals);

      expect(availability).toHaveLength(1);
      expect(availability[0].ralNumber).toBe(1);
      expect(availability[0].canAbort).toBe(true);
      expect(availability[0].abortReason).toBeUndefined();
    });

    it("should disallow abort for RAL with pending delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: false,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [{
          eventId: "del-123",
          recipientPubkey: "pubkey",
          recipientSlug: "helper",
          prompt: "do something",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const availability = coordinator.getToolAvailability(rals);

      expect(availability).toHaveLength(1);
      expect(availability[0].ralNumber).toBe(1);
      expect(availability[0].canAbort).toBe(false);
      expect(availability[0].abortReason).toContain("pending delegation");
    });

    it("should handle mixed RALs with different delegation states", () => {
      const rals: RALSummary[] = [
        {
          ralNumber: 1,
          ralId: "ral-1",
          isStreaming: true,
          currentTool: undefined,
          uniqueMessages: [],
          pendingDelegations: [],
          hasPendingDelegations: false,
          createdAt: Date.now(),
        },
        {
          ralNumber: 2,
          ralId: "ral-2",
          isStreaming: false,
          currentTool: undefined,
          uniqueMessages: [],
          pendingDelegations: [{
            eventId: "del-456",
            recipientPubkey: "pubkey",
            recipientSlug: "worker",
            prompt: "task",
          }],
          hasPendingDelegations: true,
          createdAt: Date.now(),
        },
      ];

      const availability = coordinator.getToolAvailability(rals);

      expect(availability).toHaveLength(2);
      expect(availability[0].canAbort).toBe(true);
      expect(availability[1].canAbort).toBe(false);
    });
  });

  describe("shouldReleasePausedRALs", () => {
    it("should not release when no steps completed", () => {
      const result = coordinator.shouldReleasePausedRALs([]);
      expect(result).toBe(false);
    });

    it("should not release when step has only reasoning (no tool calls)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [],
        text: "",
        reasoningText: "I need to think about this...",
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should not release when step has only text (no tool calls)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [],
        text: "Let me analyze the situation...",
        reasoningText: undefined,
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should release when step has tool calls", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "ral_inject" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when any step has tool calls", () => {
      const steps = [
        {
          stepNumber: 0,
          toolCalls: [],
          text: "Thinking...",
          reasoningText: "Let me consider...",
        },
        {
          stepNumber: 1,
          toolCalls: [{ toolName: "write_file" }],
          text: "",
          reasoningText: undefined,
        },
      ];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release on first step with tool calls (ral_inject)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "ral_inject" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release on first step with tool calls (ral_abort)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "ral_abort" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when agent proceeds with own work (any tool)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "write_file" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = coordinator.shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });
  });

  describe("buildContext", () => {
    it("should return empty string when no other RALs", () => {
      const result = coordinator.buildContext([]);
      expect(result).toBe("");
    });

    it("should include RAL descriptions", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: "write_file",
        uniqueMessages: [
          { role: "user", content: "Write poems" },
          { role: "assistant", content: "I will write poems" },
        ],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now() - 60000, // 1 minute ago
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("RAL #1");
      expect(result).toContain("actively streaming");
      expect(result).toContain("write_file");
      expect(result).toContain("Write poems");
    });

    it("should mention ral_abort for RALs without delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("ral_abort");
      expect(result).toContain("available for: #1");
    });

    it("should NOT mention ral_abort availability for RALs with delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: false,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [{
          eventId: "del-123",
          recipientPubkey: "pubkey",
          recipientSlug: "helper",
          prompt: "task",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("cannot be aborted directly");
      expect(result).toContain("pending delegation");
    });

    it("should always mention ral_inject", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("ral_inject");
    });

    it("should include urgency language about paused RALs", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("PAUSED");
      expect(result).toContain("MUST coordinate");
      expect(result).toContain("first tool call");
    });

    it("should include conflict detection guidance", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("CONFLICTS");
      expect(result).toContain("CHANGES");
      expect(result).toContain("ral_inject FIRST");
    });

    it("should show delegation info for RALs with pending delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: false,
        currentTool: undefined,
        uniqueMessages: [],
        pendingDelegations: [{
          eventId: "del-123456789",
          recipientPubkey: "pubkey",
          recipientSlug: "researcher",
          prompt: "Research the topic",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const result = coordinator.buildContext(rals);

      expect(result).toContain("Pending delegations");
      expect(result).toContain("researcher");
      expect(result).toContain("Research the topic");
    });
  });
});

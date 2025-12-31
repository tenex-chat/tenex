import { describe, expect, it } from "bun:test";
import { getToolAvailability, shouldReleasePausedRALs, buildContext } from "../ConcurrentRALCoordinator";
import type { RALSummary } from "@/services/ral";

describe("ConcurrentRALCoordinator", () => {
  describe("getToolAvailability", () => {
    it("should allow abort for RAL with no pending delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const availability = getToolAvailability(rals);

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
        pendingDelegations: [{
          delegationConversationId: "del-123",
          recipientPubkey: "pubkey",
          recipientSlug: "helper",
          prompt: "do something",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const availability = getToolAvailability(rals);

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
          pendingDelegations: [],
          hasPendingDelegations: false,
          createdAt: Date.now(),
        },
        {
          ralNumber: 2,
          ralId: "ral-2",
          isStreaming: false,
          currentTool: undefined,
          pendingDelegations: [{
            delegationConversationId: "del-456",
            recipientPubkey: "pubkey",
            recipientSlug: "worker",
            prompt: "task",
          }],
          hasPendingDelegations: true,
          createdAt: Date.now(),
        },
      ];

      const availability = getToolAvailability(rals);

      expect(availability).toHaveLength(2);
      expect(availability[0].canAbort).toBe(true);
      expect(availability[1].canAbort).toBe(false);
    });
  });

  describe("shouldReleasePausedRALs", () => {
    it("should not release when no steps completed", () => {
      const result = shouldReleasePausedRALs([]);
      expect(result).toBe(false);
    });

    it("should not release when step has only reasoning (no tool calls)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [],
        text: "",
        reasoningText: "I need to think about this...",
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should not release when step has only text (no tool calls)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [],
        text: "Let me analyze the situation...",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should NOT release when only read-only tools are called (conversation_get)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "conversation_get" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should NOT release when only read-only tools are called (read_path)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "read_path" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should NOT release when multiple read-only tools are called", () => {
      const steps = [
        {
          stepNumber: 0,
          toolCalls: [{ toolName: "conversation_get" }],
          text: "",
          reasoningText: undefined,
        },
        {
          stepNumber: 1,
          toolCalls: [{ toolName: "read_path" }, { toolName: "codebase_search" }],
          text: "",
          reasoningText: undefined,
        },
      ];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(false);
    });

    it("should release when ral_inject is called", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "ral_inject" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when ral_abort is called", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "ral_abort" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when write_file is called (action tool)", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [{ toolName: "write_file" }],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when action tool is called after read-only tools", () => {
      const steps = [
        {
          stepNumber: 0,
          toolCalls: [{ toolName: "conversation_get" }],
          text: "",
          reasoningText: undefined,
        },
        {
          stepNumber: 1,
          toolCalls: [{ toolName: "read_path" }],
          text: "",
          reasoningText: undefined,
        },
        {
          stepNumber: 2,
          toolCalls: [{ toolName: "ral_inject" }],
          text: "",
          reasoningText: undefined,
        },
      ];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });

    it("should release when action tool is mixed with read-only in same step", () => {
      const steps = [{
        stepNumber: 0,
        toolCalls: [
          { toolName: "read_path" },
          { toolName: "write_file" },
        ],
        text: "",
        reasoningText: undefined,
      }];

      const result = shouldReleasePausedRALs(steps);
      expect(result).toBe(true);
    });
  });

  describe("buildContext", () => {
    const currentRALNumber = 2; // The RAL receiving the context
    const emptyActionHistory = new Map<number, string>();

    it("should return empty string when no other RALs", () => {
      const result = buildContext([], currentRALNumber, emptyActionHistory);
      expect(result).toBe("");
    });

    it("should explicitly state current RAL identity", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("YOU ARE RAL #2");
      expect(result).toContain("NEW execution");
      expect(result).toContain("You are NOT");
    });

    it("should include RAL descriptions", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: "write_file",
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now() - 60000, // 1 minute ago
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("RAL #1");
      expect(result).toContain("write_file");
      expect(result).toContain("actively streaming");
    });

    it("should mention ral_abort for RALs without delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("ral_abort");
      expect(result).toContain("available for: #1");
    });

    it("should NOT mention ral_abort availability for RALs with delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: false,
        currentTool: undefined,
        pendingDelegations: [{
          delegationConversationId: "del-123",
          recipientPubkey: "pubkey",
          recipientSlug: "helper",
          prompt: "task",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("cannot be aborted directly");
      expect(result).toContain("pending delegation");
    });

    it("should always mention ral_inject", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("ral_inject");
    });

    it("should include urgency language about paused RALs", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("PAUSED");
      expect(result).toContain("must coordinate");
      expect(result).toContain("first tool call");
    });

    it("should include conflict detection guidance", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: true,
        currentTool: undefined,
        pendingDelegations: [],
        hasPendingDelegations: false,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("CONFLICTS");
      expect(result).toContain("CHANGES");
      expect(result).toContain("Use ral_inject");
    });

    it("should show delegation info for RALs with pending delegations", () => {
      const rals: RALSummary[] = [{
        ralNumber: 1,
        ralId: "ral-1",
        isStreaming: false,
        currentTool: undefined,
        pendingDelegations: [{
          delegationConversationId: "del-123456789",
          recipientSlug: "researcher",
        }],
        hasPendingDelegations: true,
        createdAt: Date.now(),
      }];

      const result = buildContext(rals, currentRALNumber, emptyActionHistory);

      expect(result).toContain("Pending delegations");
      expect(result).toContain("researcher");
      expect(result).toContain("del-1234"); // truncated event ID
    });
  });
});

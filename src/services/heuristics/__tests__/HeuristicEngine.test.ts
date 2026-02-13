/**
 * Unit tests for HeuristicEngine
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { HeuristicEngine, resetHeuristicEngine } from "../HeuristicEngine";
import type { Heuristic, HeuristicContext, HeuristicViolation } from "../types";

describe("HeuristicEngine", () => {
  beforeEach(() => {
    resetHeuristicEngine();
  });

  describe("Registration", () => {
    it("should register heuristics", () => {
      const engine = new HeuristicEngine();
      const heuristic: Heuristic = {
        id: "test-heuristic",
        name: "Test Heuristic",
        description: "Test",
        evaluate: () => null,
      };

      engine.register(heuristic);

      const all = engine.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("test-heuristic");
    });

    it("should replace duplicate heuristic IDs", () => {
      const engine = new HeuristicEngine();
      const heuristic1: Heuristic = {
        id: "test",
        name: "First",
        description: "First",
        evaluate: () => null,
      };
      const heuristic2: Heuristic = {
        id: "test",
        name: "Second",
        description: "Second",
        evaluate: () => null,
      };

      engine.register(heuristic1);
      engine.register(heuristic2);

      const all = engine.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Second");
    });

    it("should unregister heuristics", () => {
      const engine = new HeuristicEngine();
      const heuristic: Heuristic = {
        id: "test",
        name: "Test",
        description: "Test",
        evaluate: () => null,
      };

      engine.register(heuristic);
      expect(engine.getAll()).toHaveLength(1);

      engine.unregister("test");
      expect(engine.getAll()).toHaveLength(0);
    });
  });

  describe("Evaluation", () => {
    const createMockContext = (): HeuristicContext => ({
      agentPubkey: "test-agent",
      conversationId: "test-conv",
      ralNumber: 1,
      tool: {
        name: "TestTool",
        callId: "test-call-1",
        args: {},
        result: {},
      },
      state: {
        hasTodoWrite: false,
        hasDelegation: false,
        pendingDelegationCount: 0,
        currentBranch: "main",
        isWorktreeBranch: false,
        hasVerification: false,
        hasGitAgentCommit: false,
        messageCount: 10,
      },
      recentTools: [],
    });

    it("should evaluate heuristics and return violations", () => {
      const engine = new HeuristicEngine({ telemetry: false });
      const violation: HeuristicViolation = {
        id: "test-violation-1",
        heuristicId: "test",
        title: "Test Violation",
        message: "This is a test",
        severity: "warning",
        timestamp: Date.now(),
      };

      const heuristic: Heuristic = {
        id: "test",
        name: "Test",
        description: "Test",
        evaluate: () => violation,
      };

      engine.register(heuristic);

      const context = createMockContext();
      const violations = engine.evaluate(context);

      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe("test-violation-1");
    });

    it("should return empty array when no violations", () => {
      const engine = new HeuristicEngine({ telemetry: false });
      const heuristic: Heuristic = {
        id: "test",
        name: "Test",
        description: "Test",
        evaluate: () => null,
      };

      engine.register(heuristic);

      const context = createMockContext();
      const violations = engine.evaluate(context);

      expect(violations).toHaveLength(0);
    });

    it("should handle heuristic errors with hard boundary", () => {
      const engine = new HeuristicEngine({ telemetry: false });
      const errorHeuristic: Heuristic = {
        id: "error",
        name: "Error",
        description: "Throws error",
        evaluate: () => {
          throw new Error("Test error");
        },
      };
      const goodHeuristic: Heuristic = {
        id: "good",
        name: "Good",
        description: "Works fine",
        evaluate: () => ({
          id: "good-violation",
          heuristicId: "good",
          title: "Good",
          message: "Good",
          severity: "warning",
          timestamp: Date.now(),
        }),
      };

      engine.register(errorHeuristic);
      engine.register(goodHeuristic);

      const context = createMockContext();
      const violations = engine.evaluate(context);

      // Should only return violation from good heuristic
      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe("good-violation");
    });

    it("should evaluate multiple heuristics", () => {
      const engine = new HeuristicEngine({ telemetry: false });

      for (let i = 0; i < 3; i++) {
        engine.register({
          id: `test-${i}`,
          name: `Test ${i}`,
          description: `Test ${i}`,
          evaluate: () => ({
            id: `violation-${i}`,
            heuristicId: `test-${i}`,
            title: `Violation ${i}`,
            message: `Message ${i}`,
            severity: "warning",
            timestamp: Date.now(),
          }),
        });
      }

      const context = createMockContext();
      const violations = engine.evaluate(context);

      expect(violations).toHaveLength(3);
    });

    it("should complete in <10ms for typical workload", () => {
      const engine = new HeuristicEngine({ telemetry: false });

      // Register 10 heuristics (typical load)
      for (let i = 0; i < 10; i++) {
        engine.register({
          id: `perf-${i}`,
          name: `Perf ${i}`,
          description: `Perf ${i}`,
          evaluate: () => null, // No violation
        });
      }

      const context = createMockContext();
      const start = performance.now();
      engine.evaluate(context);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(10);
    });
  });

  describe("Formatting", () => {
    it("should format violations for injection", () => {
      const engine = new HeuristicEngine({ telemetry: false });

      const violations: HeuristicViolation[] = [
        {
          id: "v1",
          heuristicId: "h1",
          title: "Warning 1",
          message: "Message 1",
          severity: "warning",
          timestamp: Date.now(),
        },
        {
          id: "v2",
          heuristicId: "h2",
          title: "Error 1",
          message: "Message 2",
          severity: "error",
          timestamp: Date.now() - 1000,
        },
      ];

      const formatted = engine.formatForInjection(violations);

      // Verify system-reminder wrapper and content
      expect(formatted).toContain("<system-reminder>");
      expect(formatted).toContain("</system-reminder>");
      expect(formatted).toContain("# Heuristic Reminders");
      expect(formatted).toContain("Warning 1");
      expect(formatted).toContain("Error 1");
    });

    it("should limit violations to maxWarningsPerStep", () => {
      const engine = new HeuristicEngine({
        maxWarningsPerStep: 2,
        telemetry: false,
      });

      const violations: HeuristicViolation[] = Array.from({ length: 5 }, (_, i) => ({
        id: `v${i}`,
        heuristicId: `h${i}`,
        title: `Violation ${i}`,
        message: `Message ${i}`,
        severity: "warning" as const,
        timestamp: Date.now() - i,
      }));

      const formatted = engine.formatForInjection(violations);

      // Should only contain first 2 violations
      expect(formatted).toContain("Violation 0");
      expect(formatted).toContain("Violation 1");
      expect(formatted).not.toContain("Violation 2");
    });

    it("should prioritize errors over warnings", () => {
      const engine = new HeuristicEngine({
        maxWarningsPerStep: 2,
        telemetry: false,
      });

      const violations: HeuristicViolation[] = [
        {
          id: "w1",
          heuristicId: "h1",
          title: "Warning 1",
          message: "Warning",
          severity: "warning",
          timestamp: Date.now(),
        },
        {
          id: "e1",
          heuristicId: "h2",
          title: "Error 1",
          message: "Error",
          severity: "error",
          timestamp: Date.now() - 1000,
        },
        {
          id: "w2",
          heuristicId: "h3",
          title: "Warning 2",
          message: "Warning",
          severity: "warning",
          timestamp: Date.now() - 500,
        },
      ];

      const formatted = engine.formatForInjection(violations);

      // Should contain error first
      expect(formatted.indexOf("Error 1")).toBeLessThan(formatted.indexOf("Warning"));
    });

    it("should return empty string for no violations", () => {
      const engine = new HeuristicEngine({ telemetry: false });
      const formatted = engine.formatForInjection([]);

      expect(formatted).toBe("");
    });
  });

  describe("Debug Info", () => {
    it("should provide debug information", () => {
      const engine = new HeuristicEngine({
        maxWarningsPerStep: 5,
        debug: true,
        telemetry: true,
      });

      engine.register({
        id: "test",
        name: "Test",
        description: "Test",
        evaluate: () => null,
      });

      const info = engine.getDebugInfo();

      expect(info.registeredCount).toBe(1);
      expect(info.heuristics).toHaveLength(1);
      expect(info.heuristics[0].id).toBe("test");
      expect(info.config.maxWarningsPerStep).toBe(5);
      expect(info.config.debug).toBe(true);
    });
  });
});

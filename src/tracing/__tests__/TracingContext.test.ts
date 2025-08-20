import { describe, expect, it, vi } from "vitest";
import {
  type TracingContext,
  createAgentExecutionContext,
  createPhaseExecutionContext,
  createToolExecutionContext,
  createTracingContext,
  formatTracingContext,
  generateExecutionId,
} from "../TracingContext";

describe("TracingContext", () => {
  describe("generateExecutionId", () => {
    it("should generate unique execution ID with default prefix", () => {
      const id = generateExecutionId();
      expect(id).toMatch(/^exec_[a-z0-9]+_[a-f0-9]{16}$/);
    });

    it("should use custom prefix", () => {
      const id = generateExecutionId("custom");
      expect(id).toMatch(/^custom_[a-z0-9]+_[a-f0-9]{16}$/);
    });

    it("should generate different IDs on successive calls", () => {
      const id1 = generateExecutionId();
      const id2 = generateExecutionId();

      expect(id1).not.toBe(id2);
    });

    it("should include timestamp in base36 format", () => {
      const originalDateNow = Date.now;
      Date.now = vi.fn(() => 1234567890);

      const id = generateExecutionId();
      const timestamp = (1234567890).toString(36);
      expect(id).toContain(timestamp);

      Date.now = originalDateNow;
    });
  });

  describe("createTracingContext", () => {
    it("should create context with conversation ID and execution ID", () => {
      const context = createTracingContext("conv-123");

      expect(context.conversationId).toBe("conv-123");
      expect(context.executionId).toMatch(/^exec_/);
      expect(context.currentAgent).toBeUndefined();
      expect(context.currentPhase).toBeUndefined();
      expect(context.currentTool).toBeUndefined();
    });

    it("should create unique execution IDs for different contexts", () => {
      const context1 = createTracingContext("conv-1");
      const context2 = createTracingContext("conv-2");

      expect(context1.executionId).not.toBe(context2.executionId);
    });
  });

  describe("createAgentExecutionContext", () => {
    it("should create context with agent name", () => {
      const parentContext = createTracingContext("conv-123");
      const agentContext = createAgentExecutionContext(parentContext, "TestAgent");

      expect(agentContext.conversationId).toBe("conv-123");
      expect(agentContext.executionId).toBe(parentContext.executionId);
      expect(agentContext.currentAgent).toBe("TestAgent");
    });

    it("should preserve all parent context fields", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentPhase: "CHAT",
        currentTool: "someTool",
      };

      const agentContext = createAgentExecutionContext(parentContext, "NewAgent");

      expect(agentContext).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        currentPhase: "CHAT",
        currentTool: "someTool",
        currentAgent: "NewAgent",
      });
    });

    it("should override existing agent name", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "OldAgent",
      };

      const agentContext = createAgentExecutionContext(parentContext, "NewAgent");

      expect(agentContext.currentAgent).toBe("NewAgent");
    });
  });

  describe("createToolExecutionContext", () => {
    it("should create context with tool name", () => {
      const parentContext = createTracingContext("conv-123");
      const toolContext = createToolExecutionContext(parentContext, "testTool");

      expect(toolContext.conversationId).toBe("conv-123");
      expect(toolContext.executionId).toBe(parentContext.executionId);
      expect(toolContext.currentTool).toBe("testTool");
    });

    it("should preserve all parent context fields", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "TestAgent",
        currentPhase: "EXECUTE",
      };

      const toolContext = createToolExecutionContext(parentContext, "newTool");

      expect(toolContext).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "TestAgent",
        currentPhase: "EXECUTE",
        currentTool: "newTool",
      });
    });

    it("should override existing tool name", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentTool: "oldTool",
      };

      const toolContext = createToolExecutionContext(parentContext, "newTool");

      expect(toolContext.currentTool).toBe("newTool");
    });
  });

  describe("createPhaseExecutionContext", () => {
    it("should create context with phase", () => {
      const parentContext = createTracingContext("conv-123");
      const phaseContext = createPhaseExecutionContext(parentContext, "PLAN");

      expect(phaseContext.conversationId).toBe("conv-123");
      expect(phaseContext.executionId).toBe(parentContext.executionId);
      expect(phaseContext.currentPhase).toBe("PLAN");
    });

    it("should preserve all parent context fields", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "TestAgent",
        currentTool: "testTool",
      };

      const phaseContext = createPhaseExecutionContext(parentContext, "VERIFY");

      expect(phaseContext).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "TestAgent",
        currentTool: "testTool",
        currentPhase: "VERIFY",
      });
    });

    it("should override existing phase", () => {
      const parentContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentPhase: "CHAT",
      };

      const phaseContext = createPhaseExecutionContext(parentContext, "EXECUTE");

      expect(phaseContext.currentPhase).toBe("EXECUTE");
    });
  });

  describe("formatTracingContext", () => {
    it("should format minimal context", () => {
      const context: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
      };

      const formatted = formatTracingContext(context);

      expect(formatted).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
      });
    });

    it("should include agent when present", () => {
      const context: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "TestAgent",
      };

      const formatted = formatTracingContext(context);

      expect(formatted).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        agent: "TestAgent",
      });
    });

    it("should include phase when present", () => {
      const context: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentPhase: "PLAN",
      };

      const formatted = formatTracingContext(context);

      expect(formatted).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        phase: "PLAN",
      });
    });

    it("should include tool when present", () => {
      const context: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentTool: "analyze",
      };

      const formatted = formatTracingContext(context);

      expect(formatted).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        tool: "analyze",
      });
    });

    it("should include all optional fields when present", () => {
      const context: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
        currentAgent: "Orchestrator",
        currentPhase: "EXECUTE",
        currentTool: "continue",
      };

      const formatted = formatTracingContext(context);

      expect(formatted).toEqual({
        conversationId: "conv-123",
        executionId: "exec-456",
        agent: "Orchestrator",
        phase: "EXECUTE",
        tool: "continue",
      });
    });

    it("should handle empty strings", () => {
      const context: TracingContext = {
        conversationId: "",
        executionId: "",
        currentAgent: "",
        currentPhase: "",
        currentTool: "",
      };

      const formatted = formatTracingContext(context);

      // Empty strings are falsy, so they won't be included in optional fields
      expect(formatted).toEqual({
        conversationId: "",
        executionId: "",
      });
    });
  });

  describe("context creation flows", () => {
    it("should support nested context creation", () => {
      // Start with base context
      const base = createTracingContext("conv-123");

      // Add agent context
      const withAgent = createAgentExecutionContext(base, "Orchestrator");

      // Add phase context
      const withPhase = createPhaseExecutionContext(withAgent, "PLAN");

      // Add tool context
      const complete = createToolExecutionContext(withPhase, "analyze");

      expect(complete).toEqual({
        conversationId: "conv-123",
        executionId: base.executionId,
        currentAgent: "Orchestrator",
        currentPhase: "PLAN",
        currentTool: "analyze",
      });
    });

    it("should allow context updates without mutation", () => {
      const original = createTracingContext("conv-123");
      const modified = createAgentExecutionContext(original, "TestAgent");

      // Original should be unchanged
      expect(original.currentAgent).toBeUndefined();
      expect(modified.currentAgent).toBe("TestAgent");

      // They should share the same base properties
      expect(original.conversationId).toBe(modified.conversationId);
      expect(original.executionId).toBe(modified.executionId);
    });
  });
});

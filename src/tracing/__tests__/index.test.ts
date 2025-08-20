import { describe, expect, it } from "bun:test";
import {
  createAgentExecutionContext,
  createPhaseExecutionContext,
  createToolExecutionContext,
  createTracingContext,
  createTracingLogger,
  formatTracingContext,
} from "../index";

describe("Tracing Index Exports", () => {
  it("should export all necessary functions", () => {
    expect(createTracingContext).toBeDefined();
    expect(createAgentExecutionContext).toBeDefined();
    expect(createToolExecutionContext).toBeDefined();
    expect(createPhaseExecutionContext).toBeDefined();
    expect(createTracingLogger).toBeDefined();
    expect(formatTracingContext).toBeDefined();
  });

  it("should create valid tracing context", () => {
    const context = createTracingContext("conv-123");
    expect(context.conversationId).toBe("conv-123");
    expect(context.executionId).toBeDefined();
    expect(context.executionId).toMatch(/^exec_/);
  });

  it("should create valid tracing logger", () => {
    const context = createTracingContext("conv-123");
    const logger = createTracingLogger(context, "test");
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.success).toBeDefined();
    expect(logger.warning).toBeDefined();
    expect(logger.error).toBeDefined();
  });
});

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { PHASES } from "@/conversations/phases";
import type { TracingLogger } from "@/tracing";
import { StreamStateManager } from "../StreamStateManager";
import { TerminationHandler } from "../TerminationHandler";
import type { ExecutionContext } from "../types";
import type { EventContext } from "@/nostr/AgentEventEncoder";

describe("TerminationHandler", () => {
  let stateManager: StreamStateManager;
  let terminationHandler: TerminationHandler;
  let mockTracingLogger: TracingLogger;
  let mockContext: ExecutionContext;
  let mockEventContext: EventContext;

  beforeEach(() => {
    stateManager = new StreamStateManager();
    terminationHandler = new TerminationHandler(stateManager);

    mockTracingLogger = {
      info: mock(() => {}),
      warning: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      success: mock(() => {}),
      startOperation: mock(() => {}),
      withContext: mock(() => {}),
      forModule: mock(() => {}),
    } as unknown as TracingLogger;

    mockContext = {
      agent: {
        name: "test-agent",
        signer: {} as any,
      },
      phase: "execution",
      conversationId: "conv-123",
      conversationCoordinator: {} as any,
      triggeringEvent: {} as any,
    } as ExecutionContext;

    mockEventContext = {
      triggeringEvent: {} as any,
      rootEvent: {} as any,
      conversationId: "conv-123",
    };
  });

  describe("checkTermination", () => {
    it("should not log for chat phase", async () => {
      mockContext.phase = PHASES.CHAT;
      stateManager.appendContent("Some content");

      await terminationHandler.checkTermination(mockContext, mockTracingLogger, mockEventContext);

      expect(mockTracingLogger.info).not.toHaveBeenCalled();
    });

    it("should not log for brainstorm phase", async () => {
      mockContext.phase = PHASES.BRAINSTORM;
      stateManager.appendContent("Some content");

      await terminationHandler.checkTermination(mockContext, mockTracingLogger, mockEventContext);

      expect(mockTracingLogger.info).not.toHaveBeenCalled();
    });

    it("should not log if agent terminated properly", async () => {
      stateManager.setTermination({ type: "complete", content: "Done" });
      stateManager.appendContent("Some content");

      await terminationHandler.checkTermination(mockContext, mockTracingLogger, mockEventContext);

      expect(mockTracingLogger.info).not.toHaveBeenCalled();
    });

    it("should log if agent did not terminate properly", async () => {
      const content = "Agent response content";
      stateManager.appendContent(content);

      await terminationHandler.checkTermination(mockContext, mockTracingLogger, mockEventContext);

      expect(mockTracingLogger.info).toHaveBeenCalled();
      expect(mockTracingLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Agent finished without calling terminal tool"),
        expect.any(Object)
      );
    });

    it("should work without eventContext", async () => {
      stateManager.appendContent("Some content");

      await terminationHandler.checkTermination(mockContext, mockTracingLogger);

      expect(mockTracingLogger.info).toHaveBeenCalled();
    });
  });
});
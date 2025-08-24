import * as fs from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Phase } from "@/conversations/phases";
import type { TracingContext } from "@/tracing";
import type { CompletionRequest, CompletionResponse, ResolvedLLMConfig } from "@/llm/types";
import type { ExecutionContext, ToolError, ToolExecutionResult } from "@/tools/types";
import type { LogModule } from "@/utils/logger";
import { logInfo } from "@/utils/logger";

/**
 * Unified event types for all system logging
 */
export type EventType =
  | "conversation_start"
  | "conversation_complete"
  | "phase_transition"
  | "llm_request"
  | "llm_response"
  | "tool_call"
  | "tool_result"
  | "execution_start"
  | "execution_complete"
  | "user_message"
  | "agent_message"
  | "routing";

/**
 * Base structure for all log events
 */
export interface UnifiedLogEvent {
  timestamp: string;
  timestampMs: number;
  sequenceNumber: number;
  eventType: EventType;
  
  // Context
  conversationId: string;
  agentName: string;
  phase?: Phase;
  
  // Event-specific data
  data: Record<string, unknown>;
  
  // Optional performance and error info
  durationMs?: number;
  error?: {
    message: string;
    type: string;
    stack?: string;
  };
}

/**
 * Unified logger for all system events
 * Writes to a single chronological JSONL file per day
 */
export class UnifiedLogger {
  private readonly logDir: string;
  private sequenceCounter = 0;
  private module: LogModule = "agent";

  constructor(projectPath: string) {
    this.logDir = join(projectPath, ".tenex", "logs", "events");
  }

  private async ensureLogDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  private getLogFileName(): string {
    const date = new Date().toISOString().split("T")[0];
    return `${date}.jsonl`;
  }

  private getLogFilePath(): string {
    return join(this.logDir, this.getLogFileName());
  }

  private getNextSequenceNumber(): number {
    return ++this.sequenceCounter;
  }

  /**
   * Write event to JSONL file
   */
  private async writeEvent(event: UnifiedLogEvent): Promise<void> {
    try {
      await this.ensureLogDirectory();
      const logLine = `${JSON.stringify(event)}\n`;
      const logFilePath = this.getLogFilePath();
      await fs.appendFile(logFilePath, logLine, "utf-8");
    } catch (error) {
      console.error("[UnifiedLogger] Failed to write event:", error);
    }
  }

  /**
   * Log a generic event
   */
  async logEvent(
    eventType: EventType,
    conversationId: string,
    agentName: string,
    data: Record<string, unknown>,
    options?: {
      phase?: Phase;
      durationMs?: number;
      error?: Error;
    }
  ): Promise<void> {
    const event: UnifiedLogEvent = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      sequenceNumber: this.getNextSequenceNumber(),
      eventType,
      conversationId,
      agentName,
      phase: options?.phase,
      data,
      durationMs: options?.durationMs,
      error: options?.error
        ? {
            message: options.error.message,
            type: options.error.constructor.name,
            stack: options.error.stack,
          }
        : undefined,
    };

    await this.writeEvent(event);
    this.logToConsole(event);
  }

  /**
   * Log LLM call (request and response)
   */
  async logLLMCall(
    configKey: string,
    config: ResolvedLLMConfig,
    request: CompletionRequest,
    result: { response?: CompletionResponse; error?: Error },
    performance: { startTime: number; endTime: number }
  ): Promise<void> {
    const durationMs = performance.endTime - performance.startTime;
    const agentName = request.options?.agentName || "unknown";
    const conversationId = (request.options as any)?.conversationId || "unknown";
    const phase = (request.options as any)?.phase as Phase | undefined;

    // Log request
    await this.logEvent("llm_request", conversationId, agentName, {
      configKey,
      provider: config.provider,
      model: config.model,
      messageCount: request.messages.length,
      totalRequestLength: request.messages.reduce((sum, msg) => sum + msg.content.length, 0),
      messages: request.messages.map((msg, index) => {
        let content = msg.content;
        // Truncate large system prompts
        if (index === 0 && msg.role === "system" && msg.content.length > 10000) {
          content = `${msg.content.substring(0, 100)}<REST-OF-SYSTEM-PROMPT-TRIMMED>`;
        }
        return {
          role: msg.role,
          content,
          contentLength: msg.content.length,
        };
      }),
    }, { phase });

    // Log response
    if (result.response || result.error) {
      await this.logEvent(
        "llm_response",
        conversationId,
        agentName,
        {
          configKey,
          model: config.model,
          content: result.response?.content,
          contentLength: result.response?.content?.length || 0,
          toolCalls: result.response?.toolCalls?.map((tc) => ({
            name: tc.name,
            params: tc.params,
          })),
          toolCallCount: result.response?.toolCalls?.length || 0,
          usage: result.response?.usage
            ? {
                promptTokens: result.response.usage.prompt_tokens,
                completionTokens: result.response.usage.completion_tokens,
                totalTokens:
                  (result.response.usage.prompt_tokens || 0) +
                  (result.response.usage.completion_tokens || 0),
              }
            : undefined,
        },
        {
          phase,
          durationMs,
          error: result.error,
        }
      );
    }
  }

  /**
   * Log tool call
   */
  async logToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolExecutionResult,
    performance: { startTime: number; endTime: number }
  ): Promise<void> {
    const durationMs = performance.endTime - performance.startTime;

    // Log tool call
    await this.logEvent(
      "tool_call",
      context.conversationId,
      context.agent.name,
      {
        tool: toolName,
        args,
        argsLength: JSON.stringify(args).length,
      },
      {
        phase: context.phase,
      }
    );

    // Log tool result
    await this.logEvent(
      "tool_result",
      context.conversationId,
      context.agent.name,
      {
        tool: toolName,
        status: result.success ? "success" : "error",
        output: this.extractOutput(result),
        outputLength: this.extractOutput(result)?.length,
        error: result.error ? this.formatToolError(result.error) : undefined,
      },
      {
        phase: context.phase,
        durationMs,
      }
    );
  }

  /**
   * Log conversation start
   */
  async logConversationStart(
    conversationId: string,
    userMessage: string,
    eventId?: string
  ): Promise<void> {
    await this.logEvent("conversation_start", conversationId, "Orchestrator", {
      userMessage,
      eventId,
    });
  }

  /**
   * Log phase transition
   */
  async logPhaseTransition(
    conversationId: string,
    agentName: string,
    from: Phase,
    to: Phase
  ): Promise<void> {
    await this.logEvent("phase_transition", conversationId, agentName, {
      from,
      to,
    });
  }

  /**
   * Log execution start/complete
   */
  async logExecution(
    type: "start" | "complete",
    conversationId: string,
    agentName: string,
    narrative: string,
    success?: boolean
  ): Promise<void> {
    await this.logEvent(
      type === "start" ? "execution_start" : "execution_complete",
      conversationId,
      agentName,
      {
        narrative,
        success,
      }
    );
  }

  /**
   * Console output for real-time monitoring
   */
  private logToConsole(event: UnifiedLogEvent): void {
    const shortId = event.conversationId.substring(0, 8);

    switch (event.eventType) {
      case "conversation_start":
        logInfo(
          `\n${chalk.bold.cyan(`🗣️  NEW CONVERSATION [${shortId}]`)}\n` +
          `${chalk.white(`   User: ${chalk.italic(this.truncate(event.data.userMessage as string, 80))}`)}`,
          this.module,
          "normal"
        );
        break;

      case "phase_transition":
        logInfo(
          `\n${chalk.cyan(`🔄 PHASE TRANSITION [${shortId}]`)}\n` +
          `${chalk.white(`   ${chalk.red(event.data.from as string)} → ${chalk.green(event.data.to as string)}`)}` +
          `${chalk.white(`   Agent: ${chalk.bold(event.agentName)}`)}`,
          this.module,
          "normal"
        );
        break;

      case "tool_call":
        logInfo(
          `${chalk.yellow(`🔧 TOOL CALL [${chalk.bold(event.agentName)}]`)}\n` +
          `${chalk.white(`   Tool: ${chalk.bold(event.data.tool as string)}`)}`,
          this.module,
          "verbose"
        );
        break;

      case "tool_result":
        const status = event.data.status as string;
        const statusColor = status === "success" ? chalk.green : chalk.red;
        const statusIcon = status === "success" ? "✅" : "❌";
        logInfo(
          `${statusColor(`${statusIcon} TOOL RESULT [${chalk.bold(event.agentName)}]`)}\n` +
          `${chalk.white(`   Tool: ${chalk.bold(event.data.tool as string)} → ${statusColor(status.toUpperCase())}`)}` +
          (event.durationMs ? `\n${chalk.dim(`   Duration: ${(event.durationMs / 1000).toFixed(2)}s`)}` : ""),
          this.module,
          "verbose"
        );
        break;

      case "execution_start":
        logInfo(
          `\n${chalk.cyan(`▶️  EXECUTION START [${shortId}]`)}\n` +
          `${chalk.white(`   ${event.data.narrative as string}`)}`,
          this.module,
          "verbose"
        );
        break;

      case "execution_complete":
        const success = event.data.success as boolean;
        const completeColor = success ? chalk.green : chalk.red;
        const completeIcon = success ? "✅" : "❌";
        logInfo(
          `\n${completeColor(`${completeIcon} EXECUTION COMPLETE [${shortId}]`)}\n` +
          `${chalk.white(`   ${event.data.narrative as string}`)}`,
          this.module,
          "verbose"
        );
        break;
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}...`;
  }

  private extractOutput(result: ToolExecutionResult): string | undefined {
    if (!result.success || result.output === undefined) {
      return undefined;
    }

    const output = result.output;

    if (typeof output === "object" && output !== null && "type" in output) {
      if (output.type === "continue" && "routing" in output) {
        return `Control flow: ${output.type}`;
      }
      if (
        output.type === "complete" &&
        "completion" in output &&
        typeof output.completion === "object" &&
        output.completion !== null &&
        "response" in output.completion &&
        typeof output.completion.response === "string"
      ) {
        return output.completion.response;
      }
    }

    return String(result.output);
  }

  private formatToolError(error: ToolError): string {
    switch (error.kind) {
      case "validation":
        return `Validation error in ${error.field}: ${error.message}`;
      case "execution":
        return `Execution error in ${error.tool}: ${error.message}`;
      case "system":
        return `System error: ${error.message}`;
    }
  }

  /**
   * Set the log module for console output verbosity control
   */
  setModule(module: LogModule): void {
    this.module = module;
  }

  /**
   * Create a logger with a specific tracing context
   */
  withContext(context: TracingContext): ContextualLogger {
    return new ContextualLogger(this, context);
  }
}

/**
 * Contextual logger that automatically includes tracing context
 */
export class ContextualLogger {
  constructor(
    private logger: UnifiedLogger,
    private context: TracingContext
  ) {}

  async logEvent(
    type: EventType,
    data: Record<string, unknown>,
    options?: {
      durationMs?: number;
      error?: Error;
    }
  ): Promise<void> {
    await this.logger.logEvent(
      type,
      this.context.conversationId || "unknown",
      this.context.currentAgent || "unknown",
      data,
      {
        phase: this.context.currentPhase as Phase | undefined,
        ...options,
      }
    );
  }

  // Convenience methods for common events
  async toolStart(tool: string, parameters?: Record<string, unknown>): Promise<void> {
    await this.logEvent("tool_call", {
      tool,
      args: parameters,
    });
  }

  async toolComplete(
    tool: string,
    status: "success" | "error",
    duration: number,
    options?: { result?: string; error?: string }
  ): Promise<void> {
    await this.logEvent(
      "tool_result",
      {
        tool,
        status,
        output: options?.result,
        error: options?.error,
      },
      { durationMs: duration }
    );
  }

  async routingDecision(
    targetAgents: string[],
    reason: string,
    targetPhase?: Phase
  ): Promise<void> {
    await this.logEvent("routing", {
      targetAgents,
      reason,
      targetPhase,
    });
  }
}

// Singleton instance
let globalLogger: UnifiedLogger | null = null;

export function initializeUnifiedLogger(projectPath: string): UnifiedLogger {
  globalLogger = new UnifiedLogger(projectPath);
  return globalLogger;
}

export function getUnifiedLogger(): UnifiedLogger | null {
  return globalLogger;
}

/**
 * Create a contextual logger for a specific execution context
 */
export function createExecutionLogger(
  context: TracingContext,
  module?: LogModule
): ContextualLogger {
  const logger = getUnifiedLogger();
  if (!logger) {
    throw new Error("UnifiedLogger not initialized");
  }
  if (module) {
    logger.setModule(module);
  }
  return logger.withContext(context);
}
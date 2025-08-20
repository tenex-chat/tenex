import chalk from "chalk";
import type { Phase } from "@/conversations/phases";
import type { TracingContext } from "@/tracing";
import { formatDuration } from "@/utils/formatting";
import type { LogModule } from "@/utils/logger";
import { logInfo } from "@/utils/logger";

/**
 * Simplified event system using discriminated unions
 * All events share common base properties and extend with specific fields
 */
export type LogEvent = {
  timestamp: Date;
  conversationId: string;
  agent: string;
} & (
  | { type: "tool_call"; tool: string; args?: Record<string, unknown> }
  | {
      type: "tool_result";
      tool: string;
      status: "success" | "error";
      result?: unknown;
      error?: string;
      duration: number;
    }
  | { type: "phase_transition"; from: Phase; to: Phase }
  | { type: "routing"; targetAgents: string[]; targetPhase?: Phase; reason: string }
  | { type: "conversation_start"; userMessage: string; eventId?: string }
  | { type: "conversation_complete"; finalPhase: Phase; success: boolean; duration: number }
  | { type: "execution_start"; narrative: string }
  | { type: "execution_complete"; narrative: string; success: boolean }
);

/**
 * Unified execution logger for structured event logging
 */
export class ExecutionLogger {
  private startTimes: Map<string, number> = new Map();

  constructor(
    private context: TracingContext,
    private module: LogModule = "agent"
  ) {}

  /**
   * Update context (e.g., when agent changes)
   */
  updateContext(context: TracingContext): void {
    this.context = context;
  }

  /**
   * Log an event with structured formatting
   */
  logEvent(event: LogEvent): void {
    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = new Date();
    }

    switch (event.type) {
      case "tool_call":
        this.logToolCall(event);
        break;
      case "tool_result":
        this.logToolResult(event);
        break;
      case "phase_transition":
        this.logPhaseTransition(event);
        break;
      case "routing":
        this.logRouting(event);
        break;
      case "conversation_start":
        this.logConversationStart(event);
        break;
      case "conversation_complete":
        this.logConversationComplete(event);
        break;
      case "execution_start":
        this.logExecutionStart(event);
        break;
      case "execution_complete":
        this.logExecutionComplete(event);
        break;
    }
  }

  // Tool Events
  private logToolCall(event: LogEvent & { type: "tool_call" }): void {
    const key = `${event.agent}-${event.tool}`;
    this.startTimes.set(key, Date.now());

    const message = [
      "",
      chalk.yellow(`🔧 TOOL CALL [${chalk.bold(event.agent)}]`),
      chalk.white(`    ├─ Tool: ${chalk.bold(event.tool)}`),
      ...(event.args && Object.keys(event.args).length > 0
        ? [chalk.gray(`    └─ Arguments: ${this.formatParams(event.args)}`)]
        : []),
    ].join("\n");

    logInfo(message, this.module, "verbose");
  }

  private logToolResult(event: LogEvent & { type: "tool_result" }): void {
    const statusColor = event.status === "success" ? chalk.green : chalk.red;
    const statusIcon = event.status === "success" ? "✅" : "❌";

    const messageLines = [
      "",
      statusColor(`${statusIcon} TOOL RESULT [${chalk.bold(event.agent)}]`),
      chalk.white(
        `    ├─ Tool: ${chalk.bold(event.tool)} → ${statusColor(event.status.toUpperCase())}`
      ),
      chalk.dim(`    ├─ Duration: ${(event.duration / 1000).toFixed(2)}s`),
    ];

    if (event.result) {
      const resultStr =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      messageLines.push(chalk.gray(`    ├─ Result: ${this.truncate(resultStr, 80)}`));
    }

    if (event.error) {
      messageLines.push(chalk.red(`    └─ Error: ${event.error}`));
    }

    logInfo(messageLines.join("\n"), this.module, "verbose");
  }

  // Phase Transition
  private logPhaseTransition(event: LogEvent & { type: "phase_transition" }): void {
    const message = [
      "",
      chalk.cyan(`🔄 PHASE TRANSITION [${this.shortId(event.conversationId)}]`),
      chalk.white(`    ├─ ${chalk.red(event.from)} → ${chalk.green(event.to)}`),
      chalk.white(`    └─ Agent: ${chalk.bold(event.agent)}`),
    ].join("\n");

    logInfo(message, this.module, "normal");
  }

  // Routing
  private logRouting(event: LogEvent & { type: "routing" }): void {
    const messageLines = [
      "",
      chalk.green(`📍 ROUTING [${chalk.bold(event.agent)}]`),
      chalk.white(`    ├─ Target agents: ${chalk.bold(event.targetAgents.join(", "))}`),
    ];

    if (event.targetPhase) {
      messageLines.push(chalk.white(`    ├─ Target phase: ${chalk.bold(event.targetPhase)}`));
    }

    messageLines.push(chalk.gray(`    └─ Reason: ${event.reason}`));

    logInfo(messageLines.join("\n"), this.module, "verbose");
  }

  // Conversation Events
  private logConversationStart(event: LogEvent & { type: "conversation_start" }): void {
    const messageLines = [
      "",
      chalk.bold.cyan(`🗣️  NEW CONVERSATION [${this.shortId(event.conversationId)}]`),
      chalk.white(`    User: ${chalk.italic(this.truncate(event.userMessage, 80))}`),
    ];

    if (event.eventId) {
      messageLines.push(chalk.dim(`    Event: ${this.shortId(event.eventId)}`));
    }
    messageLines.push("");

    logInfo(messageLines.join("\n"), this.module, "normal");
  }

  private logConversationComplete(event: LogEvent & { type: "conversation_complete" }): void {
    const statusColor = event.success ? chalk.green : chalk.red;
    const statusIcon = event.success ? "✅" : "❌";

    const message = [
      "",
      statusColor(`${statusIcon} CONVERSATION COMPLETE [${this.shortId(event.conversationId)}]`),
      chalk.white(`    ├─ Final phase: ${chalk.bold(event.finalPhase)}`),
      chalk.white(`    ├─ Duration: ${formatDuration(event.duration)}`),
      statusColor(`    └─ Success: ${event.success}`),
      "",
    ].join("\n");

    logInfo(message, this.module, "normal");
  }

  // Execution Flow Events
  private logExecutionStart(event: LogEvent & { type: "execution_start" }): void {
    const message = [
      "",
      chalk.cyan(`▶️  EXECUTION START [${this.shortId(event.conversationId)}]`),
      chalk.white(`    ${event.narrative}`),
    ].join("\n");

    logInfo(message, this.module, "verbose");
  }

  private logExecutionComplete(event: LogEvent & { type: "execution_complete" }): void {
    const statusColor = event.success ? chalk.green : chalk.red;
    const statusIcon = event.success ? "✅" : "❌";

    const message = [
      "",
      statusColor(`${statusIcon} EXECUTION COMPLETE [${this.shortId(event.conversationId)}]`),
      chalk.white(`    ${event.narrative}`),
    ].join("\n");

    logInfo(message, this.module, "verbose");
  }

  // Helper methods
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}...`;
  }

  private shortId(id: string): string {
    return id.substring(0, 8);
  }

  private formatParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params).slice(0, 3);
    const formatted = entries.map(([k, v]) => `${k}=${this.formatValue(v)}`).join(", ");
    return entries.length < Object.keys(params).length ? `${formatted}, ...` : formatted;
  }

  private formatValue(value: unknown): string {
    if (typeof value === "string") return `"${this.truncate(value, 30)}"`;
    if (typeof value === "object" && value !== null) return "{...}";
    return String(value);
  }

  // Quick logging methods for backward compatibility
  toolStart(agent: string, tool: string, parameters?: Record<string, unknown>): void {
    this.logEvent({
      type: "tool_call",
      timestamp: new Date(),
      conversationId: this.context.conversationId || "",
      agent,
      tool,
      args: parameters,
    });
  }

  toolComplete(
    agent: string,
    tool: string,
    status: "success" | "error",
    duration: number,
    options?: { result?: string; error?: string }
  ): void {
    this.logEvent({
      type: "tool_result",
      timestamp: new Date(),
      conversationId: this.context.conversationId || "",
      agent,
      tool,
      status,
      duration,
      result: options?.result,
      error: options?.error,
    });
  }

  routingDecision(
    agent: string,
    targetAgents: string[],
    reason: string,
    options?: { targetPhase?: Phase }
  ): void {
    this.logEvent({
      type: "routing",
      timestamp: new Date(),
      conversationId: this.context.conversationId || "",
      agent,
      targetAgents,
      reason,
      targetPhase: options?.targetPhase,
    });
  }
}

/**
 * Create an execution logger instance
 */
export function createExecutionLogger(
  context: TracingContext,
  module?: LogModule
): ExecutionLogger {
  return new ExecutionLogger(context, module);
}

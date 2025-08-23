import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse, ResolvedLLMConfig } from "@/llm/types";
import type { ExecutionContext, ToolError, ToolExecutionResult } from "@/tools/types";

export type LogEntryType = "llm_call" | "tool_call";

export interface BaseLogEntry {
  timestamp: string;
  timestampMs: number;
  requestId: string;
  type: LogEntryType;
  sequenceNumber: number;
  
  // Context shared across all entries
  agentName: string;
  conversationId: string;
  phase?: string;
}

export interface LLMLogEntry extends BaseLogEntry {
  type: "llm_call";
  
  // LLM specific fields
  configKey: string;
  config: {
    provider: string;
    model: string;
    baseUrl?: string;
    enableCaching?: boolean;
    temperature?: number;
    maxTokens?: number;
  };
  
  request: {
    messages: Array<{
      role: string;
      content: string;
      contentLength: number;
    }>;
    options?: Record<string, unknown>;
    messageCount: number;
    totalRequestLength: number;
  };
  
  response?: {
    content?: string;
    contentLength?: number;
    toolCalls?: Array<{
      name: string;
      params: unknown;
      paramsLength: number;
    }>;
    toolCallCount: number;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cost?: number;
    };
  };
  
  error?: {
    message: string;
    stack?: string;
    type: string;
  };
  
  status: "success" | "error";
  durationMs: number;
}

export interface ToolLogEntry extends BaseLogEntry {
  type: "tool_call";
  
  // Tool specific fields
  toolName: string;
  args: Record<string, unknown>;
  argsLength: number;
  
  status: "success" | "error";
  output?: string;
  outputLength?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  
  performance: {
    startTime: number;
    endTime: number;
    durationMs: number;
  };
  
  trace: {
    callStack?: string[];
    parentRequestId?: string;
    batchId?: string;
    batchIndex?: number;
    batchSize?: number;
  };
}

export type ExecutionLogEntry = LLMLogEntry | ToolLogEntry;

export class ExecutionLogger {
  private readonly logDir: string;
  private sequenceCounter = 0;
  
  constructor(projectPath: string) {
    this.logDir = join(projectPath, ".tenex", "logs", "execution");
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
    return `execution-${date}.jsonl`;
  }
  
  private getLogFilePath(): string {
    return join(this.logDir, this.getLogFileName());
  }
  
  private generateRequestId(prefix: string, suffix: string): string {
    return `${prefix}-${suffix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private getNextSequenceNumber(): number {
    return ++this.sequenceCounter;
  }
  
  async logLLMCall(
    configKey: string,
    config: ResolvedLLMConfig,
    request: CompletionRequest,
    result: { response?: CompletionResponse; error?: Error },
    performance: { startTime: number; endTime: number }
  ): Promise<void> {
    try {
      await this.ensureLogDirectory();
      
      const requestId = this.generateRequestId("llm", configKey);
      const durationMs = performance.endTime - performance.startTime;
      const timestamp = new Date().toISOString();
      const agentName = request.options?.agentName || "unknown";
      const conversationId = (request.options as any)?.conversationId || "unknown";
      
      const totalRequestLength = request.messages.reduce((sum, msg) => sum + msg.content.length, 0);
      
      const logEntry: LLMLogEntry = {
        timestamp,
        timestampMs: performance.startTime,
        requestId,
        type: "llm_call",
        sequenceNumber: this.getNextSequenceNumber(),
        
        agentName,
        conversationId,
        phase: (request.options as any)?.phase as string | undefined,
        
        configKey,
        config: {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          enableCaching: config.enableCaching,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        },
        
        request: {
          messages: request.messages.map((msg, index) => {
            let content = msg.content;
            
            // Trim system prompt if it's the first message and longer than 10000 chars
            if (index === 0 && msg.role === "system" && msg.content.length > 10000) {
              content = `${msg.content.substring(0, 100)}<REST-OF-SYSTEM-PROMPT-TRIMMED>`;
            } else if (agentName === "Orchestrator" && msg.role === "user") {
              try {
                const parsed = JSON.parse(msg.content);
                content = parsed;
              } catch {
                // Keep as-is
              }
            }
            
            return {
              role: msg.role,
              content,
              contentLength: msg.content.length,
            };
          }),
          options: request.options as Record<string, unknown> | undefined,
          messageCount: request.messages.length,
          totalRequestLength,
        },
        
        status: result.error ? "error" : "success",
        durationMs,
      };
      
      if (result.response) {
        let responseContent: unknown = result.response.content;
        if (result.response.content) {
          try {
            const parsed = JSON.parse(result.response.content);
            responseContent = parsed;
          } catch {
            // Keep as-is
          }
        }
        
        logEntry.response = {
          content: responseContent as string | undefined,
          contentLength: result.response.content?.length || 0,
          toolCalls: result.response.toolCalls?.map((tc) => ({
            name: tc.name,
            params: tc.params,
            paramsLength: JSON.stringify(tc.params).length,
          })),
          toolCallCount: result.response.toolCalls?.length || 0,
          usage: result.response.usage
            ? {
                promptTokens: result.response.usage.prompt_tokens,
                completionTokens: result.response.usage.completion_tokens,
                totalTokens:
                  (result.response.usage.prompt_tokens || 0) +
                  (result.response.usage.completion_tokens || 0),
                cost: undefined,
              }
            : undefined,
        };
      }
      
      if (result.error) {
        logEntry.error = {
          message: result.error.message,
          stack: result.error.stack,
          type: result.error.constructor.name,
        };
      }
      
      const logLine = `${JSON.stringify(logEntry)}\n`;
      const logFilePath = this.getLogFilePath();
      
      await fs.appendFile(logFilePath, logLine, "utf-8");
    } catch (logError) {
      console.error("[Execution Logger] Failed to log LLM call:", logError);
    }
  }
  
  async logToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolExecutionResult,
    performance: { startTime: number; endTime: number },
    trace?: {
      callStack?: string[];
      parentRequestId?: string;
      batchId?: string;
      batchIndex?: number;
      batchSize?: number;
    }
  ): Promise<void> {
    try {
      await this.ensureLogDirectory();
      
      const requestId = this.generateRequestId("tool", toolName);
      const durationMs = performance.endTime - performance.startTime;
      const timestamp = new Date().toISOString();
      
      const logEntry: ToolLogEntry = {
        timestamp,
        timestampMs: performance.startTime,
        requestId,
        type: "tool_call",
        sequenceNumber: this.getNextSequenceNumber(),
        
        agentName: context.agent.name,
        conversationId: context.conversationId,
        phase: context.phase,
        
        toolName,
        args,
        argsLength: JSON.stringify(args).length,
        
        status: result.success ? "success" : "error",
        output: this.extractOutput(result),
        outputLength: this.extractOutput(result)?.length,
        error: result.error ? this.formatError(result.error) : undefined,
        metadata: this.extractMetadata(result),
        
        performance: {
          startTime: performance.startTime,
          endTime: performance.endTime,
          durationMs,
        },
        
        trace: {
          callStack: trace?.callStack,
          parentRequestId: trace?.parentRequestId,
          batchId: trace?.batchId,
          batchIndex: trace?.batchIndex,
          batchSize: trace?.batchSize,
        },
      };
      
      const logLine = `${JSON.stringify(logEntry)}\n`;
      const logFilePath = this.getLogFilePath();
      
      await fs.appendFile(logFilePath, logLine, "utf-8");
    } catch (logError) {
      console.error("[Execution Logger] Failed to log tool call:", logError);
    }
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
  
  private extractMetadata(result: ToolExecutionResult): Record<string, unknown> | undefined {
    if (!result.success || !result.output) {
      return undefined;
    }
    
    const output = result.output;
    
    if (typeof output === "object" && output !== null && "type" in output) {
      if (output.type === "continue" && "routing" in output) {
        return { flow: output };
      }
      if (output.type === "complete" && "completion" in output) {
        return { termination: output };
      }
    }
    
    return undefined;
  }
  
  private formatError(error: ToolError): string {
    switch (error.kind) {
      case "validation":
        return `Validation error in ${error.field}: ${error.message}`;
      case "execution":
        return `Execution error in ${error.tool}: ${error.message}`;
      case "system":
        return `System error: ${error.message}`;
    }
  }
}

// Singleton instance
let globalLogger: ExecutionLogger | null = null;

export function initializeExecutionLogger(projectPath: string): ExecutionLogger {
  globalLogger = new ExecutionLogger(projectPath);
  return globalLogger;
}

export function getExecutionLogger(): ExecutionLogger | null {
  return globalLogger;
}
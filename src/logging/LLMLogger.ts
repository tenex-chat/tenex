import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { Message, CompletionResponse } from "@/llm/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface LLMLogEntry {
  timestamp: string;
  timestampMs: number;
  agent: string;
  rootEventId?: string;
  triggeringEventId?: string;
  conversationId?: string;
  phase?: string;
  configKey: string;
  provider: string;
  model: string;
  request: {
    messages: Array<{
      role: string;
      content: string;
    }>;
    tools?: Array<{
      name: string;
      description?: string;
    }>;
  };
  response?: {
    content?: string;
    toolCalls?: Array<{
      name: string;
      params: Record<string, unknown>;
    }>;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    model?: string;
  };
  error?: {
    message: string;
    type: string;
    stack?: string;
  };
  durationMs?: number;
}

/**
 * Specialized logger for LLM interactions
 * Creates clear, human-readable logs with exact messages and responses
 */
export class LLMLogger {
  private readonly logDir: string;

  constructor(projectPath: string) {
    this.logDir = join(projectPath, ".tenex", "logs", "llm");
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
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().split(" ")[0].replace(/:/g, "-");
    return `${date}_${time}.json`;
  }

  private getLogFilePath(filename: string): string {
    return join(this.logDir, filename);
  }

  /**
   * Log an LLM request and response
   */
  async logLLMInteraction(params: {
    agent: string;
    rootEvent?: NDKEvent;
    triggeringEvent?: NDKEvent;
    conversationId?: string;
    phase?: string;
    configKey: string;
    provider: string;
    model: string;
    messages: Message[];
    tools?: Array<{ name: string; description?: string }>;
    response?: CompletionResponse;
    error?: Error;
    startTime: number;
    endTime: number;
  }): Promise<void> {
    await this.ensureLogDirectory();

    const logEntry: LLMLogEntry = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      agent: params.agent,
      rootEventId: params.rootEvent?.id,
      triggeringEventId: params.triggeringEvent?.id,
      conversationId: params.conversationId,
      phase: params.phase,
      configKey: params.configKey,
      provider: params.provider,
      model: params.model,
      request: {
        messages: params.messages.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        tools: params.tools
      },
      durationMs: params.endTime - params.startTime
    };

    if (params.response) {
      logEntry.response = {
        content: params.response.content,
        toolCalls: params.response.toolCalls?.map(tc => ({
          name: tc.name,
          params: tc.params
        })),
        usage: params.response.usage ? {
          promptTokens: params.response.usage.prompt_tokens || 0,
          completionTokens: params.response.usage.completion_tokens || 0,
          totalTokens: (params.response.usage.prompt_tokens || 0) + (params.response.usage.completion_tokens || 0)
        } : undefined,
        model: params.response.model
      };
    }

    if (params.error) {
      logEntry.error = {
        message: params.error.message,
        type: params.error.constructor.name,
        stack: params.error.stack
      };
    }

    // Write to a new file for each interaction for clarity
    const filename = this.getLogFileName();
    const filepath = this.getLogFilePath(filename);
    
    try {
      await fs.writeFile(filepath, JSON.stringify(logEntry, null, 2), "utf-8");
      
      // Also append a summary to a daily log file
      const dailyLogFile = join(this.logDir, `${new Date().toISOString().split("T")[0]}_summary.jsonl`);
      const summary = {
        timestamp: logEntry.timestamp,
        file: filename,
        agent: logEntry.agent,
        model: logEntry.model,
        rootEventId: logEntry.rootEventId,
        triggeringEventId: logEntry.triggeringEventId,
        conversationId: logEntry.conversationId,
        phase: logEntry.phase,
        requestTokens: logEntry.response?.usage?.promptTokens,
        responseTokens: logEntry.response?.usage?.completionTokens,
        durationMs: logEntry.durationMs,
        hasError: !!logEntry.error,
        errorMessage: logEntry.error?.message
      };
      
      await fs.appendFile(dailyLogFile, JSON.stringify(summary) + "\n", "utf-8");
      
      console.log(`[LLMLogger] Logged LLM interaction to ${filename}`);
    } catch (error) {
      console.error("[LLMLogger] Failed to write log:", error);
    }
  }

  /**
   * Get recent log files
   */
  async getRecentLogs(limit: number = 10): Promise<string[]> {
    try {
      await this.ensureLogDirectory();
      const files = await fs.readdir(this.logDir);
      const jsonFiles = files
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);
      return jsonFiles.map(f => this.getLogFilePath(f));
    } catch (error) {
      console.error("[LLMLogger] Failed to list logs:", error);
      return [];
    }
  }

  /**
   * Read a specific log file
   */
  async readLog(filename: string): Promise<LLMLogEntry | null> {
    try {
      const filepath = this.getLogFilePath(filename);
      const content = await fs.readFile(filepath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`[LLMLogger] Failed to read log ${filename}:`, error);
      return null;
    }
  }
}

// Singleton instance
let llmLogger: LLMLogger | null = null;

export function initializeLLMLogger(projectPath: string): LLMLogger {
  if (!llmLogger) {
    llmLogger = new LLMLogger(projectPath);
  }
  return llmLogger;
}

export function getLLMLogger(): LLMLogger | null {
  return llmLogger;
}
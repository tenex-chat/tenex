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
    tools?: string[];
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
    this.logDir = join(projectPath, ".tenex", "logs", "llms");
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
    const hours = now.getHours();
    const minutes = now.getMinutes();
    // Round down to nearest 5-minute increment
    const roundedMinutes = Math.floor(minutes / 5) * 5;
    const timeStr = `${hours.toString().padStart(2, '0')}:${roundedMinutes.toString().padStart(2, '0')}`;
    return `${date}_${timeStr}.jsonl`;
  }

  private getLogFilePath(filename: string): string {
    return join(this.logDir, filename);
  }

  /**
   * Log an LLM request immediately, returns a unique ID for updating with response
   */
  async logLLMRequest(params: {
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
    startTime: number;
  }): Promise<string> {
    await this.ensureLogDirectory();

    const requestId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
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
        tools: params.tools?.map(t => t.name)
      }
    };

    const filename = this.getLogFileName();
    const filepath = this.getLogFilePath(filename);
    
    try {
      // Append to JSONL file (one JSON object per line)
      await fs.appendFile(filepath, JSON.stringify({ ...logEntry, requestId }) + "\n", "utf-8");
      console.log(`[LLMLogger] Logged LLM request to ${filename}`);
    } catch (error) {
      console.error("[LLMLogger] Failed to write log:", error);
    }

    return requestId;
  }

  /**
   * Update a previously logged request with its response
   */
  async logLLMResponse(params: {
    requestId: string;
    response?: CompletionResponse;
    error?: Error;
    endTime: number;
    startTime: number;
  }): Promise<void> {
    const filename = this.getLogFileName();
    const filepath = this.getLogFilePath(filename);

    const responseEntry: Partial<LLMLogEntry> = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      durationMs: params.endTime - params.startTime
    };

    if (params.response) {
      responseEntry.response = {
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
      responseEntry.error = {
        message: params.error.message,
        type: params.error.constructor.name,
        stack: params.error.stack
      };
    }

    try {
      // Append response entry with the same requestId
      await fs.appendFile(filepath, JSON.stringify({ ...responseEntry, requestId: params.requestId, type: 'response' }) + "\n", "utf-8");
      console.log(`[LLMLogger] Logged LLM response to ${filename}`);
    } catch (error) {
      console.error("[LLMLogger] Failed to write response log:", error);
    }
  }

  /**
   * Log an LLM request and response (backward compatibility)
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
    // First log the request
    const requestId = await this.logLLMRequest({
      agent: params.agent,
      rootEvent: params.rootEvent,
      triggeringEvent: params.triggeringEvent,
      conversationId: params.conversationId,
      phase: params.phase,
      configKey: params.configKey,
      provider: params.provider,
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      startTime: params.startTime
    });

    // Then log the response if we have one
    if (params.response || params.error) {
      await this.logLLMResponse({
        requestId,
        response: params.response,
        error: params.error,
        endTime: params.endTime,
        startTime: params.startTime
      });
    }
  }

  /**
   * Get recent log files
   */
  async getRecentLogs(limit: number = 10): Promise<string[]> {
    try {
      await this.ensureLogDirectory();
      const files = await fs.readdir(this.logDir);
      const jsonlFiles = files
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, limit);
      return jsonlFiles.map(f => this.getLogFilePath(f));
    } catch (error) {
      console.error("[LLMLogger] Failed to list logs:", error);
      return [];
    }
  }

  /**
   * Read a specific log file (JSONL format)
   */
  async readLog(filename: string): Promise<LLMLogEntry[] | null> {
    try {
      const filepath = this.getLogFilePath(filename);
      const content = await fs.readFile(filepath, "utf-8");
      const lines = content.split('\n').filter(line => line.trim());
      return lines.map(line => JSON.parse(line));
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
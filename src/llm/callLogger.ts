import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse, ResolvedLLMConfig } from "./types";

export interface LLMCallLogEntry {
    timestamp: string;
    timestampMs: number;
    requestId: string;
    duration?: number;
    durationMs?: number;

    // Configuration context
    configKey: string;
    config: {
        provider: string;
        model: string;
        baseUrl?: string;
        enableCaching?: boolean;
        temperature?: number;
        maxTokens?: number;
    };

    // Request context
    agentName?: string;
    context?: {
        configName?: string;
        agentName?: string;
    };

    // Complete request data
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

    // Complete response data (if successful)
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

    // Error data (if failed)
    error?: {
        message: string;
        stack?: string;
        type: string;
    };

    // Status
    status: "success" | "error";

}

export class LLMCallLogger {
    private readonly logDir: string;

    constructor(projectPath: string) {
        this.logDir = join(projectPath, ".tenex", "logs", "llms");
    }

    private async ensureLogDirectory(): Promise<void> {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (error) {
            // Ignore if directory already exists
            if (error instanceof Error && "code" in error && error.code !== "EEXIST") {
                throw error;
            }
        }
    }

    private getLogFileName(agentName?: string): string {
        const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
        if (agentName) {
            // Sanitize agent name for filename
            const safeAgentName = agentName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
            return `llm-calls-${date}-${safeAgentName}.jsonl`;
        }
        return `llm-calls-${date}.jsonl`;
    }

    private getLogFilePath(agentName?: string): string {
        return join(this.logDir, this.getLogFileName(agentName));
    }

    private generateRequestId(configKey: string): string {
        return `${configKey}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

            const requestId = this.generateRequestId(configKey);
            const durationMs = performance.endTime - performance.startTime;
            const timestamp = new Date().toISOString();

            // Calculate total request length
            const totalRequestLength = request.messages.reduce(
                (sum, msg) => sum + msg.content.length,
                0
            );

            // Build log entry
            const logEntry: LLMCallLogEntry = {
                timestamp,
                timestampMs: performance.startTime,
                requestId,
                duration: Math.round((durationMs / 1000) * 100) / 100, // seconds with 2 decimals
                durationMs,

                configKey,
                config: {
                    provider: config.provider,
                    model: config.model,
                    baseUrl: config.baseUrl,
                    enableCaching: config.enableCaching,
                    temperature: config.temperature,
                    maxTokens: config.maxTokens,
                },

                agentName: request.options?.agentName,
                context: {
                    configName: request.options?.configName,
                    agentName: request.options?.agentName,
                },

                request: {
                    messages: request.messages.map((msg, index) => {
                        let content = msg.content;
                        
                        // Trim system prompt if it's the first message and longer than 1000 chars
                        if (index === 0 && msg.role === "system" && msg.content.length > 1000) {
                            content = msg.content.substring(0, 100) + "<REST-OF-SYSTEM-PROMPT-TRIMMED>";
                        } else if (request.options?.agentName === "Orchestrator" && msg.role === "user") {
                            // Parse JSON content for orchestrator to make logs more readable
                            try {
                                const parsed = JSON.parse(msg.content);
                                content = parsed; // Store as object, not string
                            } catch {
                                // Not JSON or parsing failed, keep as-is
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
            };

            // Add response data if successful
            if (result.response) {
                // Try to parse response content as JSON if possible
                let responseContent: any = result.response.content;
                if (result.response.content) {
                    try {
                        const parsed = JSON.parse(result.response.content);
                        responseContent = parsed; // Store as object, not string
                    } catch {
                        // Not JSON or parsing failed, keep as-is
                    }
                }
                
                logEntry.response = {
                    content: responseContent,
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
                              cost: undefined, // Cost calculation would need to be implemented based on model pricing
                          }
                        : undefined,
                };
            }

            // Add error data if failed
            if (result.error) {
                logEntry.error = {
                    message: result.error.message,
                    stack: result.error.stack,
                    type: result.error.constructor.name,
                };
            }

            // Write to JSONL file
            const logLine = `${JSON.stringify(logEntry)}\n`;
            const logFilePath = this.getLogFilePath(request.options?.agentName);

            await fs.appendFile(logFilePath, logLine, "utf-8");
        } catch (logError) {
            // Don't let logging errors break the main flow
            console.error("[LLM Logger] Failed to log LLM call:", logError);
        }
    }
}

// Singleton instance
let globalLogger: LLMCallLogger | null = null;

export function initializeLLMLogger(projectPath: string): LLMCallLogger {
    globalLogger = new LLMCallLogger(projectPath);
    return globalLogger;
}

export function getLLMLogger(): LLMCallLogger | null {
    return globalLogger;
}

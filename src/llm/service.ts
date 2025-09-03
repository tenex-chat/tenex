import type { LLMLogger } from "@/logging/LLMLogger";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import {
    type StreamTextOnStepFinishCallback,
    type LanguageModelUsage,
    type LanguageModel,
    type StepResult,
    type TextStreamPart,
    generateText,
    stepCountIs,
    streamText,
} from "ai";
import type { ModelMessage } from "ai";
import { EventEmitter } from "tseep";

// Define the event types for LLMService
interface LLMServiceEvents {
    content: (data: { delta: string }) => void;
    "tool-will-execute": (data: { toolName: string; toolCallId: string; args: unknown }) => void;
    "tool-did-execute": (data: {
        toolName: string;
        toolCallId: string;
        result: unknown;
        error?: boolean;
    }) => void;
    complete: (data: {
        message: string;
        steps: StepResult<Record<string, AISdkTool>>[];
    }) => void;
    "stream-error": (data: { error: unknown }) => void;
    // Add index signatures for EventEmitter compatibility
    [key: string]: (...args: any[]) => void;
    [key: symbol]: (...args: any[]) => void;
}

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
export class LLMService extends EventEmitter<LLMServiceEvents> {
    private readonly provider: string;
    private readonly model: string;
    private readonly temperature?: number;
    private readonly maxTokens?: number;

    constructor(
        private readonly llmLogger: LLMLogger,
        private readonly registry: any,
        provider: string,
        model: string,
        temperature?: number,
        maxTokens?: number
    ) {
        super();
        this.provider = provider;
        this.model = model;
        this.temperature = temperature;
        this.maxTokens = maxTokens;

        logger.debug("[LLMService] Initialized", {
            provider: this.provider,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
        });
    }

    /**
     * Get a language model from the registry.
     * This method encapsulates the AI SDK's requirement for concatenated strings.
     */
    private getLanguageModel(): LanguageModel {
        // AI SDK requires this format - we encapsulate it here
        return this.registry.languageModel(`${this.provider}:${this.model}`);
    }

    async complete(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            temperature?: number;
            maxTokens?: number;
        }
    ): Promise<unknown> {
        const model = this.getLanguageModel();
        const startTime = Date.now();

        // Log the request
        this.llmLogger
            .logLLMRequest({
                provider: this.provider,
                model: this.model,
                messages,
                tools: Object.keys(tools).map((name) => ({ name })),
                startTime,
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log request", { error: err });
            });

        try {
            const result = await generateText({
                model,
                messages,
                tools,
                temperature: options?.temperature ?? this.temperature,
                maxOutputTokens: options?.maxTokens ?? this.maxTokens,
            });

            const duration = Date.now() - startTime;

            // Log the response
            this.llmLogger
                .logLLMResponse({
                    response: {
                        content: result.text,
                        usage: result.usage,
                    },
                    endTime: Date.now(),
                    startTime,
                })
                .catch((err) => {
                    logger.error("[LLMService] Failed to log response", { error: err });
                });

            logger.info("[LLMService] Complete response received", {
                model: `${this.provider}:${this.model}`,
                duration,
                usage: result.usage,
                toolCallCount: result.toolCalls?.length || 0,
                responseLength: result.text?.length || 0,
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            this.llmLogger
                .logLLMResponse({
                    error: error as Error,
                    endTime: Date.now(),
                    startTime,
                })
                .catch((err) => {
                    logger.error("[LLMService] Failed to log error", { error: err });
                });

            logger.error("[LLMService] Complete failed", {
                model: `${this.provider}:${this.model}`,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async stream(messages: ModelMessage[], tools: Record<string, AISdkTool>): Promise<void> {
        const model = this.getLanguageModel();

        // Create message preview for logging
        const messagesPreview = messages.map((msg) => {
            const content = typeof msg.content === "string" ? msg.content : "[complex content]";
            const preview = content.length > 500 ? `${content.substring(0, 500)}...` : content;
            return preview;
        });

        // Log the request
        this.llmLogger
            .logLLMRequest({
                provider: this.provider,
                model: this.model,
                messages,
                tools: Object.keys(tools).map((name) => ({ name })),
                startTime: Date.now(),
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log request", { error: err });
            });

        logger.info("[LLMService] Calling stream", {
            model: `${this.provider}:${this.model}`,
            messageCount: messages.length,
            toolCount: Object.keys(tools).length,
            toolNames: Object.keys(tools).join(", "),
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            messagesPreview,
        });

        const startTime = Date.now();

        // Create the stream outside the promise
        const { textStream } = streamText({
            model,
            messages,
            tools: tools,
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen: stepCountIs(20),
            onStepFinish: this.handleStepFinish.bind(this),
            onChunk: this.handleChunk.bind(this),
            onFinish: this.createFinishHandler(startTime),
        });

        // Consume the stream (this is what triggers everything!)
        try {
            logger.info("[LLMService] Stream started", {
                model: this.model,
            });

            // CRITICAL: This loop is what actually triggers the stream execution
            for await (const textPart of textStream) {
                // process.stdout.write(textPart);
            }
        } catch (error) {
            await this.handleStreamError(error, startTime);
            throw error;
        }
    }

    private handleStepFinish(step: StreamTextOnStepFinishCallback<Record<string, AISdkTool>>): void {
        console.log("onStepFinish");
    }

    private handleChunk(event: { chunk: TextStreamPart<Record<string, AISdkTool>> }): void {
        const chunk = event.chunk;
        if (chunk.type !== 'text-delta') console.log("LLMService chunk", chunk);

        switch (chunk.type) {
            case "text-delta":
                if (chunk.text) {
                    this.handleTextDelta(chunk.text);
                }
                break;
            case "tool-call":
                this.handleToolCall(chunk.toolCallId, chunk.toolName, chunk.input);
                break;
            case "tool-result":
                this.handleToolResult(chunk.toolCallId, chunk.toolName, chunk.output);
                break;
        }
    }

    private createFinishHandler(startTime: number) {
        return async (
            e: StepResult<Record<string, AISdkTool>> & {
                steps: StepResult<Record<string, AISdkTool>>[];
                totalUsage: LanguageModelUsage;
            }
        ) => {
            const duration = Date.now() - startTime;

            try {
                await this.llmLogger.logLLMResponse({
                    response: {
                        content: e.text,
                        usage: e.totalUsage,
                    },
                    endTime: Date.now(),
                    startTime,
                });

                logger.info("[LLMService] Stream finished", {
                    duration,
                    model: this.model,
                    startTime,
                });

                this.emit("complete", {
                    message: e.text || "",
                    steps: e.steps,
                });
            } catch (error) {
                logger.error("[LLMService] Error in onFinish handler", {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        };
    }

    private async handleStreamError(error: unknown, startTime: number): Promise<void> {
        console.log("error", error);
        const duration = Date.now() - startTime;

        await this.llmLogger
            .logLLMResponse({
                error: error as Error,
                endTime: Date.now(),
                startTime,
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log error response", { error: err });
            });

        logger.error("[LLMService] Stream failed", {
            model: `${this.provider}:${this.model}`,
            duration,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    private handleTextDelta(text: string): void {
        this.emit("content", { delta: text });
    }

    private handleToolCall(toolCallId: string, toolName: string, args: unknown): void {
        this.emit("tool-will-execute", {
            toolName,
            toolCallId,
            args,
        });
    }

    private handleToolResult(toolCallId: string, toolName: string, result: unknown): void {
        this.emit("tool-did-execute", {
            toolName,
            toolCallId,
            result,
        });
    }
}

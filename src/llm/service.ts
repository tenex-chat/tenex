import type { LLMLogger } from "@/logging/LLMLogger";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { compileMessagesForClaudeCode, convertSystemMessagesForResume } from "./utils/claudeCodePromptCompiler";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import {
    type LanguageModelUsage,
    type LanguageModel,
    type StepResult,
    type TextStreamPart,
    type ProviderRegistry,
    generateText,
    stepCountIs,
    streamText,
    wrapLanguageModel,
    extractReasoningMiddleware,
} from "ai";
import type { ModelMessage } from "ai";
import { EventEmitter } from "tseep";
import type { LanguageModelUsageWithCostUsd } from "./types";

// Define the event types for LLMService
interface LLMServiceEvents {
    content: (data: { delta: string }) => void;
    "chunk-type-change": (data: { from: string | undefined; to: string }) => void;
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
        usage: LanguageModelUsageWithCostUsd;
        finishReason?: string;
    }) => void;
    "stream-error": (data: { error: unknown }) => void;
    "session-captured": (data: { sessionId: string }) => void;
    reasoning?: (data: { delta: string }) => void;
    // Add index signatures for EventEmitter compatibility
    [key: string]: (...args: any[]) => void;
    [key: symbol]: (...args: any[]) => void;
}

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
export class LLMService extends EventEmitter<LLMServiceEvents> {
    public readonly provider: string;
    public readonly model: string;
    private readonly temperature?: number;
    private readonly maxTokens?: number;
    private previousChunkType?: string;
    private readonly claudeCodeProviderFunction?: (model: string, options?: ClaudeCodeSettings) => LanguageModel; // Claude Code provider function
    private readonly sessionId?: string; // Session ID for resuming claude_code conversations
    private readonly agentSlug?: string; // Agent identifier for logging

    constructor(
        private readonly llmLogger: LLMLogger,
        private readonly registry: ProviderRegistry | null, // Null for Claude Code
        provider: string,
        model: string,
        temperature?: number,
        maxTokens?: number,
        claudeCodeProviderFunction?: (model: string, options?: ClaudeCodeSettings) => LanguageModel, // Claude Code provider function
        sessionId?: string, // Session ID for resuming claude_code conversations
        agentSlug?: string // Agent identifier for logging
    ) {
        super();
        this.provider = provider;
        this.model = model;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.claudeCodeProviderFunction = claudeCodeProviderFunction;
        this.sessionId = sessionId;
        this.agentSlug = agentSlug;

        // Validate that we have either a registry or Claude Code provider
        if (!registry && !claudeCodeProviderFunction) {
            throw new Error("LLMService requires either a registry or Claude Code provider function");
        }

        logger.debug("[LLMService] 🆕 INITIALIZED", {
            provider: this.provider,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            isClaudeCode: provider === 'claudeCode',
            sessionId: this.sessionId || 'NONE',
            hasSessionId: !!this.sessionId,
        });
    }

    /**
     * Get a language model instance.
     * For Claude Code: Creates model with system prompt from messages.
     * For standard providers: Gets model from registry.
     * Wraps all models with extract-reasoning-middleware.
     */
    private getLanguageModel(messages?: ModelMessage[]): LanguageModel {
        let baseModel: LanguageModel;

        if (this.claudeCodeProviderFunction) {
            // Claude Code provider
            const options: ClaudeCodeSettings = {};

            if (this.sessionId) {
                // When resuming, only pass the resume option
                options.resume = this.sessionId;
                logger.info("[LLMService] 🔄 RESUMING CLAUDE CODE SESSION", {
                    sessionId: this.sessionId,
                    model: this.model,
                    optionsKeys: Object.keys(options)
                });
            } else if (messages) {
                // When NOT resuming, compile all messages
                const { customSystemPrompt, appendSystemPrompt } = compileMessagesForClaudeCode(messages);

                options.customSystemPrompt = customSystemPrompt;
                if (appendSystemPrompt) {
                    options.appendSystemPrompt = appendSystemPrompt;
                }

                logger.info("[LLMService] 🆕 NEW CLAUDE CODE SESSION (no resume)", {
                    model: this.model,
                    hasCustomPrompt: !!customSystemPrompt,
                    hasAppendPrompt: !!appendSystemPrompt,
                    appendPromptLength: appendSystemPrompt?.length || 0,
                    optionsKeys: Object.keys(options)
                });
            }

            baseModel = this.claudeCodeProviderFunction(this.model, options);

            logger.info("[LLMService] 🎯 CREATED CLAUDE CODE MODEL", {
                model: this.model,
                hasCustomSystemPrompt: !!options.customSystemPrompt,
                hasAppendSystemPrompt: !!options.appendSystemPrompt,
                resumeSessionId: options.resume || 'NONE',
                hasResume: 'resume' in options
            });
        } else if (this.registry) {
            // Standard providers use registry
            baseModel = this.registry.languageModel(`${this.provider}:${this.model}`);
        } else {
            throw new Error("No provider available for model creation");
        }

        // Wrap with extract-reasoning-middleware to handle thinking tags
        return wrapLanguageModel({
            model: baseModel,
            middleware: extractReasoningMiddleware({
                tagName: 'thinking',
                separator: '\n',
                startWithReasoning: false,
            }),
        });
    }

    /**
     * Add provider-specific cache control to messages.
     * Only Anthropic requires explicit cache control; OpenAI and Gemini cache automatically.
     */
    private addCacheControl(messages: ModelMessage[]): ModelMessage[] {
        // Only add cache control for Anthropic
        if (this.provider !== 'anthropic') {
            return messages;
        }

        // Rough estimate: 4 characters per token (configurable if needed)
        const CHARS_PER_TOKEN_ESTIMATE = 4;
        const MIN_TOKENS_FOR_CACHE = 1024;
        const minCharsForCache = MIN_TOKENS_FOR_CACHE * CHARS_PER_TOKEN_ESTIMATE;

        return messages.map((msg) => {
            // Only cache system messages and only if they're large enough
            if (msg.role === 'system' && msg.content.length > minCharsForCache) {
                return {
                    ...msg,
                    providerOptions: {
                        anthropic: {
                            cacheControl: { type: 'ephemeral' }
                        }
                    }
                };
            }
            return msg;
        });
    }

    async complete(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            temperature?: number;
            maxTokens?: number;
        }
    ): Promise<unknown> {
        const model = this.getLanguageModel(messages);
        const startTime = Date.now();

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === 'claudeCode' && this.sessionId) {
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

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
                messages: processedMessages,
                tools,
                temperature: options?.temperature ?? this.temperature,
                maxOutputTokens: options?.maxTokens ?? this.maxTokens,
            });
            
            // Capture session ID from provider metadata if using Claude Code
            if (this.provider === 'claudeCode' && result.providerMetadata?.['claude-code']?.sessionId) {
                const capturedSessionId = result.providerMetadata['claude-code'].sessionId;
                logger.info("[LLMService] Captured Claude Code session ID from complete", {
                    sessionId: capturedSessionId,
                    provider: this.provider
                });
                // Emit session ID for storage by the executor
                this.emit('session-captured', { sessionId: capturedSessionId });
            }
            
            // Log if reasoning was extracted
            if ('reasoning' in result && result.reasoning) {
                logger.debug("[LLMService] Reasoning extracted from response", {
                    reasoningLength: result.reasoning.length,
                    textLength: result.text?.length || 0,
                });
            }

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

    async stream(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            abortSignal?: AbortSignal;
        }
    ): Promise<void> {
        const model = this.getLanguageModel(messages);

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === 'claudeCode' && this.sessionId) {
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

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

        const startTime = Date.now();

        // Create the stream outside the promise
        const { textStream } = streamText({
            model,
            messages: processedMessages,
            tools: tools,
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen: stepCountIs(50),
            abortSignal: options?.abortSignal,
            providerOptions: {
                openrouter: {
                    usage: { include: true },
                },
            },

            // Check for delegation completion and inject follow-up hint
            prepareStep: async (options) => {
                const lastStep = options.steps[options.steps.length - 1];
                const lastToolCall = lastStep?.toolCalls?.[0];

                // Check if last tool was a delegation
                const delegationTools = [
                    "delegate",
                    "delegate_phase",
                    "delegate_external",
                    "delegate_followup",
                ];
                if (lastToolCall && delegationTools.includes(lastToolCall.toolName)) {
                    const lastResult = lastStep?.toolResults?.[0];

                    // Check if we got responses
                    if (lastResult?.responses?.length > 0) {
                        // Add assistant message about follow-up capability
                        return {
                            messages: [
                                {
                                    role: "assistant",
                                    content: `I've received the delegation response. If I need any clarification or have follow-up questions, I can use delegate_followup to continue the conversation with the responding agent.`,
                                },
                            ],
                        };
                    }
                }
            },

            onChunk: this.handleChunk.bind(this),
            onFinish: this.createFinishHandler(startTime),
        });

        // Consume the stream (this is what triggers everything!)
        try {
            // CRITICAL: This loop is what actually triggers the stream execution
            for await (const _chunk of textStream) {
                // Consume the stream to trigger execution
            }
        } catch (error) {
            await this.handleStreamError(error, startTime);
            throw error;
        }
    }

    private handleChunk(event: { chunk: TextStreamPart<Record<string, AISdkTool>> }): void {
        const chunk = event.chunk;

        // Emit chunk-type-change event if the type changed
        if (this.previousChunkType !== undefined && this.previousChunkType !== chunk.type) {
            this.emit("chunk-type-change", {
                from: this.previousChunkType,
                to: chunk.type
            });
        }

        switch (chunk.type) {
            case "text-delta":
                // AI SDK uses 'delta' for text-delta chunks, not 'text'
                if ('delta' in chunk && chunk.delta) {
                    this.handleTextDelta(chunk.delta);
                } else if ('text' in chunk && chunk.text) {
                    // Fallback for compatibility
                    this.handleTextDelta(chunk.text);
                }
                break;
            case "reasoning-delta":
                // Handle reasoning-delta separately - emit reasoning event
                if ('text' in chunk && chunk.text) {
                    this.handleReasoningDelta(chunk.text);
                }
                break;
            case "tool-call":
                this.handleToolCall(chunk.toolCallId, chunk.toolName, chunk.input);
                break;
            case "tool-result":
                this.handleToolResult(chunk.toolCallId, chunk.toolName, chunk.output);
                break;
            case "tool-input-start":
                // Tool input is starting to stream - we can log but don't need to process
                logger.debug("[LLMService] Tool input starting", {
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName
                });
                break;
            case "tool-input-delta":
                // Tool input is being incrementally streamed - can be used for real-time display
                logger.debug("[LLMService] Tool input delta", {
                    toolCallId: chunk.toolCallId,
                    text: chunk.text
                });
                break;
            case "tool-input-available":
                // Full tool input is now available - could be useful for logging
                logger.debug("[LLMService] Tool input available", {
                    toolCallId: chunk.toolCallId
                });
                break;
            case "reasoning-start":
                logger.debug("[LLMService] Reasoning started", {
                    id: chunk.id
                });
                break;
            case "reasoning-end":
                logger.debug("[LLMService] Reasoning ended", {
                    id: chunk.id
                });
                break;
            case "error":
                logger.error("[LLMService] Error chunk received", {
                    error: chunk.error
                });
                break;
            default:
                // Log unknown chunk types for debugging
                logger.debug("[LLMService] Unknown chunk type", {
                    type: chunk.type,
                    chunk
                });
        }

        // Update previous chunk type
        this.previousChunkType = chunk.type;
    }

    private createFinishHandler(startTime: number) {
        return async (
            e: StepResult<Record<string, AISdkTool>> & {
                steps: StepResult<Record<string, AISdkTool>>[];
                totalUsage: LanguageModelUsage;
                providerMetadata: Record<string, any>;
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

                // Capture session ID from provider metadata if using Claude Code
                logger.info("[LLMService] 🔍 CHECKING FOR CLAUDE CODE SESSION IN METADATA", {
                    provider: this.provider,
                    isClaudeCode: this.provider === 'claudeCode',
                    hasProviderMetadata: !!e.providerMetadata,
                    providerMetadataKeys: e.providerMetadata ? Object.keys(e.providerMetadata) : [],
                    claudeCodeMetadata: e.providerMetadata?.['claude-code']
                });

                if (this.provider === 'claudeCode' && e.providerMetadata?.['claude-code']?.sessionId) {
                    const capturedSessionId = e.providerMetadata['claude-code'].sessionId;
                    logger.info("[LLMService] 🎉 CAPTURED CLAUDE CODE SESSION ID FROM STREAM", {
                        capturedSessionId,
                        previousSessionId: this.sessionId || 'NONE',
                        provider: this.provider,
                        sessionChanged: capturedSessionId !== this.sessionId
                    });
                    // Emit session ID for storage by the executor
                    this.emit('session-captured', { sessionId: capturedSessionId });
                } else if (this.provider === 'claudeCode') {
                    logger.warn("[LLMService] ⚠️ NO CLAUDE CODE SESSION IN METADATA", {
                        providerMetadata: e.providerMetadata
                    });
                }
                
                logger.info("[LLMService] Stream finished", {
                    duration,
                    model: this.model,
                    startTime,
                    finishReason: e.finishReason,
                    agentSlug: this.agentSlug,
                });

                this.emit("complete", {
                    message: e.text || "",
                    steps: e.steps,
                    usage: {
                        costUsd: e.providerMetadata?.openrouter?.usage?.cost,
                        ...(e.totalUsage || {}),
                    },
                    finishReason: e.finishReason,
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

    private handleReasoningDelta(text: string): void {
        this.emit("reasoning", { delta: text });
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

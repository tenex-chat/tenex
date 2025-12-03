import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { LLMService } from "@/llm/service";
import { LLMLogger } from "@/logging/LLMLogger";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { createProviderRegistry } from "ai";
import type { ModelMessage } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { z } from "zod";

export enum ClaudeCodeMode {
    WRITE = "WRITE",
    PLAN = "PLAN",
    READ = "READ",
}

const claudeCodeSchema = z.object({
    prompt: z.string().min(1).describe("The prompt for Claude Code to execute"),
    title: z.string().describe("Title for the task"),
    mode: z
        .enum([ClaudeCodeMode.WRITE, ClaudeCodeMode.PLAN, ClaudeCodeMode.READ])
        .describe(
            "Execution mode: WRITE for making changes, PLAN for planning tasks, READ for research/analysis only"
        ),
});

type ClaudeCodeInput = z.infer<typeof claudeCodeSchema>;
type ClaudeCodeOutput = {
    sessionId?: string;
    totalCost: number;
    messageCount: number;
    duration: number;
    response: string;
};

type Todo = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
};

type TodoWriteResult = {
    todos: Todo[];
};

function isTodoWriteResult(result: unknown): result is TodoWriteResult {
    if (typeof result !== "object" || result === null) {
        return false;
    }

    if (!("todos" in result)) {
        return false;
    }

    const candidate = result as Record<string, unknown>;

    if (!Array.isArray(candidate.todos)) {
        return false;
    }

    return candidate.todos.every(
        (todo) =>
            todo &&
            typeof todo === "object" &&
            "content" in todo &&
            typeof todo.content === "string" &&
            "status" in todo &&
            (todo.status === "pending" ||
                todo.status === "in_progress" ||
                todo.status === "completed")
    );
}

/**
 * AI SDK-based implementation using LLMService
 * Leverages existing streaming infrastructure instead of reimplementing
 */
async function executeClaudeCode(
    input: ClaudeCodeInput,
    context: ExecutionContext
): Promise<ClaudeCodeOutput> {
    const { prompt, title, mode } = input;
    const startTime = Date.now();

    if (!context.agentPublisher) {
        throw new Error("AgentPublisher not available in execution context");
    }

    // Store agentPublisher in a local variable so TypeScript knows it's defined
    const agentPublisher = context.agentPublisher;

    logger.debug("[claude_code] Starting execution with LLMService", {
        prompt: prompt.substring(0, 100),
        mode,
        agent: context.agent.name,
    });

    try {
        // Create metadata store for this agent/conversation
        const metadataStore = context.agent.createMetadataStore(context.conversationId);

        // Get existing session from metadata
        const existingSessionId = metadataStore.get<string>("sessionId");

        // Get conversation for other purposes
        const conversation = context.getConversation();

        // Create event context for Nostr publishing
        const rootEvent = conversation?.history[0] ?? context.triggeringEvent;
        const baseEventContext: EventContext = {
            triggeringEvent: context.triggeringEvent,
            rootEvent: rootEvent,
            conversationId: context.conversationId,
            model: context.agent.llmConfig, // Include LLM configuration
        };

        // Create task through AgentPublisher
        const task = await agentPublisher.createTask(
            title,
            prompt,
            baseEventContext,
            existingSessionId // Only pass if we have a real session ID
        );

        logger.info("[claude_code] Created task", {
            taskId: task.id,
            sessionId: existingSessionId,
            title,
        });

        // Register operation with LLM Operations Registry
        const abortSignal = llmOpsRegistry.registerOperation(context);

        // Start execution timing
        if (conversation) {
            startExecutionTime(conversation);
        }

        // Track execution state
        let lastAssistantMessage = "";
        let planResult: string | null = null;
        const totalCost = 0;
        let messageCount = 0;
        let capturedSessionId: string | undefined;

        // Determine which tools to allow based on mode
        let allowedTools: string[] | undefined;
        let disallowedTools: string[] | undefined;

        switch (mode) {
            case ClaudeCodeMode.READ:
                // Read-only mode - no write operations allowed
                disallowedTools = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Delete"];
                break;
            case ClaudeCodeMode.PLAN:
                // Planning mode - focus on reading and todo management
                allowedTools = ["Read", "LS", "Grep", "Glob", "TodoWrite", "ExitPlanMode"];
                break;
            case ClaudeCodeMode.WRITE:
                // Write mode - full access to all tools (default behavior)
                // Don't restrict any tools
                break;
        }

        // Create provider registry with Claude Code
        const registry = createProviderRegistry({
            "claude-code": {
                languageModel: (modelId: string) => {
                    const options: ClaudeCodeSettings = {
                        cwd: context.workingDirectory,
                        permissionMode: "bypassPermissions",
                        // Resume existing session if we have one
                        resume: existingSessionId,
                    };

                    // Add tool restrictions based on mode
                    if (allowedTools) {
                        options.allowedTools = allowedTools;
                    } else if (disallowedTools) {
                        options.disallowedTools = disallowedTools;
                    }

                    return claudeCode(modelId, options);
                },
                textEmbeddingModel: () => {
                    throw new Error("Claude Code does not support embedding models");
                },
                imageModel: () => {
                    throw new Error("Claude Code does not support image models");
                },
            },
        });

        // Create LLMLogger instance
        const llmLogger = new LLMLogger();

        // Create LLMService with Claude Code provider
        const llmService = new LLMService(
            llmLogger,
            registry,
            "claude-code",
            "opus",
            undefined, // temperature
            undefined // maxTokens
        );

        // Set up event handlers for Nostr publishing
        llmService.on("content", async ({ delta }: { delta: string }) => {
            logger.info("[claude_code] content", { delta });
            lastAssistantMessage += delta;
            messageCount++;

            // Publish text update to Nostr
            await agentPublisher.publishTaskUpdate(task, delta, baseEventContext);
        });

        llmService.on("tool-did-execute", async ({ toolName, result }: { toolName: string; result: unknown }) => {
            logger.info("[claude_code] Tool executed", { toolName, result });

            if (toolName === "TodoWrite" && isTodoWriteResult(result)) {
                const todoLines = result.todos.map((todo) => {
                    let checkbox = "- [ ]";
                    if (todo.status === "in_progress") {
                        checkbox = "- ➡️";
                    } else if (todo.status === "completed") {
                        checkbox = "- ✅";
                    }
                    const text =
                        todo.status === "in_progress" && todo.activeForm
                            ? todo.activeForm
                            : todo.content;
                    return `${checkbox} ${text}`;
                });

                await agentPublisher.publishTaskUpdate(
                    task,
                    todoLines.join("\n"),
                    baseEventContext
                );
            } else if (toolName === "ExitPlanMode" && mode === ClaudeCodeMode.PLAN) {
                // Capture plan result and abort
                planResult = (result as { plan?: string })?.plan || "Plan completed";
                logger.info("[claude_code] ExitPlanMode detected", {
                    plan: planResult.substring(0, 100),
                });
                await agentPublisher.publishTaskUpdate(
                    task,
                    "Plan complete",
                    baseEventContext,
                    "complete"
                );
                // Abort the stream since we have the plan
                // Note: We can't directly abort from here, but the stream will complete naturally
                logger.info("[claude_code] Plan completed, stream will finish", {});
            }
        });

        llmService.on("complete", ({ message, steps, usage }: { message: string; steps: any[]; usage: unknown }) => {
            // Try to extract session ID from the last step's provider metadata
            const lastStep = steps[steps.length - 1];

            if (lastStep?.providerMetadata?.["claude-code"]?.sessionId) {
                capturedSessionId = lastStep.providerMetadata["claude-code"].sessionId;
            }

            logger.info("[claude_code] Stream completed", {
                messageLength: message.length,
                stepCount: steps.length,
                taskId: task.id,
                capturedSessionId,
                usage,
            });

            agentPublisher.publishTaskUpdate(
                task,
                "Task complete",
                baseEventContext,
                "complete"
            );
        });

        // Build messages
        const messages: ModelMessage[] = [];
        messages.push({
            role: "user",
            content: prompt,
        });

        try {
            // Execute stream with LLMService, passing abort signal from registry
            // Claude Code provider handles its own tools internally based on mode
            await llmService.stream(
                messages,
                {},
                {
                    abortSignal,
                }
            );

            // Stop execution timing
            if (conversation) {
                stopExecutionTime(conversation);
            }
        } finally {
            // Complete the operation (handles both success and abort cases)
            llmOpsRegistry.completeOperation(context);
        }

        try {
            // Only use real session IDs from Claude Code provider
            const sessionId = capturedSessionId || existingSessionId;

            // Store session ID for future resumption
            if (sessionId) {
                metadataStore.set("sessionId", sessionId);
            }

            // Return appropriate response
            const finalResponse =
                planResult || lastAssistantMessage || "Task completed successfully";
            const duration = Date.now() - startTime;

            logger.info("[claude_code] Execution completed", {
                sessionId,
                totalCost,
                messageCount,
                finalResponse,
                duration,
                mode,
                hasPlanResult: !!planResult,
            });

            return {
                sessionId,
                totalCost,
                messageCount,
                duration,
                response: finalResponse,
            };
        } catch (streamError) {
            // Stop timing on error
            if (conversation) {
                stopExecutionTime(conversation);
            }

            const errorMessage = formatAnyError(streamError);
            const isAborted =
                errorMessage.includes("aborted") || errorMessage.includes("interrupted");

            // Publish error update
            await agentPublisher.publishTaskUpdate(
                task,
                `❌ Task ${isAborted ? "interrupted" : "failed"}\n\nError: ${errorMessage}`,
                baseEventContext
            );

            logger.error("[claude_code] Stream execution failed", {
                error: errorMessage,
                isAborted,
            });

            throw new Error(`Claude Code execution failed: ${errorMessage}`);
        }
    } catch (error) {
        logger.error("[claude_code] Tool failed", { error });
        throw new Error(`Claude Code execution failed: ${formatAnyError(error)}`);
    }
}

/**
 * Create an AI SDK tool for Claude Code execution using LLMService
 */
export function createClaudeCodeTool(context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "Execute Claude Code to perform planning or to execute changes. Claude Code has full access to read, write, and execute code in the project. This tool maintains session continuity for iterative development. Usage warning: claude_code is a powerful, intelligent tool; don't micromanage its work, don't try to direct how it should implement things unless explicitly asked to do so. Rely on claude_code's intelligence and only provide corrections where necessary.",
        inputSchema: claudeCodeSchema,
        execute: async (input: ClaudeCodeInput) => {
            try {
                return await executeClaudeCode(input, context);
            } catch (error) {
                logger.error("[claude_code] Tool execution failed", { error });
                throw new Error(
                    `Claude Code failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    }) as AISdkTool;
}

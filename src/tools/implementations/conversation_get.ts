import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import { getPubkeyService } from "@/services/PubkeyService";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationGetSchema = z.object({
    conversationId: z
        .string()
        .optional()
        .describe(
            "The conversation ID to retrieve. If omitted, returns the current conversation."
        ),
    prompt: z
        .string()
        .optional()
        .describe(
            "Optional prompt to analyze the conversation. When provided, the conversation will be processed through an LLM which will provide an explanation based on this prompt. Useful for extracting specific information or getting a summary of the conversation."
        ),
    includeToolResults: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "Whether to include tool result content in the response. WARNING: This can significantly increase token usage (up to 50k tokens). Tool results are truncated at 10k chars each with a 50k total budget. Only enable if you specifically need to analyze tool outputs."
        ),
});

type ConversationGetInput = z.infer<typeof conversationGetSchema>;

interface ConversationGetOutput {
    success: boolean;
    conversation?: Record<string, unknown>;
    explanation?: string;
    message?: string;
}

/**
 * Recursively deep copy an object while handling cycles, BigInts, Maps, Sets, and other edge cases
 */
function safeDeepCopy(obj: unknown, seen = new WeakSet()): unknown {
    // Handle primitives and special values
    if (obj === null || typeof obj !== "object") {
        if (typeof obj === "bigint") return obj.toString();
        if (typeof obj === "function") return undefined;
        return obj;
    }

    // Cycle detection
    if (seen.has(obj)) {
        return "[Circular]";
    }
    seen.add(obj);

    // Handle Arrays
    if (Array.isArray(obj)) {
        return obj.map(item => safeDeepCopy(item, seen));
    }

    // Handle Maps
    if (obj instanceof Map) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of obj) {
            result[String(key)] = safeDeepCopy(value, seen);
        }
        return result;
    }

    // Handle Sets
    if (obj instanceof Set) {
        return Array.from(obj).map(item => safeDeepCopy(item, seen));
    }

    // Handle Dates
    if (obj instanceof Date) {
        return obj.toISOString();
    }

    // Handle plain Objects
    const result: Record<string, unknown> = {};
    for (const key in obj) {
        // Only process own properties
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            try {
                result[key] = safeDeepCopy((obj as Record<string, unknown>)[key], seen);
            } catch {
                result[key] = "[Access Error]";
            }
        }
    }
    return result;
}

/**
 * Safely copy data while handling circular references, BigInts, Maps, Sets, and other edge cases
 * Uses recursive deep copy with cycle detection instead of JSON.stringify
 */
function safeCopy<T>(data: T): T {
    try {
        return safeDeepCopy(data) as T;
    } catch {
        // Fallback to string representation if even deep copy fails
        return "[Serialization Failed]" as unknown as T;
    }
}

/**
 * Serialize a Conversation object to a JSON-safe plain object
 * Explicitly constructs result field-by-field to avoid copying cyclic properties
 * that may be runtime-attached to the conversation object.
 * Uses safeCopy for nested objects and strict primitive enforcement for fields
 * that should always be primitives (preventing accidental circular object serialization).
 */
function serializeConversation(
    conversation: ConversationStore,
    options: { includeToolResults?: boolean } = {}
): Record<string, unknown> {
    const messages = conversation.getAllMessages();
    const pubkeyService = getPubkeyService();

    const MAX_TOOL_RESULT_LENGTH = 10000;
    const TOTAL_TOOL_RESULTS_BUDGET = 50000;
    let toolResultsBudgetRemaining = TOTAL_TOOL_RESULTS_BUDGET;

    return {
        // Strictly enforce primitive types for top-level fields
        id: String(conversation.id),
        title: conversation.title ? String(conversation.title) : undefined,
        metadata: conversation.metadata ? safeCopy(conversation.metadata) : {},
        executionTime: safeCopy(conversation.executionTime),
        messageCount: messages.length,
        messages: messages
            .filter(entry => {
                // Skip tool results entirely unless explicitly requested
                if (entry.messageType === "tool-result" && !options.includeToolResults) {
                    return false;
                }
                return true;
            })
            .map(entry => {
                // Derive role for display based on messageType and context
                let role: string;
                if (entry.messageType === "tool-call") {
                    role = "assistant";
                } else if (entry.messageType === "tool-result") {
                    role = "tool";
                } else {
                    // Text message - use "assistant" for agent messages, "user" for others
                    role = entry.ral !== undefined ? "assistant" : "user";
                }

                // Get content based on message type
                let content: string;
                if (entry.messageType === "text") {
                    content = entry.content;
                } else if (entry.messageType === "tool-result") {
                    // Tool results with budget management
                    if (toolResultsBudgetRemaining <= 0) {
                        const fullContent = JSON.stringify(entry.toolData ?? []);
                        content = `[budget exhausted, ${fullContent.length} chars omitted]`;
                    } else {
                        const fullContent = JSON.stringify(entry.toolData ?? []);
                        const maxLength = Math.min(MAX_TOOL_RESULT_LENGTH, toolResultsBudgetRemaining);
                        if (fullContent.length > maxLength) {
                            const truncatedChars = fullContent.length - maxLength;
                            content = `${fullContent.slice(0, maxLength)}... [truncated ${truncatedChars} chars]`;
                            toolResultsBudgetRemaining -= maxLength;
                        } else {
                            content = fullContent;
                            toolResultsBudgetRemaining -= fullContent.length;
                        }
                    }
                } else {
                    // tool-call messages - truncate at 1.5k
                    const MAX_TOOL_CALL_LENGTH = 1500;
                    const fullContent = JSON.stringify(entry.toolData ?? []);
                    if (fullContent.length > MAX_TOOL_CALL_LENGTH) {
                        const truncatedChars = fullContent.length - MAX_TOOL_CALL_LENGTH;
                        content = `${fullContent.slice(0, MAX_TOOL_CALL_LENGTH)}... [truncated ${truncatedChars} chars]`;
                    } else {
                        content = fullContent;
                    }
                }

                // Convert pubkeys to human-readable names/slugs
                const from = pubkeyService.getNameSync(entry.pubkey);
                const targetedAgents = entry.targetedPubkeys?.map(pk => pubkeyService.getNameSync(pk));

                return {
                    role,
                    content,
                    messageType: entry.messageType,
                    from,
                    eventId: entry.eventId,
                    timestamp: entry.timestamp,
                    targetedAgents,
                };
            })
    };
}

/**
 * Core implementation of conversation retrieval functionality
 */
async function executeConversationGet(
    input: ConversationGetInput,
    context: ToolExecutionContext
): Promise<ConversationGetOutput> {
    const targetConversationId = input.conversationId || context.conversationId;

    logger.info("📖 Retrieving conversation", {
        conversationId: targetConversationId,
        isCurrentConversation: targetConversationId === context.conversationId,
        agent: context.agent.name,
    });

    // Get conversation from ConversationStore
    const conversation =
        targetConversationId === context.conversationId
            ? context.getConversation()
            : ConversationStore.get(targetConversationId);

    if (!conversation) {
        logger.info("📭 Conversation not found", {
            conversationId: targetConversationId,
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `Conversation ${targetConversationId} not found`,
        };
    }

    logger.info("✅ Conversation retrieved successfully", {
        conversationId: conversation.id,
        title: conversation.title,
        messageCount: conversation.getMessageCount(),
        agent: context.agent.name,
    });

    const serializedConversation = serializeConversation(conversation, {
        includeToolResults: input.includeToolResults,
    });

    // If a prompt is provided, process the conversation through the LLM
    if (input.prompt) {
        try {
            // Get LLM configuration - use summarization config if set, otherwise default
            const { llms } = await config.loadConfig();
            const configName = llms.summarization || llms.default;
            const llmConfig = configName ? llms.configurations[configName] : undefined;

            if (!llmConfig) {
                logger.warn("No LLM configuration available for conversation analysis");
                return {
                    success: true,
                    conversation: serializedConversation,
                    message: "No LLM configuration available for prompt processing",
                };
            }

            // Create LLM service
            const llmService = llmServiceFactory.createService(llmConfig, {
                agentName: "conversation-analyzer",
                sessionId: `analyzer-${targetConversationId}`,
            });

            // Format conversation for LLM processing
            const conversationText = JSON.stringify(serializedConversation, null, 2);

            // Generate explanation using the LLM
            const { object: result } = await llmService.generateObject(
                [
                    {
                        role: "system",
                        content: `You are a helpful assistant that analyzes conversations and provides explanations based on user prompts.

CRITICAL REQUIREMENTS:
1. VERBATIM QUOTES: You MUST include relevant parts of the conversation verbatim in your response. Quote the exact messages that support your analysis.
2. PRESERVE IDENTIFIERS: All IDs, pubkeys, agent slugs, conversation IDs, event IDs, and other addressable data must be preserved exactly as they appear.
3. When referencing specific messages or participants, include their identifiers exactly as they appear.
4. Do not abbreviate or modify any identifiers - they are essential for traceability and reference.
5. Base your analysis ONLY on what is explicitly stated in the conversation.

FORMAT: Structure your response with:
- Your analysis/explanation
- Verbatim quotes from relevant messages (use quotation marks and attribute to the sender)
- All referenced identifiers preserved exactly

The user will provide a prompt describing what they want to know about the conversation.`,
                    },
                    {
                        role: "user",
                        content: `Please analyze the following conversation based on this prompt: "${input.prompt}"

IMPORTANT: Include verbatim quotes from the relevant parts of the conversation that support your analysis.

CONVERSATION DATA:
${conversationText}`,
                    },
                ],
                z.object({
                    explanation: z
                        .string()
                        .describe(
                            "A detailed explanation based on the user's prompt. MUST include verbatim quotes from relevant messages and preserve all important identifiers."
                        ),
                })
            );

            logger.info("✅ Conversation analyzed with prompt", {
                conversationId: conversation.id,
                promptLength: input.prompt.length,
                agent: context.agent.name,
            });

            return {
                success: true,
                conversation: serializedConversation,
                explanation: result.explanation,
            };
        } catch (error) {
            logger.error("Failed to process conversation with prompt", {
                conversationId: conversation.id,
                error: error instanceof Error ? error.message : String(error),
                agent: context.agent.name,
            });

            return {
                success: true,
                conversation: serializedConversation,
                message: `Failed to process prompt: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    return {
        success: true,
        conversation: serializedConversation,
    };
}

/**
 * Create an AI SDK tool for retrieving conversations
 */
export function createConversationGetTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Retrieve a conversation by its ID, including all messages/events in the conversation history. Returns conversation metadata, execution state, and full message history. If conversationId is omitted, returns the current conversation. Useful for reviewing conversation context, analyzing message history, or accessing conversation metadata like summary, requirements, and plan.",

        inputSchema: conversationGetSchema,

        execute: async (input: ConversationGetInput) => {
            return await executeConversationGet(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ conversationId, prompt }: ConversationGetInput) => {
            const target = conversationId
                ? `conversation: ${conversationId}`
                : "current conversation";
            return prompt
                ? `Analyzing ${target} with prompt`
                : `Retrieving ${target}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

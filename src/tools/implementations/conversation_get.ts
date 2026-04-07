import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { renderConversationXml } from "@/conversations/formatters/utils/conversation-transcript-formatter";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { isHexPrefix, resolvePrefixToId } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import { z } from "zod";

/**
 * Normalizes stored conversation/message IDs for lookup.
 *
 * Behavior:
 * - Full 64-character hex IDs are canonicalized to lowercase
 * - 10-character hex prefixes are resolved via PrefixKVStore when possible
 * - Arbitrary transport-native IDs are preserved as-is
 * - Legacy `nostr:` prefixes are stripped only when the remainder matches a hex ID/prefix
 *
 * @param input - The stored conversation/message ID in any supported format
 * @returns The normalized lookup ID, or null if the input is blank
 */
function normalizeStoredId(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }

    const candidates = trimmed.startsWith("nostr:")
        ? [trimmed.slice(6), trimmed]
        : [trimmed];

    for (const candidate of candidates) {
        if (/^[0-9a-f]{64}$/i.test(candidate)) {
            return candidate.toLowerCase();
        }

        if (isHexPrefix(candidate)) {
            return resolvePrefixToId(candidate) ?? candidate;
        }
    }

    return trimmed;
}

function idsMatch(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
        return false;
    }

    const normalizedLeft = normalizeStoredId(left);
    const normalizedRight = normalizeStoredId(right);
    return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

const conversationGetSchema = z.object({
    conversationId: z
        .string()
        .min(1, "conversationId is required")
        .describe(
            "The stored conversation ID to retrieve. Pass the exact ID returned by conversation_list or shown in prompt context. For legacy 64-char hex Nostr-backed conversation IDs, 10-character hex prefixes are also resolved when indexed."
        ),
    untilId: z
        .string()
        .optional()
        .describe(
            "Optional stored message ID to retrieve the conversation slice up to and including that message. Pass the exact message/event ID from the transcript. For legacy 64-char hex Nostr-backed message IDs, 10-character hex prefixes are also resolved when indexed."
        ),
    prompt: z
        .string()
        .optional()
        .describe(
            "Optional prompt to analyze the conversation. When provided, the conversation will be processed through an LLM which will provide an explanation based on this prompt. Useful for extracting specific information or getting a summary of the conversation."
        ),
    includeToolCalls: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "Whether to include tool-call events in the XML transcript. Tool-result entries are intentionally omitted; tool-call attributes are summarized/truncated by the shared transcript formatter."
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
 * Formats messages as XML with relative timestamps and root t0.
 */
function serializeConversation(
    conversation: ConversationStore,
    options: { includeToolCalls?: boolean; untilId?: string } = {}
): Record<string, unknown> {
    let messages = conversation.getAllMessages();

    // Filter messages up to and including untilId if provided
    if (options.untilId) {
        const untilIndex = messages.findIndex(msg => msg.eventId === options.untilId);
        if (untilIndex === -1) {
            // Message not found - return all messages as graceful fallback
            logger.warn("untilId not found in conversation, returning all messages", {
                untilId: options.untilId,
                conversationId: conversation.id,
            });
        } else {
            // Include messages up to and including the untilId message
            messages = messages.slice(0, untilIndex + 1);
        }
    }

    const includeToolCalls = options.includeToolCalls ?? false;
    const { xml } = renderConversationXml(messages, {
        conversationId: String(conversation.id),
        includeToolCalls,
    });

    return {
        id: String(conversation.id),
        title: conversation.title ? String(conversation.title) : undefined,
        executionTime: safeCopy(conversation.executionTime),
        messageCount: messages.length,
        messages: xml,
    };
}

/**
 * Core implementation of conversation retrieval functionality
 */
async function executeConversationGet(
    input: ConversationGetInput,
    context: ToolExecutionContext
): Promise<ConversationGetOutput> {
    if (!input.conversationId.trim()) {
        return {
            success: false,
            message: "conversationId is required",
        };
    }

    const targetConversationId = normalizeStoredId(input.conversationId);
    if (!targetConversationId) {
        return {
            success: false,
            message: "conversationId is required",
        };
    }

    let targetUntilId: string | undefined = undefined;
    if (input.untilId) {
        const normalized = normalizeStoredId(input.untilId);
        targetUntilId = normalized ?? undefined;
        if (!normalized) {
            logger.warn("Could not resolve untilId, proceeding without filtering", {
                untilId: input.untilId,
                conversationId: targetConversationId,
                agent: context.agent.name,
            });
            targetUntilId = undefined;
        }
    }

    logger.info("📖 Retrieving conversation", {
        conversationId: targetConversationId,
        isCurrentConversation: idsMatch(targetConversationId, context.conversationId),
        agent: context.agent.name,
    });

    // Allow custom runtimes/tests to resolve arbitrary conversation IDs through context.
    const resolveFromContext = context.getConversation as unknown as (
        conversationId?: string
    ) => ConversationStore | undefined;
    const contextConversationCandidate = resolveFromContext(targetConversationId);
    const contextConversation =
        contextConversationCandidate &&
        idsMatch(String(contextConversationCandidate.id), targetConversationId)
            ? contextConversationCandidate
            : undefined;

    // Get conversation from ConversationStore
    const conversation =
        contextConversation ??
        (idsMatch(targetConversationId, context.conversationId)
            ? context.getConversation()
            : ConversationStore.get(targetConversationId));

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
        untilId: targetUntilId,
        agent: context.agent.name,
    });

    const serializedConversation = serializeConversation(conversation, {
        includeToolCalls: input.includeToolCalls,
        untilId: targetUntilId,
    });

    // If a prompt is provided, process the conversation through the LLM
    if (input.prompt) {
        try {
            // Get LLM configuration - use summarization config if set, otherwise default
            // Use getLLMConfig to resolve meta models automatically
            const { llms } = await config.loadConfig();
            const configName = llms.summarization || llms.default;

            if (!configName) {
                logger.warn("No LLM configuration available for conversation analysis");
                return {
                    success: true,
                    conversation: serializedConversation,
                    message: "No LLM configuration available for prompt processing",
                };
            }

            const llmConfig = config.getLLMConfig(configName);

            // Create LLM service
            const llmService = llmServiceFactory.createService(llmConfig, {
                agentName: "conversation-analyzer",
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
            "Retrieve a conversation by its stored ID, including all messages/events in the conversation history. Pass the exact ID returned by conversation_list or shown in prompt context. Returns conversation info (id, title, messageCount, executionTime) and an XML transcript string. XML includes absolute t0 on the root and per-entry relative time indicators via time=\"+seconds\", plus author/recipient attribution and short event ids.",

        inputSchema: conversationGetSchema,

        execute: async (input: ConversationGetInput) => {
            return await executeConversationGet(input, context);
        },
    });

    return aiTool as AISdkTool;
}

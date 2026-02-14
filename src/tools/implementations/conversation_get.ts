import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import { getPubkeyService } from "@/services/PubkeyService";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { isHexPrefix, resolvePrefixToId, PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import type { ToolCallPart, ToolResultPart } from "ai";
import { z } from "zod";
import { nip19 } from "nostr-tools";

/**
 * Normalizes various event ID formats to a canonical 64-char lowercase hex ID.
 *
 * Accepts:
 * - Full 64-character hex IDs
 * - 12-character hex prefixes (resolved via PrefixKVStore)
 * - NIP-19 formats: note1..., nevent1...
 * - nostr: prefixed versions of all the above
 *
 * @param input - The event ID in any supported format
 * @returns The normalized 64-char hex ID, or null if resolution fails
 */
function normalizeEventId(input: string): string | null {
    const trimmed = input.trim();

    // Strip nostr: prefix if present
    const cleaned = trimmed.startsWith("nostr:") ? trimmed.slice(6) : trimmed;

    // 1. Check for full 64-char hex ID
    if (/^[0-9a-f]{64}$/i.test(cleaned)) {
        return cleaned.toLowerCase();
    }

    // 2. Check for 12-char hex prefix - resolve via PrefixKVStore
    if (isHexPrefix(cleaned)) {
        const resolved = resolvePrefixToId(cleaned);
        return resolved; // Returns null if not found
    }

    // 3. Try NIP-19 decoding (note1..., nevent1...)
    try {
        const decoded = nip19.decode(cleaned);
        if (decoded.type === "note") {
            return (decoded.data as string).toLowerCase();
        }
        if (decoded.type === "nevent") {
            return (decoded.data as { id: string }).id.toLowerCase();
        }
    } catch {
        // Not a valid NIP-19 format, fall through
    }

    // Invalid format or resolution failed
    return null;
}

const conversationGetSchema = z.object({
    conversationId: z
        .string()
        .min(1, "conversationId is required")
        .describe("The conversation ID to retrieve. Accepts full 64-char hex IDs (case-insensitive), 12-character hex prefixes, NIP-19 formats (note1..., nevent1...), or nostr: prefixed versions of any format."),
    untilId: z
        .string()
        .optional()
        .describe(
            "Optional message ID to retrieve conversation slice up to and including this message. Accepts full 64-char hex IDs (case-insensitive), 12-character hex prefixes, NIP-19 formats (note1..., nevent1...), or nostr: prefixed versions of any format. Useful for synthetic conversation forks where a new conversation references a parent conversation up to a specific message point."
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
 * Safely stringify a value, handling BigInt, circular refs, and other edge cases
 * Returns a JSON string representation or "[Unserializable]" on failure
 */
function safeStringify(value: unknown): string {
    if (value === undefined) return "";
    if (value === null) return "null";
    try {
        return JSON.stringify(value);
    } catch {
        // Handle BigInt, circular references, or other unserializable values
        return '"[Unserializable]"';
    }
}

const MAX_PARAM_LENGTH = 100;

/**
 * Format tool input parameters with per-param truncation
 * Each param value is truncated at MAX_PARAM_LENGTH chars
 * Format: param1="value1" param2="value2..." (N chars truncated)
 */
function formatToolInput(input: unknown): string {
    if (input === undefined || input === null) return "";

    // If input is not an object, just stringify and truncate the whole thing
    if (typeof input !== "object" || Array.isArray(input)) {
        const str = safeStringify(input);
        if (str.length > MAX_PARAM_LENGTH) {
            const truncated = str.length - MAX_PARAM_LENGTH;
            return `${str.slice(0, MAX_PARAM_LENGTH)}... (${truncated} chars truncated)`;
        }
        return str;
    }

    // For objects, format each param with truncation
    const parts: string[] = [];
    const obj = input as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
        let valueStr: string;
        try {
            valueStr = JSON.stringify(value);
        } catch {
            valueStr = '"[Unserializable]"';
        }

        if (valueStr.length > MAX_PARAM_LENGTH) {
            const truncated = valueStr.length - MAX_PARAM_LENGTH;
            parts.push(`${key}=${valueStr.slice(0, MAX_PARAM_LENGTH)}... (${truncated} chars truncated)`);
        } else {
            parts.push(`${key}=${valueStr}`);
        }
    }

    return parts.join(" ");
}

const MAX_LINE_LENGTH = 1500;

/**
 * Format a single line with timestamp, sender, target(s), and content
 * Truncates the full line INCLUDING suffix to maxLength chars
 */
function formatLine(
    relativeSeconds: number,
    from: string,
    targets: string[] | undefined,
    content: string,
    maxLength: number = MAX_LINE_LENGTH
): string {
    // Build target string: no target = "", single = "-> @to", multiple = "-> @to1, @to2"
    let targetStr = "";
    if (targets && targets.length > 0) {
        targetStr = ` -> ${targets.map(t => `@${t}`).join(", ")}`;
    }

    // Escape newlines to preserve single-line format
    const escapedContent = content.replace(/\n/g, "\\n");

    const line = `[+${relativeSeconds}] [@${from}${targetStr}] ${escapedContent}`;

    if (line.length > maxLength) {
        // Calculate suffix first, then determine how much content to keep
        // We want: kept_content + suffix <= maxLength
        const truncatedChars = line.length - maxLength;
        const suffix = `... [truncated ${truncatedChars} chars]`;
        const keepLength = Math.max(0, maxLength - suffix.length);
        return line.slice(0, keepLength) + suffix;
    }
    return line;
}

/**
 * Serialize a Conversation object to a JSON-safe plain object
 * Formats messages as a single multi-line string with relative timestamps
 * Format: [+seconds] [@from -> @to] content
 */
function serializeConversation(
    conversation: ConversationStore,
    options: { includeToolResults?: boolean; untilId?: string } = {}
): Record<string, unknown> {
    let messages = conversation.getAllMessages();
    const pubkeyService = getPubkeyService();

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

    // Find the first DEFINED timestamp to use as baseline for relative times.
    // This handles edge cases where early messages (e.g., tool-calls synced via
    // MessageSyncer) may lack timestamps. Using the first defined timestamp
    // ensures later messages don't show huge epoch offsets.
    let baselineTimestamp = 0;
    for (const msg of messages) {
        if (msg.timestamp !== undefined) {
            baselineTimestamp = msg.timestamp;
            break;
        }
    }

    const formattedLines: string[] = [];

    // Track the last known timestamp for fallback on entries without timestamps.
    // This provides more accurate ordering than always falling back to baseline.
    let lastKnownTimestamp = baselineTimestamp;

    for (let i = 0; i < messages.length; i++) {
        const entry = messages[i];
        // Use lastKnownTimestamp as fallback when entry.timestamp is undefined.
        // This ensures entries without timestamps (e.g., tool-calls synced via MessageSyncer)
        // appear at their approximate position rather than showing [+0] or huge negative
        // numbers like [+-1771103685].
        const effectiveTimestamp = entry.timestamp ?? lastKnownTimestamp;
        const relativeSeconds = Math.floor(effectiveTimestamp - baselineTimestamp);

        // Update lastKnownTimestamp if this entry has a defined timestamp
        if (entry.timestamp !== undefined) {
            lastKnownTimestamp = entry.timestamp;
        }
        const from = pubkeyService.getNameSync(entry.pubkey);
        const targets = entry.targetedPubkeys?.map(pk => pubkeyService.getNameSync(pk));

        if (entry.messageType === "text") {
            // Text messages: straightforward format
            formattedLines.push(formatLine(relativeSeconds, from, targets, entry.content));
        } else if (entry.messageType === "tool-call") {
            // Only include tool calls if includeToolResults is true
            if (!options.includeToolResults) {
                // Skip tool call entries when not including tool results
                continue;
            }

            // Tool call: look for matching tool-results by toolCallId or adjacency
            const toolData = (entry.toolData ?? []) as ToolCallPart[];

            // Check if we have toolCallIds to match with
            const hasToolCallIds = toolData.some(tc => tc.toolCallId);

            // Build a map of toolCallId -> result for matching (when IDs are present)
            const toolResultsMap = new Map<string, ToolResultPart>();
            // Also keep an ordered array for fallback adjacency matching
            let adjacentResults: ToolResultPart[] = [];
            let shouldSkipNext = false;

            if (i + 1 < messages.length) {
                const nextMsg = messages[i + 1];
                if (nextMsg.messageType === "tool-result" && nextMsg.pubkey === entry.pubkey) {
                    const resultData = (nextMsg.toolData ?? []) as ToolResultPart[];
                    adjacentResults = resultData;

                    // Build toolCallId map for ID-based matching
                    for (const tr of resultData) {
                        if (tr.toolCallId) {
                            toolResultsMap.set(tr.toolCallId, tr);
                        }
                    }
                }
            }

            // Format tool calls with their matched results
            const toolCallParts: string[] = [];
            const matchedResultIds = new Set<string>();
            let adjacentResultIndex = 0;

            for (const tc of toolData) {
                const toolName = tc.toolName || "unknown";
                const input = tc.input !== undefined ? formatToolInput(tc.input) : "";
                let toolCallStr = `[tool-use ${toolName} ${input}]`;

                let matchingResult: ToolResultPart | undefined;

                // Try to find matching result by toolCallId first
                if (tc.toolCallId && toolResultsMap.has(tc.toolCallId)) {
                    matchingResult = toolResultsMap.get(tc.toolCallId);
                    matchedResultIds.add(tc.toolCallId);
                } else if (!hasToolCallIds && adjacentResultIndex < adjacentResults.length) {
                    // Fallback: when no toolCallIds, match by position (adjacency)
                    matchingResult = adjacentResults[adjacentResultIndex++];
                }

                if (matchingResult) {
                    const resultContent =
                        matchingResult.output !== undefined
                            ? safeStringify(matchingResult.output)
                            : "";
                    toolCallStr += ` [tool-result ${resultContent}]`;
                    shouldSkipNext = true;
                }
                toolCallParts.push(toolCallStr);
            }

            // Skip the next tool-result message if we merged all results
            if (shouldSkipNext && i + 1 < messages.length) {
                const nextMsg = messages[i + 1];
                if (nextMsg.messageType === "tool-result" && nextMsg.pubkey === entry.pubkey) {
                    // For ID-based matching, verify all were matched
                    // For adjacency-based, we already processed them all
                    if (!hasToolCallIds || adjacentResults.every(tr => !tr.toolCallId || matchedResultIds.has(tr.toolCallId))) {
                        i++;
                    }
                }
            }

            const content = toolCallParts.join(" ");
            formattedLines.push(formatLine(relativeSeconds, from, targets, content));
        } else if (entry.messageType === "tool-result") {
            // Standalone tool-result (not merged with tool-call)
            // Only show if includeToolResults is true
            if (options.includeToolResults) {
                const resultData = (entry.toolData ?? []) as ToolResultPart[];
                const resultParts: string[] = [];
                for (const tr of resultData) {
                    const resultContent =
                        tr.output !== undefined ? safeStringify(tr.output) : "";
                    resultParts.push(`[tool-result ${resultContent}]`);
                }
                formattedLines.push(formatLine(relativeSeconds, from, targets, resultParts.join(" ")));
            }
        } else if (entry.messageType === "delegation-marker") {
            // Delegation markers: always shown (regardless of includeToolResults)
            const marker = entry.delegationMarker;

            // Validate required fields - skip gracefully if missing
            if (!marker?.delegationConversationId || !marker?.recipientPubkey || !marker?.status) {
                // Skip malformed delegation marker - don't crash, just omit from output
                continue;
            }

            const shortConversationId = marker.delegationConversationId.slice(0, PREFIX_LENGTH);
            const recipientName = pubkeyService.getNameSync(marker.recipientPubkey);

            // Format: ✅/⚠️ Delegation <shortId> → <recipient> completed/aborted
            const emoji = marker.status === "completed" ? "✅" : "⚠️";
            const statusText = marker.status === "completed" ? "completed" : "aborted";
            const content = `${emoji} Delegation ${shortConversationId} → ${recipientName} ${statusText}`;

            formattedLines.push(formatLine(relativeSeconds, from, targets, content));
        }
    }

    return {
        id: String(conversation.id),
        title: conversation.title ? String(conversation.title) : undefined,
        executionTime: safeCopy(conversation.executionTime),
        messageCount: messages.length,
        messages: formattedLines.join("\n"),
    };
}

/**
 * Core implementation of conversation retrieval functionality
 */
async function executeConversationGet(
    input: ConversationGetInput,
    context: ToolExecutionContext
): Promise<ConversationGetOutput> {
    if (!input.conversationId) {
        return {
            success: false,
            message: "conversationId is required",
        };
    }

    // Normalize conversation ID to full 64-char hex
    const targetConversationId = normalizeEventId(input.conversationId);
    if (!targetConversationId) {
        return {
            success: false,
            message: `Could not resolve conversation ID "${input.conversationId}". Expected 64-char hex, 12-char hex prefix, or NIP-19 format (note1.../nevent1...).`,
        };
    }

    // Normalize untilId if provided - graceful fallback for optional parameter
    let targetUntilId: string | undefined = undefined;
    if (input.untilId) {
        const resolved = normalizeEventId(input.untilId);
        targetUntilId = resolved ?? undefined;
        if (!resolved) {
            logger.warn("Could not resolve untilId, proceeding without filtering", {
                untilId: input.untilId,
                conversationId: targetConversationId,
                agent: context.agent.name,
            });
            // Fall back to undefined - return unfiltered conversation
            targetUntilId = undefined;
        }
    }

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
        untilId: targetUntilId,
        agent: context.agent.name,
    });

    const serializedConversation = serializeConversation(conversation, {
        includeToolResults: input.includeToolResults,
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
            "Retrieve a conversation by its ID, including all messages/events in the conversation history. Returns conversation info (id, title, messageCount, executionTime) and a formatted messages string. Messages are formatted as: [+seconds] [@from -> @to] content, where seconds is relative to the first message. Tool calls and results can be merged into single lines when includeToolResults is true. Useful for reviewing conversation context, analyzing message history, or debugging agent interactions.",

        inputSchema: conversationGetSchema,

        execute: async (input: ConversationGetInput) => {
            return await executeConversationGet(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ conversationId, untilId, prompt }: ConversationGetInput) => {
            const target = conversationId
                ? `conversation: ${conversationId}`
                : "conversation (missing id)";
            const upTo = untilId ? ` up to message ${untilId}` : "";
            return prompt
                ? `Analyzing ${target}${upTo} with prompt`
                : `Retrieving ${target}${upTo}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

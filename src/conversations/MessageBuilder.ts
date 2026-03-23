/**
 * Message builder for converting ConversationStore entries to LLM messages.
 *
 * This module handles the complex logic of building ModelMessages from
 * ConversationRecordInput records, including:
 * - Tool call/result ordering for AI SDK validation
 * - Orphaned tool call reconciliation
 * - Message deference during pending tool execution
 * - Delegation completion pruning
 * - Message attribution for unexpected senders
 */
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import { trace } from "@opentelemetry/api";
import { buildConversationRecordId } from "./record-id";
import { getConversationRecordAuthorPubkey } from "./record-author";
import type { ConversationRecord, DelegationMarker } from "./types";
import { renderConversationXml } from "@/conversations/formatters/utils/conversation-transcript-formatter";
import { getIdentityService } from "@/services/identity";
import { convertToMultimodalContent, hasImageUrls } from "./utils/multimodal-content";
import {
    createImageTracker,
    processToolResultWithImageTracking,
    type ImageTracker,
} from "./utils/image-placeholder";
import { extractImageUrls } from "./utils/image-url-utils";

export type AddressableModelMessage = ModelMessage & {
    id: string;
    sourceRecordId?: string;
    eventId?: string;
};

type ImageReplacementStats = {
    replacedCount: number;
    uniqueReplacedCount: number;
};

interface EntryMessageBuildResult {
    message: ModelMessage;
    imageReplacementStats?: ImageReplacementStats;
}

export interface MessageBuilderContext {
    /**
     * The pubkey of the agent viewing/building messages
     */
    viewingAgentPubkey: string;
    /**
     * The current RAL number for the execution
     */
    ralNumber: number;
    /**
     * Set of currently active RAL numbers for the agent
     */
    activeRals: Set<number>;
    /**
     * Index offset when processing a slice of messages (default 0)
     */
    indexOffset?: number;
    /**
     * Set of pubkeys that belong to agents (non-whitelisted).
     * Used by computeAttributionPrefix to distinguish agent messages from user messages.
     * If not provided, all non-self pubkeys are treated as users (no agent attribution).
     */
    agentPubkeys?: Set<string>;
    /**
     * The conversation ID being built.
     * Required for delegation marker expansion - markers are only expanded
     * if their parentConversationId matches this conversationId (direct children only).
     */
    conversationId?: string;
    /**
     * Callback to get messages from a delegation conversation.
     * Used for lazy expansion of delegation markers.
     * Returns the messages array or undefined if conversation not found.
     */
    getDelegationMessages?: (delegationConversationId: string) => ConversationRecord[] | undefined;
    /**
     * Include stable ids on emitted messages for explicit context preprocessing.
     */
    includeMessageIds?: boolean;
    /**
     * Tool call IDs that are currently in-flight (executing but not yet completed).
     * These will still get synthetic results inserted for valid message structure,
     * but won't trigger orphaned_tool_calls_reconciled telemetry since they're expected.
     */
    inFlightToolCallIds?: Set<string>;
}

function buildEntryMessageId(entry: ConversationRecord, absoluteIndex: number): string {
    return entry.id || buildConversationRecordId(entry, absoluteIndex);
}

function withMessageIdentity(
    message: ModelMessage,
    entry: ConversationRecord,
    absoluteIndex: number,
    includeMessageIds: boolean
): ModelMessage {
    if (!includeMessageIds) {
        return message;
    }

    return {
        ...(message as object),
        id: buildEntryMessageId(entry, absoluteIndex),
        sourceRecordId: entry.id,
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
    } as AddressableModelMessage;
}

function createSyntheticMessageWithId(
    message: ModelMessage,
    id: string,
    includeMessageIds: boolean
): ModelMessage {
    if (!includeMessageIds) {
        return message;
    }

    return {
        ...(message as object),
        id,
    } as AddressableModelMessage;
}

/**
 * Derive the appropriate role for a message based on viewer perspective.
 *
 * Rules:
 * - Explicit role override: If entry.role is set (for synthetic entries like compressed summaries), use it
 * - assistant: Only for the viewing agent's own messages
 * - user: All other messages (regardless of targeting), including compressed summaries
 * - tool: Tool results (fixed)
 *
 * Note: Attribution context is not added to LLM input. Role simply distinguishes
 * between the agent's own messages and messages from others.
 */
function deriveRole(
    entry: ConversationRecord,
    viewingAgentPubkey: string
): "user" | "assistant" | "tool" | "system" {
    // Explicit role override for synthetic entries (e.g., compressed summaries)
    // CRITICAL: Without this, compressed summaries with pubkey="system" would become "user" role,
    // turning compressed history into user instructions and causing catastrophic LLM behavior.
    if (entry.role) {
        return entry.role;
    }

    // Tool messages have fixed roles
    if (entry.messageType === "tool-call") return "assistant";
    if (entry.messageType === "tool-result") return "tool";

    // Text messages - assistant for own, user for everything else
    const senderPubkey = getConversationRecordAuthorPubkey(entry);
    if (senderPubkey === viewingAgentPubkey) {
        return "assistant"; // Own messages
    }

    return "user"; // All non-self messages
}

/**
 * Resolve a display name through IdentityService, falling back to its sync path.
 * This keeps all name formatting centralized in the identity layer.
 */
async function resolveDisplayName(pubkey: string): Promise<string> {
    const identityService = getIdentityService();
    try {
        return await identityService.getName(pubkey);
    } catch {
        return identityService.getNameSync(pubkey);
    }
}

function resolveDisplayNameSyncForEntry(
    entry: ConversationRecord,
    resolveDisplayName?: (pubkey: string) => string
): string {
    const senderPubkey = getConversationRecordAuthorPubkey(entry);

    if (resolveDisplayName && senderPubkey) {
        return resolveDisplayName(senderPubkey);
    }

    return getIdentityService().getDisplayNameSync({
        principalId: entry.senderPrincipal?.id,
        linkedPubkey: senderPubkey,
        displayName: entry.senderPrincipal?.displayName,
        username: entry.senderPrincipal?.username,
        kind: entry.senderPrincipal?.kind,
    });
}

function resolveRecipientDisplayNameSync(
    entry: ConversationRecord,
    index: number,
    resolveDisplayName?: (pubkey: string) => string
): string {
    const recipientSnapshot = entry.targetedPrincipals?.[index];
    const recipientPubkey = entry.targetedPubkeys?.[index];

    if (resolveDisplayName && recipientPubkey) {
        return resolveDisplayName(recipientPubkey);
    }

    return getIdentityService().getDisplayNameSync({
        principalId: recipientSnapshot?.id,
        linkedPubkey: recipientSnapshot?.linkedPubkey ?? recipientPubkey,
        displayName: recipientSnapshot?.displayName,
        username: recipientSnapshot?.username,
        kind: recipientSnapshot?.kind,
    });
}

/**
 * Compute an attribution prefix for a conversation entry.
 *
 * Returns a string prefix (or empty string) to prepend to the message content,
 * enabling the LLM to distinguish who said what in multi-agent shared conversations.
 *
 * Priority rules (ordered, first match wins):
 * 1. Self message → "" (no prefix)
 * 2. Non-text entry (tool-call, tool-result, delegation-marker, role-override) → "" (no prefix)
 * 3. Has targetedPubkeys NOT including viewing agent → "[@sender -> @recipient] " (routing)
 * 4. Sender is agent (in agentPubkeys set) → "[@sender] " (attribution)
 * 5. Otherwise (user message targeted to me, or no targeting) → "" (no prefix)
 *
 * **Purity note:** This function is pure when a custom `resolveDisplayName` is provided
 * (as done in unit tests). The default resolver calls `IdentityService.getNameSync()`,
 * which reads from a global service singleton. That is intentional for production use
 * but means the default invocation is not referentially transparent.
 *
 * @param entry - The conversation entry to compute prefix for
 * @param viewingAgentPubkey - The pubkey of the agent viewing/building messages
 * @param agentPubkeys - Set of pubkeys that belong to agents (used to distinguish agents from users)
 * @param resolveDisplayName - Optional injectable name resolver (defaults to IdentityService.getNameSync)
 * @returns The prefix string to prepend, or empty string for no prefix
 */
export function computeAttributionPrefix(
    entry: ConversationRecord,
    viewingAgentPubkey: string,
    agentPubkeys: Set<string>,
    resolveDisplayName?: (pubkey: string) => string,
    multipleHumanSenders: boolean = false
): string {
    // Determine the actual sender (injected messages track original sender via senderPubkey)
    const senderPubkey = getConversationRecordAuthorPubkey(entry);

    // Rule 1: Self message → no prefix
    if (senderPubkey === viewingAgentPubkey) return "";

    // Rule 2: Non-text entry → no prefix
    if (entry.messageType !== "text") return "";
    if (entry.role) return ""; // Explicit role override (synthetic entries like compressed summaries)

    // Rule 3: Has targetedPubkeys NOT including viewing agent → routing prefix
    const targetedPubkeys = entry.targetedPubkeys ?? [];
    if (targetedPubkeys.length > 0 && !targetedPubkeys.includes(viewingAgentPubkey)) {
        const senderName = resolveDisplayNameSyncForEntry(entry, resolveDisplayName);
        const recipientName = resolveRecipientDisplayNameSync(entry, 0, resolveDisplayName);
        return `[@${senderName} -> @${recipientName}] `;
    }

    // Rule 4: Sender is agent → attribution prefix
    if (senderPubkey && agentPubkeys.has(senderPubkey)) {
        const senderName = resolveDisplayNameSyncForEntry(entry, resolveDisplayName);
        return `[@${senderName}] `;
    }

    // Rule 5: Multiple visible human senders → explicit human attribution
    if (multipleHumanSenders && entry.senderPrincipal?.kind === "human") {
        const senderName = resolveDisplayNameSyncForEntry(entry, resolveDisplayName);
        return `[@${senderName}] `;
    }

    // Rule 6: Otherwise (user message targeted to me, or no targeting) → no prefix
    return "";
}

function hasMultipleHumanSenders(
    entries: ConversationRecord[],
    viewingAgentPubkey: string,
    agentPubkeys: Set<string>
): boolean {
    const humanSenderIds = new Set<string>();

    for (const entry of entries) {
        if (entry.messageType !== "text" || entry.role || entry.senderPrincipal?.kind !== "human") {
            continue;
        }

        const senderPubkey = getConversationRecordAuthorPubkey(entry);
        if (senderPubkey === viewingAgentPubkey || (senderPubkey && agentPubkeys.has(senderPubkey))) {
            continue;
        }

        humanSenderIds.add(entry.senderPrincipal.id);
        if (humanSenderIds.size > 1) {
            return true;
        }
    }

    return false;
}

/**
 * Convert a ConversationRecordInput to a ModelMessage for the viewing agent.
 *
 * Attribution prefixes are added for multi-agent shared conversations using
 * computeAttributionPrefix() to help the LLM distinguish who said what.
 *
 * For text messages containing image URLs, the content is converted to
 * multimodal format (TextPart + ImagePart array) for AI SDK compatibility.
 *
 * Image Placeholder Strategy:
 * - First appearance of an image: shown in full
 * - Subsequent appearances: replaced with placeholder referencing eventId
 * - The imageTracker tracks which images have been seen
 *
 */
async function entryToMessage(
    entry: ConversationRecord,
    viewingAgentPubkey: string,
    agentPubkeys: Set<string>,
    imageTracker: ImageTracker,
    multipleHumanSenders: boolean,
    enableMultimodal: boolean = true
): Promise<EntryMessageBuildResult> {
    const role = deriveRole(entry, viewingAgentPubkey);

    if (entry.messageType === "tool-call" && entry.toolData) {
        return { message: { role: "assistant", content: entry.toolData as ToolCallPart[] } };
    }

    if (entry.messageType === "tool-result" && entry.toolData) {
        // First: Apply image placeholder strategy (tracks & replaces seen images)
        const imageProcessingResult = processToolResultWithImageTracking(
            entry.toolData as ToolResultPart[],
            imageTracker,
            entry.eventId ?? entry.id
        );
        const toolData = imageProcessingResult.processedParts;

        return {
            message: {
                role: "tool",
                content: toolData,
            },
            imageReplacementStats: imageProcessingResult.replacedCount > 0
                ? { replacedCount: imageProcessingResult.replacedCount, uniqueReplacedCount: imageProcessingResult.uniqueReplacedCount }
                : undefined,
        };
    }

    // Text message - compute attribution prefix for multi-agent conversations
    const prefix = computeAttributionPrefix(
        entry,
        viewingAgentPubkey,
        agentPubkeys,
        undefined,
        multipleHumanSenders
    );
    const messageContent = prefix ? `${prefix}${entry.content}` : entry.content;

    // Track any images in text messages (but don't replace them - user content)
    // This ensures that if the same image appears later in a tool result,
    // it will be replaced with a placeholder
    const imageUrls = extractImageUrls(messageContent);
    for (const url of imageUrls) {
        imageTracker.markAsSeen(url);
    }

    // Convert to multimodal format if content contains image URLs, but ONLY for user messages
    // AND only when enableMultimodal is true (i.e., the most recent user message with images).
    //
    // The AI SDK ModelMessage[] schema only allows ImagePart in user role messages (UserModelMessage).
    // AssistantModelMessage content only supports TextPart, ReasoningPart, ToolCallPart, etc. — no ImagePart.
    // Applying multimodal conversion to assistant messages causes:
    //   AI_InvalidPromptError: Invalid prompt: The messages do not match the ModelMessage[] schema.
    //
    // For older user messages that contained images, we keep the URL as plain text in the string —
    // the LLM has already seen them, no need to re-fetch and waste context window on image tokens.
    const content = (role === "user" && enableMultimodal) ? convertToMultimodalContent(messageContent) : messageContent;

    return { message: { role, content } as ModelMessage };
}

/**
 * Expand a delegation marker into a formatted transcript message.
 *
 * This function formats messages from a delegation conversation into a flat
 * transcript. The transcript includes:
 * - Text messages only (not tool calls/results)
 * - Messages with p-tags (targeted to specific recipients)
 * - No nested delegation markers (flat expansion only)
 *
 * Format: [@sender -> @recipient]: message content
 *
 * @param marker - The delegation marker to expand
 * @param delegationMessages - Messages from the delegation conversation, or undefined if not found
 * @returns Formatted transcript as a ModelMessage
 */
async function expandDelegationMarker(
    marker: DelegationMarker,
    delegationMessages: ConversationRecord[] | undefined
): Promise<ModelMessage> {
    // Handle pending delegations - show that work is in progress
    if (marker.status === "pending") {
        const recipientName = await resolveDisplayName(marker.recipientPubkey);
        return {
            role: "user",
            content: `# DELEGATION IN PROGRESS\n\n@${recipientName} is currently working on this task.`,
        };
    }

    if (!delegationMessages) {
        // Delegation conversation not found - return placeholder
        const recipientName = await resolveDisplayName(marker.recipientPubkey);
        const statusText = marker.status === "aborted"
            ? `was aborted: ${marker.abortReason || "unknown reason"}`
            : "completed (transcript unavailable)";
        return {
            role: "user",
            content: `# DELEGATION ${marker.status.toUpperCase()}\n\n@${recipientName} ${statusText}`,
        };
    }

    // Build flat transcript from delegation conversation
    const lines: string[] = [];

    // Header based on status
    if (marker.status === "aborted") {
        lines.push("# DELEGATION ABORTED");
        lines.push("");
        if (marker.abortReason) {
            lines.push(`**Reason:** ${marker.abortReason}`);
            lines.push("");
        }
    } else {
        lines.push("# DELEGATION COMPLETED");
        lines.push("");
    }

    const { xml: transcriptXml } = renderConversationXml(delegationMessages, {
        conversationId: marker.delegationConversationId,
        includeMessageTypes: ["text"],
        requireTargetedPubkeys: true,
        includeToolCalls: false,
    });

    lines.push("### Transcript:");
    lines.push(transcriptXml);

    return {
        role: "user",
        content: lines.join("\n"),
    };
}

/**
 * Format a nested delegation marker as a minimal reference.
 *
 * For nested delegations (delegations that occurred within another delegation),
 * we don't expand the full transcript to avoid exponential bloat. Instead, we
 * display a minimal marker showing:
 * - The recipient agent
 * - The delegation conversation ID (shortened)
 * - The status (completed/aborted)
 *
 * This provides visibility that a delegation happened without including
 * potentially large transcripts in the parent conversation context.
 *
 * @param marker - The delegation marker to format
 * @returns Minimal reference message as a ModelMessage
 */
async function formatNestedDelegationMarker(
    marker: DelegationMarker
): Promise<ModelMessage> {
    const recipientName = await resolveDisplayName(marker.recipientPubkey);

    const shortConversationId = marker.delegationConversationId.substring(0, 12);

    // Simple one-line format: [Delegation to @recipient (conv: abc123...) - status]
    let statusSuffix: string;
    if (marker.status === "aborted") {
        statusSuffix = ` - aborted${marker.abortReason ? `: ${marker.abortReason}` : ""}`;
    } else if (marker.status === "pending") {
        statusSuffix = " - pending";
    } else {
        statusSuffix = " - completed";
    }

    return {
        role: "user",
        content: `[Delegation to @${recipientName} (conv: ${shortConversationId}...)${statusSuffix}]`,
    };
}

/**
 * Build ModelMessages from conversation entries.
 *
 * This function handles the complex logic of:
 * 1. Filtering messages by RAL visibility rules
 * 2. Ensuring tool-call/tool-result ordering for AI SDK validation
 * 3. Deferring non-tool messages while tool-calls are pending
 * 4. Injecting synthetic results for orphaned tool-calls
 * 5. Pruning superseded delegation completion messages
 *
 * The AI SDK (Vercel AI) validates that every tool-call message is immediately
 * followed by its corresponding tool-result message. This function ensures
 * that validation passes even when messages arrive out of order.
 */
export async function buildMessagesFromEntries(
    entries: ConversationRecord[],
    ctx: MessageBuilderContext
): Promise<ModelMessage[]> {
    const {
        viewingAgentPubkey,
        ralNumber,
        activeRals,
        indexOffset = 0,
        agentPubkeys = new Set<string>(),
        includeMessageIds = false,
        inFlightToolCallIds,
    } = ctx;

    const result: ModelMessage[] = [];
    const delegationCompletionPrefix = "# DELEGATION COMPLETED";

    // Image placeholder strategy: Track seen images across all messages
    // First appearance = full image, subsequent = placeholder
    const imageTracker = createImageTracker();
    const imageReplacementStatsByMessage = new Map<ModelMessage, ImageReplacementStats>();

    // Track latest delegation completion for each RAL (to prune superseded ones)
    const latestDelegationCompletionIndexByRal = new Map<number, number>();
    const getDelegationCompletionRal = (entry: ConversationRecord): number | undefined => {
        if (entry.messageType !== "text") return undefined;
        if (typeof entry.ral !== "number") return undefined;
        if (!entry.content.trimStart().startsWith(delegationCompletionPrefix)) return undefined;
        if (!(entry.targetedPubkeys?.includes(viewingAgentPubkey) ?? false)) return undefined;
        return entry.ral;
    };

    // First pass: identify latest delegation completion for each RAL
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const ral = getDelegationCompletionRal(entry);
        if (ral !== undefined) {
            latestDelegationCompletionIndexByRal.set(ral, i);
        }
    }

    // Pre-scan: find the last user text message that contains image URLs.
    // Only that message gets multimodal conversion (ImagePart objects that trigger image fetching).
    // Older user messages with images keep URLs as plain text — the LLM already saw them,
    // no need to re-fetch and consume context window with image tokens.
    let lastUserImageEntryIndex = -1;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.messageType !== "text") continue;
        if (deriveRole(entry, viewingAgentPubkey) !== "user") continue;
        if (hasImageUrls(entry.content)) {
            lastUserImageEntryIndex = i;
        }
    }

    const multipleHumanSenders = hasMultipleHumanSenders(
        entries,
        viewingAgentPubkey,
        agentPubkeys
    );

    const buildEntryMessage = async (
        entry: ConversationRecord,
        absoluteIndex: number,
        enableMultimodal: boolean
    ): Promise<ModelMessage> => {
        const builtMessage = await entryToMessage(
            entry,
            viewingAgentPubkey,
            agentPubkeys,
            imageTracker,
            multipleHumanSenders,
            enableMultimodal
        );
        const message = withMessageIdentity(
            builtMessage.message,
            entry,
            absoluteIndex,
            includeMessageIds
        );
        if (builtMessage.imageReplacementStats) {
            imageReplacementStatsByMessage.set(message, builtMessage.imageReplacementStats);
        }
        return message;
    };

    let prunedDelegationCompletions = 0;

    // ============================================================================
    // TOOL-CALL / TOOL-RESULT ORDERING FIX
    // ============================================================================
    //
    // The AI SDK (Vercel AI) validates that every tool-call message is immediately
    // followed by its corresponding tool-result message. If any other message type
    // (user, assistant text, system) appears between a tool-call and its result,
    // the SDK throws: "Tool result is missing for tool call <id>"
    //
    // PROBLEM 1: User messages arriving mid-tool-execution
    // ----------------------------------------------------
    // Messages are stored in ConversationStore in chronological order:
    //   1. Agent issues tool-call (stored immediately)
    //   2. User sends a new message (stored while tool executes)
    //   3. Tool completes, result stored
    //
    // This results in: [tool-call, user-message, tool-result]
    // But AI SDK requires: [tool-call, tool-result, user-message]
    //
    // PROBLEM 2: Orphaned tool-calls from RAL interruption
    // ----------------------------------------------------
    // When a RAL is aborted mid-execution (e.g., due to a delegation completion
    // triggering an injection), tool-calls may be stored but their results never
    // recorded. The tool continues executing in the background, but the stream
    // handler that would record the result has been torn down.
    //
    // When the RAL resumes, it has orphaned tool-calls with no matching results.
    //
    // SOLUTION:
    // ---------
    // 1. Track pending tool-calls (those without results yet)
    // 2. Defer non-tool messages while tool-calls are pending
    // 3. Flush deferred messages only after all pending results arrive
    // 4. For orphaned tool-calls (no result ever stored), inject synthetic
    //    error results to satisfy the AI SDK validation
    //
    // ============================================================================

    // Map of toolCallId -> {toolName, resultIndex} for pending tool-calls
    // resultIndex tracks where the synthetic result should be inserted if needed
    const pendingToolCalls = new Map<string, { toolName: string; resultIndex: number }>();

    // Messages deferred because they arrived while tool-calls were pending
    const deferredMessages: Array<{
        entry: ConversationRecord;
        enableMultimodal: boolean;
        absoluteIndex: number;
    }> = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        // Skip superseded delegation completions
        const ral = getDelegationCompletionRal(entry);
        if (ral !== undefined) {
            const latestIndex = latestDelegationCompletionIndexByRal.get(ral);
            if (latestIndex !== undefined && latestIndex !== i) {
                prunedDelegationCompletions += 1;
                continue;
            }
        }

        const absoluteIndex = indexOffset + i;

        // Helper to check if entry should be included based on RAL visibility
        const shouldInclude = (): boolean => {
            // User messages (no RAL) - always include
            if (!entry.ral) return true;

            // Same agent
            if (getConversationRecordAuthorPubkey(entry) === viewingAgentPubkey) {
                if (entry.ral === ralNumber) return true; // Current RAL
                if (activeRals.has(entry.ral)) return false; // Other active RAL - skip
                return true; // Completed RAL
            }

            // Other agent's message - only include text content
            return entry.messageType === "text" && !!entry.content;
        };

        if (!shouldInclude()) continue;

        // TOOL-CALL: Add to result and register as pending
        if (entry.messageType === "tool-call" && entry.toolData) {
            const resultIndex = result.length;
            result.push(await buildEntryMessage(entry, absoluteIndex, true));

            for (const part of entry.toolData as ToolCallPart[]) {
                pendingToolCalls.set(part.toolCallId, {
                    toolName: part.toolName,
                    // Result should be inserted right after the tool-call message
                    resultIndex: resultIndex + 1,
                });
            }
            continue;
        }

        // TOOL-RESULT: Add to result and mark tool-call as resolved
        if (entry.messageType === "tool-result" && entry.toolData) {
            const parts = entry.toolData as ToolResultPart[];

            // Skip orphaned tool-results whose tool-calls were removed by context trimming.
            // If the corresponding tool-call is not in pendingToolCalls, sending this result
            // to the LLM would produce an API error (tool_result without matching tool_use).
            if (parts.some((part) => !pendingToolCalls.has(part.toolCallId))) {
                trace.getActiveSpan?.()?.addEvent("conversation.orphaned_tool_result_skipped", {
                    "orphan.tool_call_ids": parts.map((p) => p.toolCallId).join(","),
                });
                continue;
            }

            result.push(await buildEntryMessage(entry, absoluteIndex, true));

            for (const part of parts) {
                pendingToolCalls.delete(part.toolCallId);
            }

            // All tool-calls resolved - flush deferred messages now
            if (pendingToolCalls.size === 0 && deferredMessages.length > 0) {
                for (const deferred of deferredMessages) {
                    result.push(await buildEntryMessage(
                        deferred.entry,
                        deferred.absoluteIndex,
                        deferred.enableMultimodal
                    ));
                }
                deferredMessages.length = 0;
            }
            continue;
        }

        // DELEGATION-MARKER: Expand only if direct child of current conversation
        if (entry.messageType === "delegation-marker" && entry.delegationMarker) {
            const marker = entry.delegationMarker;

            // Guard: conversationId must be present for marker expansion
            // If missing, log a warning and skip - this indicates a bug in the caller
            if (!ctx.conversationId) {
                trace.getActiveSpan?.()?.addEvent("conversation.delegation_marker_skipped", {
                    "delegation.conversation_id": marker.delegationConversationId.substring(0, 12),
                    "delegation.parent_conversation_id": marker.parentConversationId.substring(0, 12),
                    "skip.reason": "missing_conversation_id",
                    "skip.severity": "warning",
                });
                continue;
            }

            // Only expand direct children - skip nested delegations
            // This prevents exponential transcript bloat
            if (marker.parentConversationId === ctx.conversationId) {
                // Get delegation messages using the provided callback
                const delegationMessages = ctx.getDelegationMessages?.(marker.delegationConversationId);
                const expandedMessage = await expandDelegationMarker(marker, delegationMessages);

                // CRITICAL: Delegation markers can arrive mid-tool-execution when a delegation
                // completes while tools are running. We must defer them just like regular
                // user messages to maintain tool-call/tool-result adjacency for AI SDK validation.
                if (pendingToolCalls.size > 0) {
                    // Create a synthetic entry to defer the already-expanded ModelMessage
                    // We store the expanded content as a text entry for the deferred queue
                    // CRITICAL: Explicit role: "user" ensures consistency with expandDelegationMarker()
                    // which always returns user role. Without this, if recipientPubkey === viewingAgentPubkey
                    // (self-delegation), deriveRole() would incorrectly produce "assistant" role.
                    deferredMessages.push({
                        entry: {
                            id: entry.id,
                            pubkey: marker.recipientPubkey,
                            role: "user",
                            content: expandedMessage.content as string,
                            messageType: "text",
                            // Use the delegation marker's entry properties for context
                            eventId: entry.eventId,
                            ral: entry.ral,
                        },
                        enableMultimodal: false,
                        absoluteIndex,
                    });
                } else {
                    result.push(withMessageIdentity(expandedMessage, entry, absoluteIndex, includeMessageIds));
                }

                trace.getActiveSpan?.()?.addEvent("conversation.delegation_marker_expanded", {
                    "delegation.conversation_id": marker.delegationConversationId.substring(0, 12),
                    "delegation.status": marker.status,
                    "delegation.transcript_found": !!delegationMessages,
                    "delegation.deferred": pendingToolCalls.size > 0,
                });
            } else {
                // Nested delegation marker - show minimal reference only
                // Don't expand transcript to avoid exponential bloat
                const nestedMarkerMessage = await formatNestedDelegationMarker(marker);

                // Same deferral logic for nested markers
                // CRITICAL: Explicit role: "user" ensures consistency with formatNestedDelegationMarker()
                // which always returns user role.
                if (pendingToolCalls.size > 0) {
                    deferredMessages.push({
                        entry: {
                            id: entry.id,
                            pubkey: marker.recipientPubkey,
                            role: "user",
                            content: nestedMarkerMessage.content as string,
                            messageType: "text",
                            eventId: entry.eventId,
                            ral: entry.ral,
                        },
                        enableMultimodal: false,
                        absoluteIndex,
                    });
                } else {
                    result.push(withMessageIdentity(nestedMarkerMessage, entry, absoluteIndex, includeMessageIds));
                }

                trace.getActiveSpan?.()?.addEvent("conversation.nested_delegation_marker_displayed", {
                    "delegation.conversation_id": marker.delegationConversationId.substring(0, 12),
                    "delegation.parent_conversation_id": marker.parentConversationId.substring(0, 12),
                    "current.conversation_id": ctx.conversationId.substring(0, 12),
                    "delegation.status": marker.status,
                    "delegation.recipient_pubkey": marker.recipientPubkey.substring(0, 12),
                    "delegation.deferred": pendingToolCalls.size > 0,
                });
            }
            continue;
        }

        // NON-TOOL MESSAGE (user/assistant text, system, etc.)
        // Only the most recent user message with images gets multimodal conversion
        const enableMultimodal = i === lastUserImageEntryIndex;
        // If tool-calls are pending, defer this message
        if (pendingToolCalls.size > 0) {
            deferredMessages.push({ entry, enableMultimodal, absoluteIndex });
        } else {
            result.push(await buildEntryMessage(entry, absoluteIndex, enableMultimodal));
        }
    }

    // ============================================================================
    // ORPHANED TOOL-CALL RECONCILIATION
    // ============================================================================
    // If we reach the end of all entries and still have pending tool-calls,
    // those are orphans - tool-calls whose results were never stored.
    //
    // We insert synthetic error results at the correct positions to maintain
    // valid message structure for the AI SDK.
    // ============================================================================
    if (pendingToolCalls.size > 0) {
        // Sort by resultIndex descending so splice operations don't shift indices
        const orphans = Array.from(pendingToolCalls.entries())
            .sort((a, b) => b[1].resultIndex - a[1].resultIndex);

        for (const [toolCallId, info] of orphans) {
            const syntheticResult: ModelMessage = {
                role: "tool",
                content: [{
                    type: "tool-result" as const,
                    toolCallId,
                    toolName: info.toolName,
                    output: {
                        type: "text" as const,
                        value: "[Error: Tool execution was interrupted - result unavailable]",
                    },
                }] as ToolResultPart[],
            };
            // Insert synthetic result right after the tool-call
            result.splice(
                info.resultIndex,
                0,
                createSyntheticMessageWithId(
                    syntheticResult,
                    `synthetic-tool-result:${toolCallId}`,
                    includeMessageIds
                )
            );
        }

        // Only emit telemetry for truly unexpected orphans (not in-flight tool calls)
        const unexpectedOrphanIds = inFlightToolCallIds
            ? Array.from(pendingToolCalls.keys()).filter(id => !inFlightToolCallIds.has(id))
            : Array.from(pendingToolCalls.keys());

        if (unexpectedOrphanIds.length > 0) {
            trace.getActiveSpan?.()?.addEvent("conversation.orphaned_tool_calls_reconciled", {
                "orphan.count": unexpectedOrphanIds.length,
                "orphan.tool_call_ids": unexpectedOrphanIds.join(","),
            });
        }
    }

    // Flush any remaining deferred messages
    for (const deferred of deferredMessages) {
        result.push(await buildEntryMessage(
            deferred.entry,
            deferred.absoluteIndex,
            deferred.enableMultimodal
        ));
    }

    if (prunedDelegationCompletions > 0) {
        trace.getActiveSpan?.()?.addEvent("conversation.delegation_completion_pruned", {
            "delegation.pruned_count": prunedDelegationCompletions,
            "delegation.kept_count": latestDelegationCompletionIndexByRal.size,
        });
    }

    // Image placeholder telemetry: Aggregate replacement statistics.
    let totalReplacedCount = 0;
    let totalUniqueReplacedCount = 0;
    for (const msg of result) {
        const stats = imageReplacementStatsByMessage.get(msg);
        if (stats) {
            totalReplacedCount += stats.replacedCount;
            totalUniqueReplacedCount += stats.uniqueReplacedCount;
        }
    }

    // Only emit telemetry when actual replacements occurred
    if (totalReplacedCount > 0) {
        trace.getActiveSpan?.()?.addEvent("conversation.image_placeholder_applied", {
            "image.replaced_count": totalReplacedCount, // Total occurrences replaced
            "image.unique_replaced_count": totalUniqueReplacedCount, // Unique URLs that were replaced
            "image.unique_urls_tracked": imageTracker.getSeenUrls().size, // All unique URLs seen (including first appearances)
            // Estimated token savings: ~1,600 tokens per replacement
            "image.estimated_tokens_saved": totalReplacedCount * 1600,
        });
    }

    return result;
}

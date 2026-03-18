/**
 * ToolEventHandlers - Handles tool-will-execute and tool-did-execute events
 *
 * This module provides setup functions for tool execution event handlers
 * that manage RAL state, conversation store updates, and delegation tracking.
 */

import { ConversationStore } from "@/conversations/ConversationStore";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { RALRegistry, extractPendingDelegations } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { ToolCallPart, ToolResultPart } from "ai";
import chalk from "chalk";
import type { ToolWillExecuteEvent, ToolDidExecuteEvent } from "@/llm/types";
import type { LLMService } from "@/llm/service";
import type { EventContext } from "@/nostr/types";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { FullRuntimeContext } from "./types";
import { getHeuristicEngine } from "@/services/heuristics";
import { buildHeuristicContext } from "@/services/heuristics/ContextBuilder";

const TRANSCRIPT_RAW_ARGS_MAX_LENGTH = 200;

function truncateForTranscript(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    const truncatedChars = value.length - maxLength;
    return `${value.slice(0, maxLength)}... [truncated ${truncatedChars} chars]`;
}

function normalizeTranscriptAttrName(value: string): string {
    const normalized = value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    if (/^[a-zA-Z_]/.test(normalized)) {
        return normalized;
    }
    return `arg_${normalized}`;
}

function serializeTranscriptArg(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return "[Unserializable]";
    }
}

function buildTranscriptToolAttributes(
    toolName: string,
    args: unknown,
    toolDef: AISdkTool | undefined
): Record<string, string> | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
        if (toolName.startsWith("mcp_") && args !== undefined) {
            const raw = truncateForTranscript(String(args), TRANSCRIPT_RAW_ARGS_MAX_LENGTH);
            return { args: raw };
        }
        return undefined;
    }

    const argsObject = args as Record<string, unknown>;
    const attrs: Record<string, string> = {};

    const description = argsObject.description;
    if (typeof description === "string" && description.trim().length > 0) {
        attrs.description = description.trim();
    }

    const specs = toolDef?.transcriptArgsToInclude;
    if (specs && specs.length > 0) {
        for (const spec of specs) {
            const raw = argsObject[spec.key];
            const serialized = serializeTranscriptArg(raw);
            if (!serialized || serialized.length === 0) {
                continue;
            }
            const attrName = normalizeTranscriptAttrName(spec.attribute ?? spec.key);
            attrs[attrName] = serialized;
        }
    } else if (toolName.startsWith("mcp_")) {
        const rawArgs = truncateForTranscript(
            JSON.stringify(argsObject),
            TRANSCRIPT_RAW_ARGS_MAX_LENGTH
        );
        attrs.args = rawArgs;
    }

    return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function setToolCallEventIdFromToolCallId(
    conversationStore: FullRuntimeContext["conversationStore"],
    toolCallId: string,
    toolEventId: string
): void {
    const messages = conversationStore.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.messageType !== "tool-call" || !message.toolData) {
            continue;
        }
        const hasToolCallId = (message.toolData as ToolCallPart[]).some(
            (part) => part.toolCallId === toolCallId
        );
        if (!hasToolCallId) {
            continue;
        }
        conversationStore.setEventId(i, toolEventId);
        return;
    }
}

/**
 * Configuration for setting up tool event handlers
 */
export interface ToolEventHandlersConfig {
    context: FullRuntimeContext;
    llmService: LLMService;
    toolTracker: ToolExecutionTracker;
    toolsObject: Record<string, AISdkTool>;
    eventContext: EventContext;
    ralNumber: number;
}

/**
 * Setup tool-will-execute and tool-did-execute event handlers
 */
export function setupToolEventHandlers(config: ToolEventHandlersConfig): void {
    const { context, llmService, toolTracker, toolsObject, eventContext, ralNumber } = config;
    const conversationStore = context.conversationStore;
    const agentPublisher = context.agentPublisher;
    const ralRegistry = RALRegistry.getInstance();

    llmService.on("tool-will-execute", async (event: ToolWillExecuteEvent) => {
        const argsStr = event.args !== undefined ? JSON.stringify(event.args) : "";
        const argsPreview = argsStr.substring(0, 50);
        console.log(
            chalk.yellow(`\n\u{1F527} ${event.toolName}(${argsPreview}${argsStr.length > 50 ? "..." : ""})`)
        );

        ralRegistry.setToolActive(
            context.agent.pubkey,
            context.conversationId,
            ralNumber,
            event.toolCallId,
            true,
            event.toolName
        );

        // === HEURISTIC: Store tool args for later retrieval ===
        // This enables BLOCKER 2 fix: pass real args to heuristics, not result
        ralRegistry.storeToolArgs(
            context.agent.pubkey,
            context.conversationId,
            ralNumber,
            event.toolCallId,
            event.args
        );

        // === HEURISTIC: Update O(1) summary ===
        // Track tool execution for heuristic evaluation (BLOCKER 1 fix)
        ralRegistry.updateHeuristicSummary(
            context.agent.pubkey,
            context.conversationId,
            ralNumber,
            event.toolName,
            event.args
        );

        const toolDef = toolsObject[event.toolName];
        const transcriptToolAttributes = buildTranscriptToolAttributes(
            event.toolName,
            event.args,
            toolDef
        );

        conversationStore.addMessage({
            pubkey: context.agent.pubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-call",
            toolData: [
                {
                    type: "tool-call",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.args ?? {},
                },
            ] as ToolCallPart[],
            ...(transcriptToolAttributes ? { transcriptToolAttributes } : {}),
        });

        const toolEvent = await toolTracker.trackExecution({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            agentPublisher,
            eventContext,
            usage: event.usage,
        });

        if (toolEvent) {
            await ConversationStore.addEnvelope(
                context.conversationId,
                new NostrInboundAdapter().toEnvelope(toolEvent)
            );
        }
    });

    llmService.on("tool-did-execute", async (event: ToolDidExecuteEvent) => {
        const toolResultMessageIndex = conversationStore.addMessage({
            pubkey: context.agent.pubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-result",
            toolData: [
                {
                    type: "tool-result" as const,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    output:
                        event.result !== undefined
                            ? { type: "json" as const, value: event.result }
                            : { type: "text" as const, value: "" },
                },
            ] as ToolResultPart[],
        });

        // Check for StopExecutionSignal in tool result
        const delegationsFromResult = extractPendingDelegations(event.result);
        if (delegationsFromResult && delegationsFromResult.length > 0) {
            trace.getActiveSpan()?.addEvent("executor.delegation_detected_in_tool_result", {
                "ral.number": ralNumber,
                "tool.name": event.toolName,
                "delegation.count": delegationsFromResult.length,
            });

            // Use atomic merge to safely handle concurrent tool executions
            // that may each produce delegation results
            const { insertedCount, mergedCount } = ralRegistry.mergePendingDelegations(
                context.agent.pubkey,
                context.conversationId,
                ralNumber,
                delegationsFromResult
            );

            const totalPending = ralRegistry.getConversationPendingDelegations(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            ).length;

            logger.info("[ToolEventHandlers] Registered pending delegations from tool result", {
                agent: context.agent.slug,
                ralNumber,
                toolName: event.toolName,
                delegationCount: delegationsFromResult.length,
                insertedCount,
                mergedCount,
                totalPending,
            });
        }

        // === HEURISTIC EVALUATION POST-TOOL ===
        // Evaluate heuristics after tool execution to detect pattern violations
        try {
            const heuristicEngine = getHeuristicEngine();

            // Retrieve stored tool args (BLOCKER 2 fix: use real args, not result)
            const storedArgs = ralRegistry.getToolArgs(
                context.agent.pubkey,
                context.conversationId,
                ralNumber,
                event.toolCallId
            );

            // Build O(1) context from current RAL state
            const heuristicContext = buildHeuristicContext({
                agentPubkey: context.agent.pubkey,
                conversationId: context.conversationId,
                ralNumber,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                toolArgs: storedArgs ?? {}, // Use stored args (fallback to empty object)
                toolResult: event.result,
                ralRegistry,
                conversationStore,
                currentBranch: context.currentBranch,
            });

            // Evaluate all heuristics (with hard error boundaries)
            const violations = heuristicEngine.evaluate(heuristicContext);

            // Add violations to RAL state for injection in next LLM step
            if (violations.length > 0) {
                ralRegistry.addHeuristicViolations(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber,
                    violations
                );
            }

            // Clean up stored tool args to prevent memory leak
            ralRegistry.clearToolArgs(
                context.agent.pubkey,
                context.conversationId,
                ralNumber,
                event.toolCallId
            );
        } catch (error) {
            // HARD ERROR BOUNDARY: Never crash tool pipeline
            logger.error("[ToolEventHandlers] Heuristic evaluation failed", {
                error: error instanceof Error ? error.message : String(error),
                toolName: event.toolName,
            });
        }

        const toolEventId = await toolTracker.completeExecution({
            toolCallId: event.toolCallId,
            result: event.result,
            error: event.error ?? false,
            agentPubkey: context.agent.pubkey,
        });

        if (toolEventId) {
            conversationStore.setEventId(toolResultMessageIndex, toolEventId);
            setToolCallEventIdFromToolCallId(conversationStore, event.toolCallId, toolEventId);
        }

        ralRegistry.setToolActive(
            context.agent.pubkey,
            context.conversationId,
            ralNumber,
            event.toolCallId,
            false,
            event.toolName
        );
    });
}

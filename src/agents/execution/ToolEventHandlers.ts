/**
 * ToolEventHandlers - Handles tool-will-execute and tool-did-execute events
 *
 * This module provides setup functions for tool execution event handlers
 * that manage RAL state, conversation store updates, and delegation tracking.
 */

import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry, extractPendingDelegations } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { ToolCallPart, ToolResultPart } from "ai";
import chalk from "chalk";
import type { LLMService, ToolWillExecuteEvent, ToolDidExecuteEvent } from "@/llm/service";
import type { EventContext } from "@/nostr/types";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { FullRuntimeContext } from "./types";

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
        });

        const toolEvent = await toolTracker.trackExecution({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            toolsObject,
            agentPublisher,
            eventContext,
            usage: event.usage,
        });

        if (toolEvent) {
            await ConversationStore.addEvent(context.conversationId, toolEvent);
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

        const toolEventId = await toolTracker.completeExecution({
            toolCallId: event.toolCallId,
            result: event.result,
            error: event.error ?? false,
            agentPubkey: context.agent.pubkey,
        });

        if (toolEventId) {
            conversationStore.setEventId(toolResultMessageIndex, toolEventId);
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

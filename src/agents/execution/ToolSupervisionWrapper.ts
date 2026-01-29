/**
 * Tool supervision wrapper for pre-tool execution checks.
 *
 * Intercepts tool execution to run heuristics before the tool executes.
 * This allows the supervision system to block or modify tool calls based
 * on configured policies (e.g., preventing certain actions without approval).
 */
import {
    supervisorOrchestrator,
    type PreToolContext,
} from "@/agents/supervision";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import type { Tool as CoreTool } from "ai";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { NudgeService } from "@/services/nudge";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import type { FullRuntimeContext } from "./types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";

/**
 * Wrap tools with pre-tool supervision checks.
 *
 * This function intercepts each tool's execute method to run supervision
 * heuristics before the tool actually executes. If a violation is detected,
 * the tool execution is blocked and a message is returned to the agent.
 *
 * @param toolsObject - The original tools object from the tool registry
 * @param context - The full runtime context for the execution
 * @returns A new tools object with wrapped execute methods
 */
export function wrapToolsWithSupervision(
    toolsObject: Record<string, CoreTool<unknown, unknown>>,
    context: FullRuntimeContext
): Record<string, CoreTool<unknown, unknown>> {
    const wrappedTools: Record<string, CoreTool<unknown, unknown>> = {};
    const ralRegistry = RALRegistry.getInstance();

    for (const [toolName, tool] of Object.entries(toolsObject)) {
        // Skip tools without execute function
        if (!tool.execute) {
            wrappedTools[toolName] = tool;
            continue;
        }

        // Preserve the original tool's properties
        const originalExecute = tool.execute.bind(tool);

        // Create wrapped tool
        wrappedTools[toolName] = {
            ...tool,
            execute: async (input: unknown, options: ToolExecutionOptions) => {
                try {
                    // Build PreToolContext for this tool
                    const conversation = context.getConversation();
                    const conversationStore = context.conversationStore;

                    // Get system prompt and conversation history
                    const projectContext = getProjectContext();

                    // Fetch nudge content if triggering event has nudge tags
                    const preToolNudgeEventIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
                    const preToolNudgeContent = preToolNudgeEventIds.length > 0
                        ? await NudgeService.getInstance().fetchNudges(preToolNudgeEventIds)
                        : "";

                    const systemPromptMessages = await buildSystemPromptMessages({
                        agent: context.agent,
                        project: projectContext.project,
                        conversation,
                        projectBasePath: context.projectBasePath,
                        workingDirectory: context.workingDirectory,
                        currentBranch: context.currentBranch,
                        availableAgents: Array.from(projectContext.agents.values()),
                        mcpManager: projectContext.mcpManager,
                        agentLessons: projectContext.agentLessons,
                        nudgeContent: preToolNudgeContent,
                    });
                    const systemPrompt = systemPromptMessages.map(m => m.message.content).join("\n\n");

                    // Build conversation history from ConversationStore
                    const conversationMessages = await conversationStore.buildMessagesForRal(context.agent.pubkey, context.ralNumber);

                    // Get available tools
                    const toolNames = context.agent.tools || [];
                    const toolsForContext = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

                    // Build PreToolContext
                    const preToolContext: PreToolContext = {
                        agentSlug: context.agent.slug,
                        agentPubkey: context.agent.pubkey,
                        toolName,
                        toolArgs: input,
                        systemPrompt,
                        conversationHistory: conversationMessages,
                        availableTools: toolsForContext,
                    };

                    // Run pre-tool supervision check
                    logger.debug(`[ToolSupervisionWrapper] Running pre-tool supervision for "${toolName}"`, {
                        agent: context.agent.slug,
                    });

                    // Build executionId for heuristic enforcement tracking
                    const preToolExecutionId = `${context.agent.pubkey}:${context.conversationId}:${context.ralNumber}`;
                    const supervisionResult = await supervisorOrchestrator.checkPreTool(preToolContext, preToolExecutionId);

                    // If supervision detected a violation, block the tool
                    if (supervisionResult.hasViolation && supervisionResult.correctionAction) {
                        logger.warn(
                            `[ToolSupervisionWrapper] Pre-tool supervision blocked "${toolName}" execution`,
                            {
                                agent: context.agent.slug,
                                heuristic: supervisionResult.heuristicId,
                                actionType: supervisionResult.correctionAction.type,
                            }
                        );

                        // Mark this heuristic as enforced so it won't fire again in this RAL
                        if (supervisionResult.heuristicId) {
                            supervisorOrchestrator.markHeuristicEnforced(preToolExecutionId, supervisionResult.heuristicId);
                        }

                        // Queue correction message if available (for both inject-message and block-tool)
                        if (
                            supervisionResult.correctionAction.message &&
                            supervisionResult.correctionAction.reEngage
                        ) {
                            ralRegistry.queueUserMessage(
                                context.agent.pubkey,
                                context.conversationId,
                                context.ralNumber,
                                supervisionResult.correctionAction.message
                            );
                        }

                        // Return a blocked execution message
                        return `Tool execution blocked: ${supervisionResult.correctionAction.message || "This tool cannot be executed at this time."}`;
                    }

                    // No violation - execute the original tool
                    logger.debug(`[ToolSupervisionWrapper] Pre-tool supervision passed for "${toolName}"`, {
                        agent: context.agent.slug,
                    });

                    return await originalExecute(input, options);
                } catch (error) {
                    logger.error("[ToolSupervisionWrapper] Error during pre-tool supervision check", {
                        tool: toolName,
                        error: formatAnyError(error),
                    });
                    // On supervision error, allow tool to execute (fail-safe)
                    return await originalExecute(input, options);
                }
            },
        };

        // Preserve non-enumerable properties like getHumanReadableContent
        const toolWithCustomProps = tool as CoreTool<unknown, unknown> & {
            getHumanReadableContent?: (args: unknown) => string;
        };
        if (toolWithCustomProps.getHumanReadableContent) {
            Object.defineProperty(wrappedTools[toolName], "getHumanReadableContent", {
                value: toolWithCustomProps.getHumanReadableContent,
                enumerable: false,
            });
        }
    }

    return wrappedTools;
}

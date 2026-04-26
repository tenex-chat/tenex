/**
 * Tool publishing wrapper: publishes a tool_use kind:1 event for every tool
 * call, awaited synchronously inside the AI SDK's execute() call so the
 * publish cannot race against worker exit.
 *
 * This is the authoritative path for all tool_use Nostr events.
 * No other code path must call agentPublisher.toolUse().
 */

import { formatMcpToolName, isDelegateToolName } from "@/agents/tool-names";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import { createEventContext } from "@/services/event-context";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import type { Tool as CoreTool } from "ai";
import type { FullRuntimeContext } from "./types";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";

/**
 * Extract the delegation event ID from a tool result.
 *
 * Delegate-family tools embed a `delegationEventId` field in their result
 * containing the full event ID of the published delegation or ask event.
 * The wrapper reads this field to build the q-tag in the tool_use event.
 */
function extractDelegationEventId(result: unknown): string | undefined {
    if (result === null || typeof result !== "object") return undefined;
    const r = result as Record<string, unknown>;
    if (typeof r.delegationEventId === "string" && r.delegationEventId.length > 0) {
        return r.delegationEventId;
    }
    return undefined;
}

/**
 * Wrap tools so that a tool_use kind:1 event is published after every
 * tool execution, awaited inside the AI SDK's execute() call.
 *
 * For delegate-family tools the event carries q-tags referencing the
 * delegation event IDs, derived directly from the tool result's
 * `delegationEventId` field. MCP-wrapped delegate variants whose result
 * shape is stripped by the transport publish without a q-tag — there is
 * no per-tool-call correlation channel that survives transport stripping
 * and would correctly disambiguate parallel calls on the same conversation.
 */
export function wrapToolsWithToolUsePublishing(
    toolsObject: Record<string, CoreTool<unknown, unknown>>,
    context: FullRuntimeContext,
    toolTracker: ToolExecutionTracker
): Record<string, CoreTool<unknown, unknown>> {
    const agentPublisher = context.agentPublisher as AgentRuntimePublisher;
    const wrappedTools: Record<string, CoreTool<unknown, unknown>> = {};

    for (const [toolName, tool] of Object.entries(toolsObject)) {
        if (!tool.execute) {
            wrappedTools[toolName] = tool;
            continue;
        }

        const originalExecute = tool.execute.bind(tool);

        wrappedTools[toolName] = {
            ...tool,
            execute: async (input: unknown, options: ToolExecutionOptions) => {
                const result = await originalExecute(input, options);

                const humanContent = toolName.startsWith("mcp__")
                    ? `Executing ${formatMcpToolName(toolName)}`
                    : `Executing ${toolName}`;

                let referencedEventIds: string[] | undefined;
                if (isDelegateToolName(toolName)) {
                    const directId = extractDelegationEventId(result);
                    if (directId) {
                        referencedEventIds = [directId];
                    }
                }

                const eventContext = createEventContext(context);
                const publishedRef = await agentPublisher.toolUse(
                    {
                        toolName,
                        content: humanContent,
                        args: input,
                        ...(referencedEventIds ? { referencedEventIds } : {}),
                    },
                    eventContext
                );
                toolTracker.setToolEventId(options.toolCallId, publishedRef.id);
                await ConversationStore.addEnvelope(context.conversationId, publishedRef.envelope);

                return result;
            },
        };
    }

    return wrappedTools;
}

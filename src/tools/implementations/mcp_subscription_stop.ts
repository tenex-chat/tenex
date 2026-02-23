import type { ToolExecutionContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, createExpectedError } from "@/tools/utils";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for stopping an MCP subscription
 */
const mcpSubscriptionStopSchema = z.object({
    subscriptionId: z.string().describe("The subscription ID to stop (returned by mcp_subscribe)"),
});

/**
 * Core implementation of stopping an MCP subscription
 */
async function executeStop(
    input: z.infer<typeof mcpSubscriptionStopSchema>,
    context: ToolExecutionContext
): Promise<ToolResponse | ReturnType<typeof createExpectedError>> {
    const { subscriptionId } = input;

    const subscriptionService = McpSubscriptionService.getInstance();
    const subscription = subscriptionService.getSubscription(subscriptionId);

    if (!subscription) {
        return createExpectedError(
            `Subscription '${subscriptionId}' not found. ` +
                "Please verify the subscription ID is correct."
        );
    }

    // Authorization: only the agent that created the subscription can stop it
    if (subscription.agentPubkey !== context.agent.pubkey) {
        return createExpectedError(
            `You are not authorized to stop subscription '${subscriptionId}'. ` +
                "Only the agent that created the subscription can stop it."
        );
    }

    const success = await subscriptionService.stopSubscription(subscriptionId, context.agent.pubkey);

    if (!success) {
        return createExpectedError(
            `Failed to stop subscription '${subscriptionId}'.`
        );
    }

    return {
        success: true,
        message: `Successfully stopped MCP subscription '${subscriptionId}'`,
        subscription: {
            id: subscription.id,
            serverName: subscription.serverName,
            resourceUri: subscription.resourceUri,
            notificationsReceived: subscription.notificationsReceived,
        },
    };
}

/**
 * Stop an active MCP resource subscription.
 *
 * This cancels the subscription and cleans up all persisted state.
 * The subscription will no longer deliver notifications.
 */
export function createMcpSubscriptionStopTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Stop an active MCP resource subscription. " +
            "Cancels the subscription and removes persisted state. " +
            "No more notifications will be delivered.",
        inputSchema: mcpSubscriptionStopSchema,
        execute: async (input) => {
            const result = await executeStop(input, context);

            if (typeof result === "object" && "type" in result && result.type === "error-text") {
                return result;
            }

            return JSON.stringify(result, null, 2);
        },
    }) as AISdkTool;
}

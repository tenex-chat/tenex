import type { ExecutionContext } from "@/agents/execution/types";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for getting a specific RAG subscription
 */
const ragSubscriptionGetSchema = z.object({
    subscriptionId: z.string().describe("The ID of the subscription to retrieve"),
});

/**
 * Calculate uptime for a subscription
 */
function calculateUptime(createdAt: number, status: string): string {
    if (status !== "RUNNING") {
        return "N/A";
    }

    const uptimeMs = Date.now() - createdAt;
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

    return parts.join(" ");
}

/**
 * Core implementation of getting a RAG subscription
 */
async function executeGetSubscription(
    input: z.infer<typeof ragSubscriptionGetSchema>,
    context: ExecutionContext
): Promise<ToolResponse> {
    const { subscriptionId } = input;

    // Mandate agent identity - no compromises
    if (!context.agent?.pubkey) {
        throw new Error(
            "Agent identity is required. Cannot retrieve subscription without valid agent pubkey."
        );
    }
    const agentPubkey = context.agent.pubkey;

    // Get the service instance (already initialized at startup)
    const subscriptionService = RagSubscriptionService.getInstance();

    // Get the subscription
    const subscription = await subscriptionService.getSubscription(subscriptionId, agentPubkey);

    if (!subscription) {
        return {
            success: false,
            message: `Subscription '${subscriptionId}' not found`,
            error: "SUBSCRIPTION_NOT_FOUND",
        };
    }

    // Calculate uptime
    const uptime = calculateUptime(subscription.createdAt, subscription.status);

    // Format detailed response
    const details = {
        id: subscription.subscriptionId,
        description: subscription.description,
        status: subscription.status,
        configuration: {
            mcpServer: subscription.mcpServerId,
            resource: subscription.resourceUri,
            collection: subscription.ragCollection,
        },
        metrics: {
            documentsProcessed: subscription.documentsProcessed,
            uptime: uptime,
            createdAt: new Date(subscription.createdAt).toISOString(),
            updatedAt: new Date(subscription.updatedAt).toISOString(),
        },
        lastDocumentSnippet: subscription.lastDocumentIngested || null,
        lastError: subscription.lastError || null,
    };

    return {
        success: true,
        message: `Retrieved details for subscription '${subscriptionId}'`,
        subscription: details,
    };
}

/**
 * Get detailed information about a specific RAG subscription
 *
 * Returns comprehensive details including:
 * - Current status and configuration
 * - Processing metrics (documents processed, uptime)
 * - Last ingested document snippet
 * - Error information if any
 * - Timestamps for creation and last update
 *
 * Use this to monitor the health and progress of a specific subscription.
 */
export function createRAGSubscriptionGetTool(context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "Get detailed status and metrics for a specific RAG subscription, including processing statistics and the last ingested document snippet.",
        inputSchema: ragSubscriptionGetSchema,
        execute: async (input: z.infer<typeof ragSubscriptionGetSchema>) => {
            return executeToolWithErrorHandling(
                "rag_subscription_get",
                input,
                context,
                executeGetSubscription
            );
        },
    }) as AISdkTool;
} 

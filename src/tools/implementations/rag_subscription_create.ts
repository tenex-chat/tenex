import type { ToolContext } from "@/tools/types";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for creating a RAG subscription
 */
const ragSubscriptionCreateSchema = z.object({
    subscriptionId: z
        .string()
        .describe('Unique identifier for the subscription (e.g., "ndk-updates", "market-data")'),
    mcpServerId: z
        .string()
        .describe(
            'The ID of the installed MCP tool/server providing the resource (e.g., "nostr-provider")'
        ),
    resourceUri: z
        .string()
        .describe(
            'The MCP resource URI to subscribe to (e.g., "nostr://feed/pubkey/kinds", "file:///path/to/file"). ' +
                "This must be an actual resource URI, NOT a tool name. If using a resource template, " +
                "you must first expand it with parameters to get the actual URI."
        ),
    ragCollection: z.string().describe("Name of the RAG collection where data will be stored"),
    description: z.string().describe("Human-readable description of what this subscription does"),
});

/**
 * Core implementation of creating a RAG subscription
 */
async function executeCreateSubscription(
    input: z.infer<typeof ragSubscriptionCreateSchema>,
    context: ToolContext
): Promise<ToolResponse> {
    const { subscriptionId, mcpServerId, resourceUri, ragCollection, description } = input;

    // Mandate agent identity - no compromises
    if (!context.agent?.pubkey) {
        throw new Error(
            "Agent identity is required. Cannot create subscription without valid agent pubkey."
        );
    }
    const agentPubkey = context.agent.pubkey;

    // Get the service instance (already initialized at startup)
    const subscriptionService = RagSubscriptionService.getInstance();

    // Create the subscription
    const subscription = await subscriptionService.createSubscription(
        subscriptionId,
        agentPubkey,
        mcpServerId,
        resourceUri,
        ragCollection,
        description
    );

    return {
        success: true,
        message: `Successfully created subscription '${subscriptionId}'`,
        subscription: {
            id: subscription.subscriptionId,
            mcpServer: subscription.mcpServerId,
            resource: subscription.resourceUri,
            collection: subscription.ragCollection,
            status: subscription.status,
            description: subscription.description,
        },
    };
}

/**
 * Create a persistent RAG subscription to stream data from MCP resources
 *
 * This tool creates a persistent subscription that:
 * - Connects to an installed MCP server/tool
 * - Subscribes to a specific resource
 * - Automatically pipes updates to a RAG collection
 * - Persists across TENEX restarts
 *
 * Example use cases:
 * - Subscribe to a changelog from an NDK server
 * - Stream market data into a trading knowledge base
 * - Collect social media updates for analysis
 *
 * The subscription will remain active until explicitly deleted.
 */
export function createRAGSubscriptionCreateTool(context: ToolContext): AISdkTool {
    return tool({
        description:
            "Create a persistent subscription to stream data from an MCP resource into a RAG collection. The subscription will automatically pipe all updates from the specified resource to the RAG collection and persist across restarts.",
        inputSchema: ragSubscriptionCreateSchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling(
                "rag_subscription_create",
                input as z.infer<typeof ragSubscriptionCreateSchema>,
                context,
                executeCreateSubscription
            );
        },
    }) as AISdkTool;
} 

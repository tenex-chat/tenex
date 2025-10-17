import { tool } from "ai";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
import { executeToolWithErrorHandling, type ToolResponse } from "@/tools/utils";

/**
 * Schema for deleting a RAG subscription
 */
const ragSubscriptionDeleteSchema = z.object({
  subscriptionId: z.string().describe(
    "The ID of the subscription to delete"
  )
});

/**
 * Core implementation of deleting a RAG subscription
 */
async function executeDeleteSubscription(
  input: z.infer<typeof ragSubscriptionDeleteSchema>,
  context: ExecutionContext
): Promise<ToolResponse> {
  const { subscriptionId } = input;
  
  // Mandate agent identity - no compromises
  if (!context.agent?.pubkey) {
    throw new Error("Agent identity is required. Cannot delete subscription without valid agent pubkey.");
  }
  const agentPubkey = context.agent.pubkey;
  
  // Get the service instance (already initialized at startup)
  const subscriptionService = RagSubscriptionService.getInstance();
  
  // Delete the subscription
  const deleted = await subscriptionService.deleteSubscription(subscriptionId, agentPubkey);
  
  if (!deleted) {
    return {
      success: false,
      message: `Subscription '${subscriptionId}' not found or you don't have permission to delete it`,
      error: "SUBSCRIPTION_NOT_FOUND"
    };
  }
  
  return {
    success: true,
    message: `Successfully deleted subscription '${subscriptionId}'`,
    subscriptionId: subscriptionId
  };
}

/**
 * Delete a RAG subscription and stop data streaming
 * 
 * This will:
 * - Stop receiving updates from the MCP resource
 * - Remove the subscription from persistent storage
 * - Clean up any associated listeners
 * 
 * Note: Previously ingested documents remain in the RAG collection.
 * Only the subscription itself is deleted, not the data.
 * 
 * You can only delete subscriptions that belong to your agent.
 */
export function createRAGSubscriptionDeleteTool(context: ExecutionContext): AISdkTool {
  return tool({
    description: "Delete a RAG subscription to stop streaming data from an MCP resource. Previously ingested documents will remain in the RAG collection.",
    inputSchema: ragSubscriptionDeleteSchema,
    execute: async (input: z.infer<typeof ragSubscriptionDeleteSchema>) => {
      return executeToolWithErrorHandling(
        "rag_subscription_delete",
        input,
        context,
        executeDeleteSubscription
      );
    },
  });
}
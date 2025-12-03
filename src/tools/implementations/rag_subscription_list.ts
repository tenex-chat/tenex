import type { ExecutionContext } from "@/agents/execution/types";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

/**
 * Core implementation of listing RAG subscriptions
 */
async function executeListSubscriptions(
    _input: unknown,
    context: ExecutionContext
): Promise<ToolResponse> {
    // Mandate agent identity - no compromises
    if (!context.agent?.pubkey) {
        throw new Error(
            "Agent identity is required. Cannot list subscriptions without valid agent pubkey."
        );
    }
    const agentPubkey = context.agent.pubkey;

    // Get the service instance (already initialized at startup)
    const subscriptionService = RagSubscriptionService.getInstance();

    // List subscriptions for this agent
    const subscriptions = await subscriptionService.listSubscriptions(agentPubkey);

    // Single-pass statistics calculation with proper efficiency
    const statistics = subscriptions.reduce(
        (acc, sub) => {
            // Format subscription while calculating statistics
            acc.formattedSubscriptions.push({
                id: sub.subscriptionId,
                mcpServer: sub.mcpServerId,
                resource: sub.resourceUri,
                collection: sub.ragCollection,
                status: sub.status,
                documentsProcessed: sub.documentsProcessed,
                description: sub.description,
                createdAt: new Date(sub.createdAt).toISOString(),
                updatedAt: new Date(sub.updatedAt).toISOString(),
                lastError: sub.lastError,
            });

            // Update counters in single pass
            acc.total++;
            acc.totalDocumentsProcessed += sub.documentsProcessed;

            switch (sub.status) {
                case "RUNNING":
                    acc.running++;
                    break;
                case "ERROR":
                    acc.error++;
                    break;
                case "STOPPED":
                    acc.stopped++;
                    break;
            }

            return acc;
        },
        {
            formattedSubscriptions: [] as Array<{
                id: string;
                mcpServer: string;
                resource: string;
                collection: string;
                status: string;
                documentsProcessed: number;
                description: string;
                createdAt: string;
                updatedAt: string;
                lastError?: string;
            }>,
            total: 0,
            running: 0,
            error: 0,
            stopped: 0,
            totalDocumentsProcessed: 0,
        }
    );

    return {
        success: true,
        message: `Found ${statistics.total} subscription(s)`,
        subscriptions: statistics.formattedSubscriptions,
        statistics: {
            total: statistics.total,
            running: statistics.running,
            error: statistics.error,
            stopped: statistics.stopped,
            totalDocumentsProcessed: statistics.totalDocumentsProcessed,
        },
    };
}

/**
 * List all active RAG subscriptions for the current agent
 *
 * Returns a list of all subscriptions including:
 * - Subscription ID and description
 * - MCP server and resource information
 * - Target RAG collection
 * - Current status (RUNNING, ERROR, STOPPED)
 * - Number of documents processed
 * - Timestamps and error information
 *
 * Also provides aggregate statistics about all subscriptions.
 */
const ragSubscriptionListSchema = z.object({});

export function createRAGSubscriptionListTool(context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "List all active RAG subscriptions for the current agent, showing their status, configuration, and statistics.",
        inputSchema: ragSubscriptionListSchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling(
                "rag_subscription_list",
                input,
                context,
                executeListSubscriptions
            );
        },
    }) as AISdkTool;
} 

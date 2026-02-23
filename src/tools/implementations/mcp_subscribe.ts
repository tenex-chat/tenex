import type { ConversationToolContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, createExpectedError } from "@/tools/utils";
import { extractAgentMcpServers } from "@/prompts/fragments/26-mcp-resources";
import { getProjectContext } from "@/services/projects";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for creating an MCP resource subscription
 */
const mcpSubscribeSchema = z.object({
    serverName: z.string().describe('MCP server name (e.g., "nostr-provider")'),
    resourceUri: z.string().describe('Resource URI to subscribe to (e.g., "nostr://feed/global")'),
    description: z.string().describe("Human-readable description of what this subscription monitors"),
});

/**
 * Validate that a resource URI has a scheme and non-empty path.
 * MCP resource URIs follow standard URI format (e.g., "nostr://feed/global", "file:///path").
 */
function isValidResourceUri(uri: string): boolean {
    try {
        // Check basic structure: must have a scheme (protocol) component
        const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(uri);
        if (!schemeMatch) return false;
        // Must have something after the scheme
        const afterScheme = uri.indexOf(":") + 1;
        return afterScheme < uri.length && uri.substring(afterScheme).trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Core implementation of MCP resource subscription
 */
async function executeSubscribe(
    input: z.infer<typeof mcpSubscribeSchema>,
    context: ConversationToolContext
): Promise<ToolResponse | ReturnType<typeof createExpectedError>> {
    const { serverName, resourceUri, description } = input;

    // Validate URI format upfront
    if (!isValidResourceUri(resourceUri)) {
        return createExpectedError(
            `Invalid resource URI '${resourceUri}'. ` +
                "Resource URIs must have a valid scheme (e.g., 'nostr://feed/global', 'file:///path')."
        );
    }

    // Get MCPManager from project context
    const projectContext = getProjectContext();
    const mcpManager = projectContext.mcpManager;

    if (!mcpManager) {
        throw new Error(
            "MCP manager not available. This is a system error - MCP should be initialized."
        );
    }

    // Validate agent has access to this server
    const agentMcpServers = extractAgentMcpServers(context.agent.tools);

    if (!agentMcpServers.includes(serverName)) {
        return createExpectedError(
            `You do not have access to MCP server '${serverName}'. ` +
                "You can only subscribe to resources from servers you have tools from. " +
                `Your accessible servers: ${agentMcpServers.length > 0 ? agentMcpServers.join(", ") : "none"}`
        );
    }

    // Check if server is running
    const runningServers = mcpManager.getRunningServers();
    if (!runningServers.includes(serverName)) {
        return createExpectedError(
            `MCP server '${serverName}' is not running. ` +
                `Running servers: ${runningServers.length > 0 ? runningServers.join(", ") : "none"}`
        );
    }

    // Get conversation details for subscription context
    const conversationStore = context.conversationStore;
    const rootEventId = conversationStore.getRootEventId();

    if (!rootEventId) {
        return createExpectedError(
            "Cannot create subscription: conversation has no root event. " +
                "This subscription must be created within an active conversation."
        );
    }

    const projectId = projectContext.project.tagId();

    try {
        const subscriptionService = McpSubscriptionService.getInstance();

        const subscription = await subscriptionService.createSubscription({
            agentPubkey: context.agent.pubkey,
            agentSlug: context.agent.slug,
            serverName,
            resourceUri,
            conversationId: context.conversationId,
            rootEventId,
            projectId,
            description,
        });

        return {
            success: true,
            message: `Successfully created MCP subscription '${subscription.id}'`,
            subscription: {
                id: subscription.id,
                serverName: subscription.serverName,
                resourceUri: subscription.resourceUri,
                conversationId: subscription.conversationId,
                status: subscription.status,
                description: subscription.description,
            },
            hint: `Use mcp_subscription_stop('${subscription.id}') to cancel this subscription.`,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createExpectedError(
            `Failed to create MCP subscription: ${errorMessage}`
        );
    }
}

/**
 * Subscribe to MCP resource notifications within the current conversation.
 *
 * When the subscribed resource is updated, a notification will be delivered
 * as a system-reminder message in this conversation, triggering a new
 * agent execution to handle the update.
 *
 * Subscriptions persist across system restarts.
 */
export function createMcpSubscribeTool(context: ConversationToolContext): AISdkTool {
    return tool({
        description:
            "Subscribe to MCP resource update notifications. When the resource changes, " +
            "a notification will be delivered to this conversation. " +
            "You can only subscribe to resources from MCP servers you have tools from. " +
            "Subscriptions persist across restarts.",
        inputSchema: mcpSubscribeSchema,
        execute: async (input) => {
            const result = await executeSubscribe(input, context);

            if (typeof result === "object" && "type" in result && result.type === "error-text") {
                return result;
            }

            return JSON.stringify(result, null, 2);
        },
    }) as AISdkTool;
}

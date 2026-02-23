import type { ToolExecutionContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, createExpectedError } from "@/tools/utils";
import { extractAgentMcpServers } from "@/prompts/fragments/26-mcp-resources";
import { getProjectContext } from "@/services/projects";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for reading an MCP resource
 */
const mcpResourceReadSchema = z.object({
    serverName: z.string().describe('MCP server name (e.g., "nostr-provider")'),
    resourceUri: z.string().describe('Resource URI to read (e.g., "file:///path/to/file")'),
    templateParams: z
        .record(z.string(), z.string())
        .optional()
        .describe('Parameters for template expansion (e.g., {"pubkey": "abc123"})'),
    description: z.string().describe("Why you are reading this resource"),
});

/**
 * Expand a resource URI template with parameters.
 * Replaces {param} placeholders with actual values.
 */
function expandUriTemplate(uriTemplate: string, params: Record<string, string>): string {
    let expandedUri = uriTemplate;
    for (const [key, value] of Object.entries(params)) {
        expandedUri = expandedUri.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    return expandedUri;
}

/**
 * Core implementation of reading an MCP resource
 */
async function executeReadResource(
    input: z.infer<typeof mcpResourceReadSchema>,
    context: ToolExecutionContext
): Promise<ToolResponse | ReturnType<typeof createExpectedError>> {
    const { serverName, resourceUri, templateParams, description } = input;

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
                `You can only read resources from servers you have tools from. ` +
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

    // Expand template if params provided
    const expandedUri = templateParams ? expandUriTemplate(resourceUri, templateParams) : resourceUri;

    // Check if URI still has unfilled placeholders
    if (expandedUri.includes("{") && expandedUri.includes("}")) {
        return createExpectedError(
            `Resource URI contains unfilled template parameters: ${expandedUri}. ` +
                "Please provide all required parameters via templateParams."
        );
    }

    try {
        // Read the resource
        const result = await mcpManager.readResource(serverName, expandedUri);

        // Format the content for return
        const formattedContents: string[] = [];

        for (const content of result.contents) {
            if ("text" in content && typeof content.text === "string") {
                formattedContents.push(content.text);
            } else if ("blob" in content && typeof content.blob === "string") {
                formattedContents.push(
                    `[Binary content: ${content.blob.length} bytes, MIME type: ${content.mimeType || "unknown"}]`
                );
            }
        }

        return {
            success: true,
            message: `Successfully read resource from MCP server '${serverName}'`,
            resourceUri: expandedUri,
            serverName,
            description,
            content: formattedContents.join("\n\n"),
            mimeType: result.contents[0]?.mimeType,
        };
    } catch (error) {
        // MCP resource not found or other expected errors
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (
            errorMessage.toLowerCase().includes("not found") ||
            errorMessage.toLowerCase().includes("does not exist")
        ) {
            return createExpectedError(
                `Resource '${expandedUri}' not found on MCP server '${serverName}'. ` +
                    `Please verify the URI is correct.`
            );
        }

        // Other MCP errors - return as expected error (user-facing)
        return createExpectedError(
            `Failed to read resource '${expandedUri}' from MCP server '${serverName}': ${errorMessage}`
        );
    }
}

/**
 * Read content from an MCP resource on-demand.
 *
 * This tool provides immediate access to MCP resource content without setting up
 * a persistent subscription. You can only read resources from MCP servers you have
 * tools from (servers where you have mcp__serverName__* tools).
 *
 * Example use cases:
 * - Read a configuration file from an MCP server
 * - Fetch current state from a resource template
 * - Access documentation or reference data
 *
 * For continuous updates, use rag_subscription_create instead.
 */
export function createMcpResourceReadTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Read content from an MCP resource. You can only read resources from MCP servers you have tools from.",
        inputSchema: mcpResourceReadSchema,
        execute: async (input) => {
            const result = await executeReadResource(input, context);

            // Handle expected error results
            if (typeof result === "object" && "type" in result && result.type === "error-text") {
                return result;
            }

            return JSON.stringify(result, null, 2);
        },
    }) as AISdkTool;
}

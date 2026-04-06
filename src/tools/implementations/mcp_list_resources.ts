import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { extractAgentMcpServers } from "@/services/mcp/mcp-utils";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const MCP_LIST_TIMEOUT_MS = 2_000;

function formatResource(
    resource: Resource,
    serverName: string
): string {
    const lines: string[] = [];
    lines.push(`- **${resource.name}** (\`${resource.uri}\`)`);
    if (resource.description) {
        lines.push(`  ${resource.description}`);
    }
    lines.push(`  Server: ${serverName}`);
    if (resource.mimeType) {
        lines.push(`  Type: ${resource.mimeType}`);
    }
    return lines.join("\n");
}

function formatTemplate(
    template: ResourceTemplate,
    serverName: string
): string {
    const lines: string[] = [];
    lines.push(`- **${template.name}** (\`${template.uriTemplate}\`) *[Template]*`);
    if (template.description) {
        lines.push(`  ${template.description}`);
    }
    lines.push(`  Server: ${serverName}`);

    const params = template.uriTemplate.match(/\{([^}]+)\}/g);
    if (params) {
        const paramNames = params.map((p) => p.slice(1, -1)).join(", ");
        lines.push(`  **Required parameters:** ${paramNames}`);
        lines.push("  **Note:** Expand this template with actual values before using");
    }

    if (template.mimeType) {
        lines.push(`  Type: ${template.mimeType}`);
    }
    return lines.join("\n");
}

/**
 * List available MCP resources from all servers the agent has access to.
 */
export function createMcpListResourcesTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "List available MCP resources and resource templates from servers you have access to. " +
            "Use this to discover what resources are available before reading them with mcp_resource_read " +
            "or subscribing with mcp_subscribe.",
        inputSchema: z.object({}),
        execute: async () => {
            const projectContext = getProjectContext();
            const mcpManager = projectContext.mcpManager;

            if (!mcpManager) {
                return "MCP manager not available. No MCP servers are configured for this project.";
            }

            const agentMcpServers = extractAgentMcpServers(context.agent.tools);
            if (agentMcpServers.length === 0) {
                return "You have no MCP server access. No tools matching mcp__*__* found in your tool list.";
            }

            const runningServers = mcpManager.getConfiguredServers();
            const agentRunningServers = agentMcpServers.filter(s => runningServers.includes(s));

            if (agentRunningServers.length === 0) {
                return `Your MCP servers (${agentMcpServers.join(", ")}) are not currently running.`;
            }

            const resourcesPerServer = await Promise.all(
                agentRunningServers.map(async (serverName: string) => {
                    try {
                        const [resources, templates] = await Promise.all([
                            mcpManager.listResourcesWithOptions(serverName, {
                                timeoutMs: MCP_LIST_TIMEOUT_MS,
                                preferCache: true,
                                allowStale: true,
                            }),
                            mcpManager.listResourceTemplatesWithOptions(serverName, {
                                timeoutMs: MCP_LIST_TIMEOUT_MS,
                                preferCache: true,
                                allowStale: true,
                            }),
                        ]);
                        logger.debug(
                            `Fetched ${resources.length} resources and ${templates.length} templates from '${serverName}'`
                        );
                        return { serverName, resources, templates };
                    } catch (error) {
                        logger.warn(`Failed to fetch MCP resources from '${serverName}':`, error);
                        return { serverName, resources: [] as Resource[], templates: [] as ResourceTemplate[] };
                    }
                })
            );

            const hasAnyResources = resourcesPerServer.some(
                (server) => server.resources.length > 0 || server.templates.length > 0
            );

            if (!hasAnyResources) {
                return `Connected to ${agentRunningServers.length} MCP server(s) (${agentRunningServers.join(", ")}), but no resources are available.`;
            }

            const sections: string[] = [];
            const serverNames = resourcesPerServer.map((s) => s.serverName);
            sections.push("# Available MCP Resources\n");
            sections.push(
                `Access to ${serverNames.length} server${serverNames.length === 1 ? "" : "s"}: ${serverNames.join(", ")}\n`
            );

            let totalResources = 0;
            let totalTemplates = 0;

            for (const serverData of resourcesPerServer) {
                const { serverName, resources, templates } = serverData;

                if (resources.length === 0 && templates.length === 0) {
                    continue;
                }

                sections.push(`## Server: ${serverName}\n`);

                if (resources.length > 0) {
                    sections.push("### Direct Resources\n");
                    for (const resource of resources) {
                        sections.push(formatResource(resource, serverName));
                        sections.push("");
                    }
                    totalResources += resources.length;
                }

                if (templates.length > 0) {
                    sections.push("### Resource Templates (require parameter expansion)\n");
                    for (const template of templates) {
                        sections.push(formatTemplate(template, serverName));
                        sections.push("");
                    }
                    totalTemplates += templates.length;
                }

                sections.push("---\n");
            }

            sections.push(
                `**Summary:** ${totalResources} direct resource${totalResources === 1 ? "" : "s"}, ${totalTemplates} template${totalTemplates === 1 ? "" : "s"} available`
            );

            return sections.join("\n");
        },
    }) as AISdkTool;
}

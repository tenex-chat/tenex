import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";
import { mcpService } from "@/services/mcp/MCPService";
import type { Tool } from "@/tools/types";

interface MCPToolsArgs {
    enabled?: boolean;
    tools?: Tool[]; // Optional tools parameter
}

export const mcpToolsFragment: PromptFragment<MCPToolsArgs> = {
    id: "mcp-tools",
    priority: 30, // After core tools but before agent-specific content
    template: (args: MCPToolsArgs) => {
        if (args.enabled === false) {
            return "";
        }

        try {
            // Use provided tools or get cached tools synchronously
            const tools = args.tools || mcpService.getCachedTools();

            if (tools.length === 0) {
                return "";
            }

            // Group tools by server
            const toolsByServer = new Map<string, Tool[]>();
            for (const tool of tools) {
                const [serverName] = tool.name.split("/");
                if (!serverName) continue;

                if (!toolsByServer.has(serverName)) {
                    toolsByServer.set(serverName, []);
                }
                toolsByServer.get(serverName)?.push(tool);
            }

            // Generate markdown content
            let content = "## MCP Tools\n\n";
            content += "The following tools are available from MCP servers:\n\n";

            for (const [serverName, serverTools] of toolsByServer) {
                content += `### ${serverName}\n\n`;

                for (const tool of serverTools) {
                    content += `#### ${tool.name}\n`;
                    content += `${tool.description}\n`;

                    // Add parameter information if available
                    if (
                        tool.parameters &&
                        tool.parameters.shape.type === "object" &&
                        tool.parameters.shape.properties
                    ) {
                        content += "\nParameters:\n";
                        for (const [paramName, paramSchema] of Object.entries(
                            tool.parameters.shape.properties
                        )) {
                            const paramDescription = paramSchema.description || "No description";
                            content += `  - ${paramName} (${paramSchema.type}): ${paramDescription}\n`;
                        }
                    }
                    content += "\n";
                }
            }

            content +=
                "To use an MCP tool, call it with the full namespaced name (e.g., 'server-name/tool-name').\n";

            return content;
        } catch (error) {
            // Silent failure - don't break prompt generation
            return "";
        }
    },
    validateArgs: (args: unknown): args is MCPToolsArgs => {
        return typeof args === "object" && args !== null;
    },
    expectedArgs: "{ enabled?: boolean }",
};

// Register the fragment
fragmentRegistry.register(mcpToolsFragment);

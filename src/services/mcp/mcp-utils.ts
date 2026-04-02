/**
 * Extract unique MCP server names from agent's tool list.
 * MCP tools are namespaced as: mcp__serverName__toolName
 */
export function extractAgentMcpServers(agentTools: string[]): string[] {
    const servers = new Set<string>();
    for (const tool of agentTools) {
        if (tool.startsWith("mcp__")) {
            const parts = tool.split("__");
            if (parts.length >= 3) {
                servers.add(parts[1]); // parts[1] is server name
            }
        }
    }
    return Array.from(servers);
}

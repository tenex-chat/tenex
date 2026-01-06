import type { AISdkTool, ToolContext } from "@/tools/types";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import type { NDKFilter } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";
// Define the input schema
const mcpDiscoverSchema = z.object({
    searchText: z.string().nullable().describe("Text to search for in tool name/description"),
    limit: z.coerce.number().default(50).describe("Maximum number of tools to return"),
});

type McpDiscoverInput = z.infer<typeof mcpDiscoverSchema>;
type McpDiscoverOutput = {
    markdown: string;
    toolsFound: number;
};

// Core implementation - extracted from existing execute function
async function executeMcpDiscover(
    input: McpDiscoverInput,
    _context: ToolContext
): Promise<McpDiscoverOutput> {
    const { searchText, limit = 50 } = input;
    const ndk = getNDK();

    // Build filter for kind:4200 (NDKMCPTool)
    const filter: NDKFilter = {
        kinds: NDKMCPTool.kinds,
    };

    logger.debug("Discovering NDKMCPTool events", { filter });

    // Fetch events from network
    const events = await ndk.fetchEvents(filter, {
        closeOnEose: true,
        groupable: false,
    });

    logger.info(`Found ${events.size} NDKMCPTool events`);

    // Convert to NDKMCPTool instances and extract metadata
    const discoveredTools: Array<{
        id: string;
        name: string;
        description?: string;
        command?: string;
        image?: string;
        slug: string;
        authorPubkey: string;
        createdAt?: number;
    }> = [];

    for (const event of Array.from(events)) {
        const mcpTool = NDKMCPTool.from(event);

        // Get bech32 encoded ID
        const bech32Id = mcpTool.encode();

        const discovered = {
            id: bech32Id,
            name: mcpTool.name || "Unnamed Tool",
            description: mcpTool.description,
            command: mcpTool.command,
            image: mcpTool.image,
            slug: mcpTool.slug,
            authorPubkey: mcpTool.pubkey,
            createdAt: mcpTool.created_at,
        };

        discoveredTools.push(discovered);
    }

    // Apply local filtering if specified
    let filtered = discoveredTools;

    if (searchText) {
        const searchLower = searchText.toLowerCase();
        filtered = discoveredTools.filter((tool) => {
            const searchableText = [tool.name, tool.description || "", tool.command || ""]
                .join(" ")
                .toLowerCase();

            return searchableText.includes(searchLower);
        });
    }

    // Sort by creation time (newest first)
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Limit results
    if (limit && filtered.length > limit) {
        filtered = filtered.slice(0, limit);
    }

    logger.info(`Returning ${filtered.length} MCP tools after filtering`);

    // Format as markdown
    const markdown = formatToolsAsMarkdown(filtered);

    return {
        markdown,
        toolsFound: filtered.length,
    };
}

// AI SDK tool factory
export function createMcpDiscoverTool(context: ToolContext): AISdkTool {
    return tool({
        description:
            "Discover MCP tool definitions from the Nostr network that can be installed and used to extend your capabilities",
        inputSchema: mcpDiscoverSchema,
        execute: async (input: McpDiscoverInput) => {
            return await executeMcpDiscover(input, context);
        },
    }) as AISdkTool;
}

/**
 * Format discovered tools as markdown
 */
function formatToolsAsMarkdown(
    tools: Array<{
        id: string;
        name: string;
        description?: string;
        command?: string;
        image?: string;
        slug: string;
        authorPubkey: string;
        createdAt?: number;
    }>
): string {
    if (tools.length === 0) {
        return "## No MCP tools found\n\nNo tools match your search criteria. Try broadening your search or check back later.";
    }

    const lines: string[] = [];
    lines.push("# MCP Tool Discovery Results");
    lines.push(`\nFound **${tools.length}** available tool${tools.length === 1 ? "" : "s"}:\n`);

    for (const [index, tool] of tools.entries()) {
        lines.push(`## ${index + 1}. ${tool.name}`);
        lines.push(`nostr:${tool.id}`);
        lines.push("");

        lines.push("---");
        lines.push("");
    }

    return lines.join("\n");
}

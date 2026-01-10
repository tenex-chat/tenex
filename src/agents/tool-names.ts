import type { ToolName } from "@/tools/types";
import { DELEGATE_TOOLS } from "./constants";

export type McpToolNameParts = {
    serverName: string;
    toolName: string;
};

export function parseMcpToolName(toolName: string): McpToolNameParts | null {
    if (!toolName.startsWith("mcp__")) {
        return null;
    }

    const parts = toolName.split("__");
    if (parts.length < 3) {
        return null;
    }

    const serverName = parts[1];
    const parsedToolName = parts.slice(2).join("__");

    if (!serverName || !parsedToolName) {
        return null;
    }

    return { serverName, toolName: parsedToolName };
}

export function unwrapMcpToolName(toolName: string): string {
    const parsed = parseMcpToolName(toolName);
    return parsed ? parsed.toolName : toolName;
}

export function formatMcpToolName(toolName: string): string {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
        return toolName;
    }

    return `${parsed.serverName}'s ${parsed.toolName.replace(/_/g, " ")}`;
}

export function isDelegateToolName(toolName: string): boolean {
    const baseName = unwrapMcpToolName(toolName);
    return DELEGATE_TOOLS.includes(baseName as ToolName);
}

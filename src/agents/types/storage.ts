import type { MCPServerConfig } from "@/llm/providers/types";

/**
 * Agent data stored in JSON files (.tenex/agents/*.json).
 */
export interface StoredAgentData {
    name: string;
    role: string;
    description?: string;
    instructions?: string;
    useCriteria?: string;
    llmConfig?: string;
    tools?: string[];
    /** Agent-specific MCP server configurations */
    mcpServers?: Record<string, MCPServerConfig>;
}

/**
 * Agent configuration including sensitive data from the registry.
 */
export interface AgentConfig extends StoredAgentData {
    nsec: string;
    eventId?: string;
    pubkey?: string;
}

/**
 * Agent configuration used during creation flows where nsec may be provided later.
 */
export interface AgentConfigOptionalNsec extends StoredAgentData {
    nsec?: string;
    eventId?: string;
    pubkey?: string;
}

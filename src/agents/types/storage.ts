import type { MCPServerConfig } from "@/llm/providers/types";

/**
 * Project-scoped configuration for an agent.
 *
 * This structure holds configuration that can vary per-project for a single agent.
 * When an agent is configured via kind 24020 events with an a-tag (project reference),
 * the configuration is stored here rather than in the global agent fields.
 *
 * ## Resolution Priority
 * When resolving configuration for an agent in a specific project:
 * 1. Check projectConfigs[projectDTag] for project-scoped values
 * 2. Fall back to global values (llmConfig, tools, isPM)
 *
 * ## Example
 * An agent might have:
 * - Global llmConfig: "anthropic:claude-sonnet-4" (default for all projects)
 * - projectConfigs["project-a"].llmConfig: "anthropic:claude-opus-4" (override for project-a)
 */
export interface ProjectScopedConfig {
    /**
     * Project-scoped LLM configuration.
     * When set, overrides the global llmConfig for this project.
     */
    llmConfig?: string;

    /**
     * Project-scoped tools list.
     * When set (non-empty), overrides the global tools for this project.
     *
     * **Note:** Empty arrays are NOT stored. If you want to clear project-specific tools
     * and fall back to global tools, set this to undefined. There is currently no way
     * to specify "no tools at all" for a project - the minimum is core tools which are
     * always added during tool normalization in agent-loader.
     */
    tools?: string[];

    /**
     * Project-scoped PM designation.
     * When true, this agent is designated as PM for this specific project.
     */
    isPM?: boolean;
}

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

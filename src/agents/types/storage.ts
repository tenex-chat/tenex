import type { MCPServerConfig } from "@/llm/providers/types";

/**
 * Default agent configuration block.
 * Stored under the `default` key in agent JSON files.
 * A 24020 event with no a-tag writes to this block.
 */
export interface AgentDefaultConfig {
    /** Default LLM model configuration string (e.g., "anthropic:claude-sonnet-4") */
    model?: string;
    /** Default tools list for this agent */
    tools?: string[];
}

/**
 * Per-project configuration override block.
 * Stored under `projectOverrides[projectDTag]` in agent JSON files.
 * A 24020 event with an a-tag writes to this block.
 *
 * Tools can use delta syntax:
 * - "+tool" adds a tool on top of defaults
 * - "-tool" removes a tool from defaults
 * - Plain "tool" (no prefix) = full replacement list
 */
export interface AgentProjectConfig {
    /** Project-specific model override (when set, overrides default.model) */
    model?: string;
    /**
     * Project-specific tools.
     * Can be a full replacement list or a delta (using +/- prefix).
     * If any entry has +/- prefix, treated as delta applied to default tools.
     * Empty array or undefined means: use defaults.
     */
    tools?: string[];
    /**
     * Project-scoped PM designation.
     * When true, this agent is designated as PM for this specific project.
     * Set via kind 24020 event with ["pm"] tag and an a-tag.
     */
    isPM?: boolean;
}

/**
 * Project-scoped configuration for an agent (legacy schema).
 * Used by agents written before the new `default`/`projectOverrides` schema.
 *
 * @deprecated Prefer `AgentProjectConfig` with `projectOverrides` field.
 */
export interface ProjectScopedConfig {
    /** Project-scoped LLM configuration string. */
    llmConfig?: string;
    /** Project-scoped tools list. */
    tools?: string[];
    /** Project-scoped PM designation. */
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
    /** Agent-specific MCP server configurations */
    mcpServers?: Record<string, MCPServerConfig>;

    /**
     * Legacy top-level LLM config field.
     * @deprecated Use `default.model` instead.
     */
    llmConfig?: string;

    /**
     * Legacy top-level tools field.
     * @deprecated Use `default.tools` instead.
     */
    tools?: string[];

    /**
     * Default configuration block.
     * Written by kind 24020 events WITHOUT an a-tag.
     * Fields here are the global fallback when no project-specific override exists.
     */
    default?: AgentDefaultConfig;

    /**
     * Per-project configuration overrides.
     * Key is project dTag, value is the project-specific delta override.
     * Written by kind 24020 events WITH an a-tag.
     *
     * Tools stored here use delta syntax ("+tool" / "-tool") or full replacement.
     * See ConfigResolver for resolution logic.
     */
    projectOverrides?: Record<string, AgentProjectConfig>;

    /**
     * Legacy project-scoped configurations (old schema).
     * @deprecated Use `projectOverrides` instead.
     */
    projectConfigs?: Record<string, ProjectScopedConfig>;
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

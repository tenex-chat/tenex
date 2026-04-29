import type { MCPServerConfig } from "@/llm/providers/types";
import type { AgentCategory } from "@/agents/role-categories";

export interface TelegramAgentConfig {
    /** Bot API token for this agent's Telegram bot */
    botToken: string;
    /** Allow direct messages to this bot from globally authorized identities */
    allowDMs?: boolean;
    /** Optional API base URL override for tests or self-hosted gateways */
    apiBaseUrl?: string;
    /** Whether to publish reasoning/thinking blocks to Telegram. Default: false */
    publishReasoningToTelegram?: boolean;
    /** Whether to publish intermediate conversation() events to Telegram. Default: false (only complete() is published) */
    publishConversationToTelegram?: boolean;
}

/**
 * Default agent configuration block.
 * Stored under the `default` key in agent JSON files.
 * A 24020 event with no a-tag writes to this block.
 */
export interface AgentDefaultConfig {
    /** Default LLM model configuration string (e.g., "anthropic:claude-sonnet-4") */
    model?: string;
    /** Configurable tool names explicitly enabled for this agent. */
    tools?: string[];
    /** Skill IDs disabled for this agent. */
    blockedSkills?: string[];
    /** Skill IDs that are always active for this agent across all conversations. Local skill directory IDs are authoritative. */
    skills?: string[];
    /** Project MCP server slugs this agent can access. */
    mcp?: string[];
}

/**
 * Agent data stored in JSON files (.tenex/agents/*.json).
 */
export interface StoredAgentData {
    name: string;
    role: string;
    /**
     * Agent category for semantic classification.
     * Valid values: "principal", "orchestrator", "worker", "reviewer", "domain-expert", "generalist".
     * Legacy values ("executor", "expert", "advisor", "creator", "assistant") are auto-migrated.
     * When missing or unrecognized, remains undefined.
     */
    category?: AgentCategory;
    /**
     * Auto-inferred category written by the categorization service.
     * Kept separate from `category` so explicit provenance is preserved.
     */
    inferredCategory?: AgentCategory;
    description?: string;
    instructions?: string;
    useCriteria?: string;
    /** Agent-specific MCP server configurations */
    mcpServers?: Record<string, MCPServerConfig>;

    /**
     * Default configuration block.
     * Written by kind 24020 events WITHOUT an a-tag.
     * Fields here are the global defaults.
     */
    default?: AgentDefaultConfig;

    /** Global project-manager designation from kind 24020 config snapshots. */
    isPM?: boolean;

    /** Telegram transport configuration for this agent. One bot per agent. */
    telegram?: TelegramAgentConfig;
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

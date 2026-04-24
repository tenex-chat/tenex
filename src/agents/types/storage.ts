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
    /** Default tools list for this agent */
    tools?: string[];
    /** Skill IDs that are always active for this agent across all conversations. Local skill directory IDs are authoritative. */
    skills?: string[];
    /** Skill IDs that are blocked from activation for this agent. */
    blockedSkills?: string[];
    /** MCP server slugs (from mcp.json) this agent can access. */
    mcpAccess?: string[];
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
     * The d-tag of the source agent definition event (kind:4199).
     * Used to detect when a newer version of the same definition is published.
     */
    definitionDTag?: string;

    /**
     * The pubkey of the author of the source agent definition event.
     * Used to verify that incoming definition updates come from the original
     * or whitelisted author.
     */
    definitionAuthor?: string;

    /**
     * The `created_at` timestamp of the source agent definition event.
     * Used to ensure only strictly newer definition events trigger upgrades,
     * preventing rollbacks from older events arriving out of order.
     */
    definitionCreatedAt?: number;

    /**
     * Default configuration block.
     * Written by kind 24020 events WITHOUT an a-tag.
     * Fields here are the global fallback when no project-specific override exists.
     */
    default?: AgentDefaultConfig;

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

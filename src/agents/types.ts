import type { Tool } from "@/tools/types";
import type { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Simplified agent representation for UI display and selection
 */
export interface AgentSummary {
    /** Display name of the agent */
    name: string;
    /** Primary role/function of the agent */
    role: string;
    /** Nostr public key for agent identity */
    pubkey: string;
}

/**
 * Complete agent configuration and identity
 */
export interface AgentInstance {
    /** Display name of the agent */
    name: string;
    /** Nostr public key for agent identity */
    pubkey: string;
    /** Cryptographic signer for Nostr events */
    signer: NDKPrivateKeySigner;
    /** Primary role/function of the agent */
    role: string;
    /** Agent description from NDKAgentDefinition event */
    description?: string;
    /** System instructions that guide agent behavior */
    instructions?: string;
    /** Criteria for when this agent should be selected by orchestrator */
    useCriteria?: string;
    /** LLM configuration identifier */
    llmConfig: string;
    /** Tool instances available to this agent */
    tools: Tool[];
    /** Whether this agent has access to MCP tools (defaults to true except for orchestrator) */
    mcp?: boolean;
    /** NDKAgentDefinition event ID for persisted configuration */
    eventId?: string;
    /** Agent slug/key from agents.json configuration */
    slug: string;
    /** Whether this is a built-in agent (executor, planner, project-manager) */
    isBuiltIn?: boolean;
    /** Whether this agent is from the global configuration */
    isGlobal?: boolean;
}

/**
 * Arguments passed to tool functions during execution
 */
export interface ToolCallArguments {
    /** Shell command to execute (for shell tools) */
    command?: string;
    /** File system path (for file tools) */
    path?: string;
    /** Operation mode (for claude_code tool) */
    mode?: string;
    /** User prompt or query (for claude_code tool) */
    prompt?: string;

    /** Allow additional tool-specific arguments */
    [key: string]: string | number | boolean | undefined;
}

/**
 * Represents a tool invocation request
 */
export interface ToolCall {
    /** Name/identifier of the tool to call */
    tool: string;
    /** Arguments to pass to the tool */
    args: ToolCallArguments;
    /** Optional unique identifier for tracking */
    id?: string;
}

/**
 * Configuration load options
 */
export interface ConfigurationLoadOptions {
    skipGlobal?: boolean;
}

/**
 * Agent data stored in JSON files (.tenex/agents/*.json)
 */
export interface StoredAgentData {
    name: string;
    role: string;
    description?: string;
    instructions?: string;
    useCriteria?: string;
    llmConfig?: string;
    tools?: string[]; // Tool names in storage - converted to Tool instances at runtime
    mcp?: boolean; // Whether this agent has access to MCP tools
}

/**
 * Agent configuration including sensitive data from registry
 */
export interface AgentConfig extends StoredAgentData {
    nsec: string; // Private key from agents.json registry
    eventId?: string; // NDKAgentDefinition event ID if created from Nostr event
    pubkey?: string; // Public key derived from nsec
}

/**
 * Agent config for creation with optional nsec
 */
export interface AgentConfigOptionalNsec extends StoredAgentData {
    nsec?: string; // Optional during creation
    eventId?: string;
    pubkey?: string;
}

/**
 * Agent configuration for orchestration system
 */
export interface AgentConfiguration {
    name: string;
    nsec: string;
    eventId?: string;
    role?: string;
}

/**
 * Project agents configuration
 */
export interface ProjectAgentsConfig {
    agents: Record<string, AgentConfiguration>;
}

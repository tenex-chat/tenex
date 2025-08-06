import type { Tool } from "@/tools/types";
import type { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export interface AgentSummary {
    name: string;
    role: string;
    pubkey: string;
}

export interface Agent {
    name: string;
    pubkey: string;
    signer: NDKPrivateKeySigner;
    role: string;
    description?: string; // Agent description from NDKAgent event
    instructions?: string;
    useCriteria?: string; // Criteria for when this agent should be selected
    llmConfig: string;
    tools: Tool[]; // Actual tool instances
    mcp?: boolean; // Whether this agent has access to MCP tools (defaults to true except for orchestrator)
    eventId?: string; // NDKAgent event ID
    slug: string; // Agent slug/key from agents.json
    isOrchestrator?: boolean; // Whether this agent is the orchestrator agent
    isBuiltIn?: boolean; // Whether this is a built-in agent (executor, planner)
    backend?: "reason-act-loop" | "claude" | "routing"; // Execution backend to use (defaults to 'reason-act-loop')
}

export interface ToolCallArguments {
    // Common tool arguments
    command?: string; // For shell tools
    path?: string; // For file tools
    mode?: string; // For claude_code tool
    prompt?: string; // For claude_code tool

    // Allow other tool arguments
    [key: string]: string | number | boolean | undefined;
}

export interface ToolCall {
    tool: string;
    args: ToolCallArguments;
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
    backend?: "reason-act-loop" | "claude" | "routing"; // Execution backend to use (defaults to 'reason-act-loop')
}

/**
 * Agent configuration including sensitive data from registry
 */
export interface AgentConfig extends StoredAgentData {
    nsec: string; // Private key from agents.json registry
    eventId?: string; // NDKAgent event ID if created from Nostr event
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

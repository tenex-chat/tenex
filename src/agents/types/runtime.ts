import type { AgentMetadataStore } from "@/services/agents";
import type { TelegramAgentConfig } from "./storage";
import type { LLMService } from "@/llm/service";
import type { MCPConfig, MCPServerConfig } from "@/llm/providers/types";
import type { OnStreamStartCallback } from "@/llm/types";
import type { AgentCategory } from "@/agents/role-categories";
import type { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { Tool as CoreTool } from "ai";

/**
 * Simplified agent representation for UI display and selection.
 */
export interface AgentSummary {
    name: string;
    role: string;
    pubkey: string;
}

/**
 * Complete agent configuration and identity used during execution.
 */
export interface AgentInstance {
    name: string;
    pubkey: string;
    signer: NDKPrivateKeySigner;
    role: string;
    /**
     * Agent category for semantic classification and capability policy.
     * Resolved from the agent definition's category or inferredCategory field.
     * Drives tool assignment: domain-experts receive only `ask`, no delegation tools.
     */
    category?: AgentCategory;
    description?: string;
    instructions?: string;
    customInstructions?: string; // Custom system prompt instructions
    useCriteria?: string;
    llmConfig: string;
    tools: string[];
    eventId?: string;
    slug: string;
    useAISDKAgent?: boolean; // Feature flag: use AI SDK Agent class instead of traditional AgentExecutor
    maxAgentSteps?: number; // Maximum steps for AI SDK Agent agentic loop (default: 10)
    /** Agent-specific MCP server configurations */
    mcpServers?: Record<string, MCPServerConfig>;
    /**
     * Global PM designation flag.
     * When true, this agent is designated as PM for ALL projects where it exists.
     * Set via kind 24020 TenexAgentConfigUpdate event with ["pm"] tag (without a-tag).
     * Takes precedence over project tag designations.
     */
    isPM?: boolean;
    /** Telegram transport configuration for this agent */
    telegram?: TelegramAgentConfig;
    /** Skill IDs always active for this agent in the current project context (from resolved agent config, not conversation state). */
    alwaysSkills?: string[];
    /** Skill IDs blocked from activation for this agent (resolved union of default + project config). */
    blockedSkills?: string[];
    /** MCP server slugs this agent can access (resolved from agent config). */
    mcpAccess: string[];
    createMetadataStore(conversationId: string): AgentMetadataStore;
    createLLMService(options?: {
        tools?: Record<string, CoreTool>;
        workingDirectory?: string;
        /** MCP configuration to pass to the provider */
        mcpConfig?: MCPConfig;
        /** Conversation ID for OpenRouter correlation */
        conversationId?: string;
        /**
         * Override the config name to use (for meta model resolution).
         * If provided, uses this config instead of the agent's llmConfig.
         */
        resolvedConfigName?: string;
        /** Callback invoked when an agent stream exposes a message injector */
        onStreamStart?: OnStreamStartCallback;
    }): LLMService;
    sign(event: NDKEvent): Promise<void>;
}
